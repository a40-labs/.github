// Post one message to Slack as the A40 app's bot, and the two GitHub Actions writes every
// poster needs (a step output, the job summary). Zero dependencies, Node 20.
//
//   postMessage({ token, channel, text, blocks }) -> { channel, ts, warning }
//
// chat.postMessage answers HTTP 200 for most refusals ({"ok": false, "error": ...}), so a post
// counts only when the body says `ok: true`; anything else throws a SlackError naming Slack's
// `error` and `warning`. The token is never printed: every message that leaves this module has
// it redacted, whatever Slack or the network echoed back.
//
// CLI (used by .github/workflows/slack-post.yml):
//   SLACK_BOT_TOKEN=xoxb-... node slack.mjs --channel C0123 --payload-file payload.json
//   SLACK_BOT_TOKEN=xoxb-... SLACK_PAYLOAD_JSON='{"text": "...", "blocks": [...]}' node slack.mjs --channel C0123
// The payload holds `text` (the notification and accessibility fallback) and optionally `blocks`.
// Image blocks may name a PNG with `local_file`; --images-dir supplies the directory to upload.
// Without a token it posts nothing, writes the payload to the job summary, and exits 0.

import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
export const TOKEN_SECRET = 'A40_SLACK_BOT_TOKEN';
export const NO_TOKEN_NOTICE = `${TOKEN_SECRET} not set: not posted`;
export const CHANNEL = /^[CGD][A-Z0-9]{2,}$/;

export class SlackError extends Error {}

/** `text` with every occurrence of `secret` replaced, so no message can carry the token. */
export function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(secret).join('[redacted]') : s;
}

/** The chat.postMessage body: what a post sends, and what a dry run shows. */
export function messageBody({ channel, text, blocks }) {
  const message = { channel, text };
  if (blocks) message.blocks = blocks;
  return { ...message, unfurl_links: false, unfurl_media: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOCAL_IMAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.png$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const isLocalImage = (block) => block?.type === 'image' && Object.hasOwn(block, 'local_file');

/** Upload API calls use forms; response bodies and network errors may contain a signed URL. */
async function uploadApi({ token, method, fields, send, wait }) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await send(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(fields).toString(),
      });
    } catch {
      throw new SlackError(`${method}: request failed`);
    }
    if (res.status === 429 && attempt === 0) {
      const seconds = Math.min(Math.max(Number(res.headers?.get?.('retry-after')) || 1, 1), 30);
      await wait(seconds * 1000);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new SlackError(`${method}: HTTP ${res.status}`);
    let data;
    try { data = JSON.parse(await res.text()); } catch {
      throw new SlackError(`${method}: the body is not JSON`);
    }
    if (data?.ok !== true) {
      // Keep Slack's error code, but never echo arbitrary response text (including upload URLs).
      const code = typeof data?.error === 'string' && /^[a-z][a-z0-9_]*$/.test(data.error) ? data.error : 'no error given';
      throw new SlackError(`${method} refused: ${code}`);
    }
    return data;
  }
}

/** Replace local images in order, leaving other blocks untouched and dropping failed images. */
export async function resolveImages({ token, blocks, dir, fetch: send = globalThis.fetch, log = console.log, wait = sleep }) {
  if (!blocks) return blocks;
  const resolved = [];
  for (const block of blocks) {
    if (!isLocalImage(block)) { resolved.push(block); continue; }
    const name = block.local_file;
    let uploadUrl;
    try {
      if (!dir) throw new SlackError('no --images-dir');
      if (typeof name !== 'string' || !LOCAL_IMAGE_NAME.test(name) || name.includes('..')) throw new SlackError('bad image name');
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new SlackError('not a regular file');
      if (stat.size > MAX_IMAGE_BYTES) throw new SlackError('file exceeds 5 MB');
      const bytes = readFileSync(file);
      if (bytes.length > MAX_IMAGE_BYTES) throw new SlackError('file exceeds 5 MB');
      const got = await uploadApi({ token, method: 'files.getUploadURLExternal', fields: { filename: name, length: String(bytes.length) }, send, wait });
      uploadUrl = got.upload_url;
      let url;
      try { url = new URL(uploadUrl); } catch { throw new SlackError('invalid upload URL'); }
      if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password || url.port) {
        throw new SlackError('refused upload URL: expected https://files.slack.com');
      }
      if (typeof got.file_id !== 'string' || !got.file_id) throw new SlackError('no file_id in upload response');
      let uploaded;
      try {
        uploaded = await send(uploadUrl, {
          method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
        });
      } catch { throw new SlackError('upload POST: request failed'); }
      if (uploaded.status < 200 || uploaded.status >= 300) throw new SlackError(`upload POST: HTTP ${uploaded.status}`);
      const title = String(block.title?.text ?? block.alt_text ?? '').slice(0, 250);
      await uploadApi({ token, method: 'files.completeUploadExternal', fields: { files: JSON.stringify([{ id: got.file_id, title }]) }, send, wait });
      const { local_file, image_url, ...image } = block;
      resolved.push({ ...image, slack_file: { id: got.file_id } });
    } catch (e) {
      const reason = e instanceof SlackError ? e.message : e.code === 'ENOENT' ? 'file is missing' : 'file could not be read';
      log(redact(redact(`image ${JSON.stringify(name)} dropped: ${reason}`, uploadUrl), token));
    }
  }
  return resolved;
}

/**
 * chat.postMessage. Throws a SlackError on a network failure, a non-2xx answer, a body that is not
 * JSON, or `ok` other than true. One retry on HTTP 429, after Slack's Retry-After (at most 30 s).
 */
export async function postMessage({
  token, channel, text, blocks, fetch: send = globalThis.fetch, url = POST_MESSAGE_URL, log = console.log, retries = 1, wait = sleep,
}) {
  if (!token) throw new SlackError('no Slack bot token');
  if (!channel || !CHANNEL.test(channel)) throw new SlackError(`not a Slack channel id: ${JSON.stringify(channel)}`);
  if (typeof text !== 'string' || !text) throw new SlackError('a message needs its text fallback');
  const body = JSON.stringify(messageBody({ channel, text, blocks }));
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await send(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body,
      });
    } catch (e) {
      throw new SlackError(redact(`chat.postMessage: the request failed (${e && e.message})`, token));
    }
    if (res.status === 429 && attempt < retries) {
      const seconds = Math.min(Math.max(Number(res.headers?.get?.('retry-after')) || 1, 1), 30);
      log(`chat.postMessage: rate limited, retrying in ${seconds}s`);
      await wait(seconds * 1000);
      continue;
    }
    const raw = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new SlackError(redact(`chat.postMessage: HTTP ${res.status} ${raw.slice(0, 300)}`.trim(), token));
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new SlackError(redact(`chat.postMessage: HTTP ${res.status}, and the body is not JSON: ${raw.slice(0, 300)}`, token));
    }
    if (data.warning) log(redact(`chat.postMessage warning: ${data.warning}`, token));
    if (data.ok !== true) {
      const details = data.response_metadata?.messages?.length ? ` ${data.response_metadata.messages.join('; ')}` : '';
      const warning = data.warning ? ` (warning: ${data.warning})` : '';
      const error = new SlackError(redact(`chat.postMessage refused: ${data.error || 'no error given'}${warning}${details}`, token));
      error.code = data.error;
      throw error;
    }
    return { channel: data.channel, ts: data.ts, warning: data.warning || null };
  }
}

/** One step output (`$GITHUB_OUTPUT`); a no-op outside Actions. */
export function setOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\n/g, ' ')}\n`);
}

/** Markdown appended to the job summary (`$GITHUB_STEP_SUMMARY`); a no-op outside Actions. */
export function appendSummary(markdown, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown.replace(/\n*$/, '')}\n\n`);
}

/** A fenced block that no line of `text` can close early. */
export function fence(text, lang = '') {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${String(text).replace(/\n$/, '')}\n${ticks}`;
}

/** Where a post went, for the log, the job summary and the `slack_ts` output. */
export function reportPosted({ channel, ts }, env = process.env, log = console.log) {
  log(`posted to ${channel}, ts ${ts}`);
  setOutput('slack_channel', channel, env);
  setOutput('slack_ts', ts, env);
  appendSummary(`Posted to Slack channel \`${channel}\`, message ts \`${ts}\`.`, env);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--channel' || a === '--payload-file' || a === '--images-dir') { args[a.slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The slack-post.yml entry point. Returns the exit code. */
export async function main(argv = process.argv.slice(2), env = process.env, { fetch: send = globalThis.fetch, log = console.log, wait = sleep } = {}) {
  const args = parseArgs(argv);
  const raw = args['payload-file'] ? readFileSync(args['payload-file'], 'utf8') : env.SLACK_PAYLOAD_JSON;
  if (!raw) throw new Error('no payload: pass --payload-file or set SLACK_PAYLOAD_JSON');
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { throw new Error(`the payload is not JSON: ${e.message}`); }
  if (!payload || typeof payload.text !== 'string' || !payload.text) throw new Error('the payload needs a non-empty "text"');
  if (payload.blocks !== undefined && !Array.isArray(payload.blocks)) throw new Error('"blocks" must be a list');
  const channel = args.channel || env.SLACK_CHANNEL;
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    log(`::notice::${NO_TOKEN_NOTICE}`);
    appendSummary(`### ${NO_TOKEN_NOTICE}\n\nChannel \`${channel}\`. The payload:\n\n${fence(JSON.stringify(payload, null, 2), 'json')}`, env);
    return 0;
  }
  let blocks = await resolveImages({ token, blocks: payload.blocks, dir: args['images-dir'], fetch: send, log, wait });
  // Only successful uploads replace a block; existing remote images do not enable retries.
  const hasUploadedImages = blocks?.some((block) => block?.type === 'image' && !payload.blocks.includes(block));
  const delays = [2000, 4000, 8000];
  let posted;
  for (let attempt = 0; ; attempt += 1) {
    try {
      posted = await postMessage({ token, channel, text: payload.text, blocks, fetch: send, log, wait });
      break;
    } catch (e) {
      if (!hasUploadedImages || e.code !== 'invalid_blocks' || attempt > delays.length) throw e;
      if (attempt < delays.length) await wait(delays[attempt]);
      else {
        log('::warning::chat.postMessage refused: invalid_blocks; posting without image blocks');
        blocks = blocks.filter((block) => block?.type !== 'image');
      }
    }
  }
  reportPosted(posted, env, log);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`::error::${redact(e.message, process.env.SLACK_BOT_TOKEN)}`);
    process.exitCode = 1;
  });
}

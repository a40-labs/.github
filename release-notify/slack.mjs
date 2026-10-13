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
// Without a token it posts nothing, writes the payload to the job summary, and exits 0.

import { appendFileSync, readFileSync } from 'node:fs';
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
      throw new SlackError(redact(`chat.postMessage refused: ${data.error || 'no error given'}${warning}${details}`, token));
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
    if (a === '--channel' || a === '--payload-file') { args[a.slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The slack-post.yml entry point. Returns the exit code. */
export async function main(argv = process.argv.slice(2), env = process.env, { fetch: send = globalThis.fetch, log = console.log } = {}) {
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
  const posted = await postMessage({ token, channel, text: payload.text, blocks: payload.blocks, fetch: send, log });
  reportPosted(posted, env, log);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`::error::${redact(e.message, process.env.SLACK_BOT_TOKEN)}`);
    process.exitCode = 1;
  });
}

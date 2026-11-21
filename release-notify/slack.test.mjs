// node --test release-notify/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_TOKEN_NOTICE, SlackError, fence, main, messageBody, postMessage, resolveImages } from './slack.mjs';

const TOKEN = 'xoxb-1111-2222-secretvalue';
const UPLOAD_URL = 'https://files.slack.com/upload/v1/presigned-secret';
const OTHER_UPLOAD_URL = 'https://other.example/upload/presigned-secret';
function captureLogs() {
  const logged = [];
  return { logged, log: (line) => {
    for (const secret of [TOKEN, UPLOAD_URL, OTHER_UPLOAD_URL]) assert.ok(!String(line).includes(secret), 'a log leaked a secret');
    logged.push(String(line));
  } };
}
const answer = (status, body, headers = {}) => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

/** A fetch that answers from `replies` in turn and records every request. */
function slack(...replies) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, requests };
}

const message = { token: TOKEN, channel: 'C02DEV2BWRZ', text: 'fallback', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }] };

test('ok: posts chat.postMessage as the bot and returns the channel and ts', async () => {
  const s = slack(answer(200, { ok: true, channel: 'C02DEV2BWRZ', ts: '1760000000.000100' }));
  const posted = await postMessage({ ...message, fetch: s.fetch, log: () => {} });
  assert.deepEqual(posted, { channel: 'C02DEV2BWRZ', ts: '1760000000.000100', warning: null });
  assert.equal(s.requests.length, 1);
  const { url, init } = s.requests[0];
  assert.equal(url, 'https://slack.com/api/chat.postMessage');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(init.body), {
    channel: 'C02DEV2BWRZ', text: 'fallback', blocks: message.blocks, unfurl_links: false, unfurl_media: false,
  });
  assert.ok(!init.body.includes(TOKEN), 'the token travels in the header only');
});

test('ok: false fails, naming Slack\'s error and warning', async () => {
  const s = slack(answer(200, { ok: false, error: 'invalid_blocks', warning: 'missing_charset', response_metadata: { messages: ['[ERROR] must be less than 3001 characters'] } }));
  const { logged, log } = captureLogs();
  await assert.rejects(postMessage({ ...message, fetch: s.fetch, log }), (e) => {
    assert.ok(e instanceof SlackError);
    assert.match(e.message, /refused: invalid_blocks \(warning: missing_charset\) \[ERROR\] must be less than 3001 characters/);
    return true;
  });
  assert.deepEqual(logged, ['chat.postMessage warning: missing_charset']);
  // A body without ok, or one that is not JSON, is not a post either.
  await assert.rejects(postMessage({ ...message, fetch: slack(answer(200, {})).fetch, log: () => {} }), /refused: no error given/);
  await assert.rejects(postMessage({ ...message, fetch: slack(answer(200, 'ok')).fetch, log: () => {} }), /not JSON/);
});

test('a non-2xx answer fails, and a 429 is retried once after Retry-After', async () => {
  await assert.rejects(postMessage({ ...message, fetch: slack(answer(500, 'upstream down')).fetch, log: () => {} }), /HTTP 500 upstream down/);
  await assert.rejects(postMessage({ ...message, fetch: slack(answer(404, 'no_service')).fetch, log: () => {} }), /HTTP 404/);
  const waits = [];
  const s = slack(answer(429, '', { 'retry-after': '3' }), answer(200, { ok: true, channel: 'C1', ts: '1.2' }));
  const posted = await postMessage({ ...message, fetch: s.fetch, log: () => {}, wait: async (ms) => { waits.push(ms); } });
  assert.equal(posted.ts, '1.2');
  assert.deepEqual(waits, [3000]);
  const twice = slack(answer(429, ''), answer(429, 'still limited'));
  await assert.rejects(postMessage({ ...message, fetch: twice.fetch, log: () => {}, wait: async () => {} }), /HTTP 429 still limited/);
  assert.equal(twice.requests.length, 2, 'one retry, not more');
});

test('the token is never logged or carried by an error, whatever Slack or the network echoes', async () => {
  const { logged, log } = captureLogs();
  const echoes = [
    answer(200, { ok: false, error: `invalid_auth for ${TOKEN}`, warning: `token ${TOKEN}` }),
    answer(401, `bad token ${TOKEN}`),
    new Error(`connect ECONNREFUSED Authorization: Bearer ${TOKEN}`),
    answer(200, `<html>${TOKEN}</html>`),
  ];
  for (const echo of echoes) {
    await assert.rejects(postMessage({ ...message, fetch: slack(echo).fetch, log }), (e) => {
      assert.ok(!e.message.includes(TOKEN), e.message);
      assert.match(e.message, /\[redacted\]/);
      return true;
    });
  }
  assert.ok(logged.length > 0);
  for (const line of logged) assert.ok(!line.includes(TOKEN), line);
});

test('it refuses to post without a token, a channel id or a text fallback', async () => {
  const s = slack();
  await assert.rejects(postMessage({ ...message, token: '', fetch: s.fetch }), /no Slack bot token/);
  await assert.rejects(postMessage({ ...message, channel: '#dev-product', fetch: s.fetch }), /not a Slack channel id/);
  await assert.rejects(postMessage({ ...message, text: '', fetch: s.fetch }), /text fallback/);
  assert.equal(s.requests.length, 0);
});

function actionsEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-post-'));
  const env = { GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'output'), ...extra };
  writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  writeFileSync(env.GITHUB_OUTPUT, '');
  return env;
}

test('the slack-post CLI: without a token it writes the payload to the summary and exits 0; with one it posts and outputs the ts', async () => {
  const payload = JSON.stringify({ text: 'hello', blocks: message.blocks });
  const quiet = actionsEnv({ SLACK_PAYLOAD_JSON: payload });
  const s = slack(answer(200, { ok: true, channel: 'C02DEV2BWRZ', ts: '9.9' }));
  const { logged, log } = captureLogs();
  assert.equal(await main(['--channel', 'C02DEV2BWRZ'], quiet, { fetch: s.fetch, log }), 0);
  assert.equal(s.requests.length, 0);
  assert.ok(logged.includes(`::notice::${NO_TOKEN_NOTICE}`));
  assert.equal(NO_TOKEN_NOTICE, 'A40_SLACK_BOT_TOKEN not set: not posted');
  assert.match(readFileSync(quiet.GITHUB_STEP_SUMMARY, 'utf8'), /^### A40_SLACK_BOT_TOKEN not set: not posted[\s\S]*"text": "hello"/);

  const live = actionsEnv({ SLACK_PAYLOAD_JSON: payload, SLACK_BOT_TOKEN: TOKEN });
  assert.equal(await main(['--channel', 'C02DEV2BWRZ'], live, { fetch: s.fetch, log: () => {} }), 0);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(JSON.parse(s.requests[0].init.body), messageBody({ channel: 'C02DEV2BWRZ', text: 'hello', blocks: message.blocks }));
  assert.equal(readFileSync(live.GITHUB_OUTPUT, 'utf8'), 'slack_channel=C02DEV2BWRZ\nslack_ts=9.9\n');

  await assert.rejects(main(['--channel', 'C02DEV2BWRZ'], actionsEnv({ SLACK_PAYLOAD_JSON: '{"blocks": []}' }), { log: () => {} }), /non-empty "text"/);
  await assert.rejects(main(['--channel', 'C02DEV2BWRZ'], actionsEnv({ SLACK_PAYLOAD_JSON: 'not json' }), { log: () => {} }), /not JSON/);
  await assert.rejects(main(['--channel', 'C02DEV2BWRZ'], actionsEnv(), { log: () => {} }), /no payload/);
});

test('a fence is never closed early by the text it holds', () => {
  assert.equal(fence('a', 'json'), '```json\na\n```');
  assert.equal(fence('x ```` y'), '`````\nx ```` y\n`````');
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
const localImage = (name = 'chart.png', extra = {}) => ({ type: 'image', local_file: name, alt_text: 'Daily costs', ...extra });
const postedReply = () => answer(200, { ok: true, channel: message.channel, ts: '9.9' });
const uploadReplies = (id = 'F123', url = UPLOAD_URL) => [
  answer(200, { ok: true, upload_url: url, file_id: id }),
  answer(200, 'OK - uploaded'),
  answer(200, { ok: true }),
];
const posterEnv = (blocks) => actionsEnv({
  SLACK_BOT_TOKEN: TOKEN, SLACK_CHANNEL: message.channel, SLACK_PAYLOAD_JSON: JSON.stringify({ text: message.text, blocks }),
});
function imageDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'chart.png'), png);
  return dir;
}

test('local image: uploads bytes privately, then posts a Slack file image using the same token', async (t) => {
  const dir = imageDir(t);
  const image = localImage('chart.png', { title: { type: 'plain_text', text: 'Model costs' } });
  const s = slack(...uploadReplies(), postedReply());
  const { logged, log } = captureLogs();
  assert.equal(await main(['--images-dir', dir], posterEnv([message.blocks[0], image]), { fetch: s.fetch, log }), 0);
  assert.deepEqual(s.requests.map((r) => r.url), [
    'https://slack.com/api/files.getUploadURLExternal', UPLOAD_URL,
    'https://slack.com/api/files.completeUploadExternal', 'https://slack.com/api/chat.postMessage',
  ]);
  const [get, upload, complete, post] = s.requests.map((r) => r.init);
  for (const api of [get, complete]) {
    assert.equal(api.method, 'POST');
    assert.equal(api.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(api.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=utf-8');
  }
  assert.deepEqual(Object.fromEntries(new URLSearchParams(get.body)), { filename: 'chart.png', length: String(png.length) });
  assert.equal(upload.method, 'POST');
  assert.equal(upload.redirect, 'manual');
  assert.deepEqual(upload.headers, { 'Content-Type': 'application/octet-stream' });
  assert.deepEqual(upload.body, png);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(complete.body)), { files: JSON.stringify([{ id: 'F123', title: 'Model costs' }]) });
  assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(post.body), messageBody({
    channel: message.channel, text: message.text,
    blocks: [message.blocks[0], { type: 'image', alt_text: image.alt_text, title: image.title, slack_file: { id: 'F123' } }],
  }));
  assert.ok(!post.body.includes('local_file'));
  assert.deepEqual(logged, [`posted to ${message.channel}, ts 9.9`]);
});

test('two uploaded images stay between their three text sections without mutating the payload', async (t) => {
  const dir = imageDir(t);
  writeFileSync(join(dir, 'gcp.png'), png);
  const sections = ['first', 'middle', 'last'].map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }));
  const blocks = [sections[0], localImage(), sections[1], localImage('gcp.png'), sections[2]];
  const before = structuredClone(blocks);
  const s = slack(...uploadReplies('F1'), ...uploadReplies('F2'));
  const resolved = await resolveImages({ token: TOKEN, blocks, dir, fetch: s.fetch, log: captureLogs().log });
  assert.deepEqual(blocks, before);
  assert.notEqual(resolved, blocks);
  assert.deepEqual(resolved, [sections[0], { type: 'image', alt_text: 'Daily costs', slack_file: { id: 'F1' } }, sections[1], { type: 'image', alt_text: 'Daily costs', slack_file: { id: 'F2' } }, sections[2]]);
  const post = slack(postedReply());
  await postMessage({ ...message, blocks: resolved, fetch: post.fetch, log: captureLogs().log });
  assert.deepEqual(JSON.parse(post.requests[0].init.body).blocks, resolved);
});

test('upload titles use alt text by default and are limited to 250 characters', async (t) => {
  const dir = imageDir(t);
  for (const extra of [{ alt_text: 'a'.repeat(260) }, { title: { text: 't'.repeat(260) } }]) {
    const s = slack(...uploadReplies());
    await resolveImages({ token: TOKEN, blocks: [localImage('chart.png', extra)], dir, fetch: s.fetch, log: captureLogs().log });
    const files = JSON.parse(new URLSearchParams(s.requests[2].init.body).get('files'));
    assert.equal(files[0].title, (extra.title?.text ?? extra.alt_text).slice(0, 250));
  }
});

const dropCases = [
  { name: 'no --images-dir', noDir: true, reason: /no --images-dir/ },
  ...['../x.png', 'x.svg', 'x..png', 'Chart.png', 'chart.png\n', `${'a'.repeat(82)}.png`].map((file) => ({ name: `bad name ${JSON.stringify(file)}`, file, reason: /bad image name/ })),
  { name: 'missing file', file: 'missing.png', reason: /file is missing/ },
  { name: 'oversized file', setup: (dir) => writeFileSync(join(dir, 'chart.png'), Buffer.alloc(5 * 1024 * 1024 + 1)), reason: /exceeds 5 MB/ },
  { name: 'directory', setup: (dir) => mkdirSync(join(dir, 'folder.png')), file: 'folder.png', reason: /not a regular file/ },
  { name: 'symlink', setup: (dir) => symlinkSync(join(dir, 'chart.png'), join(dir, 'link.png')), file: 'link.png', reason: /not a regular file/ },
  { name: 'getUploadURLExternal refused', replies: [answer(200, { ok: false, error: 'not_allowed' })], reason: /files.getUploadURLExternal refused: not_allowed/ },
  { name: 'getUploadURLExternal HTTP failure', replies: [answer(500, `${TOKEN} ${UPLOAD_URL}`)], reason: /files.getUploadURLExternal: HTTP 500/ },
  { name: 'getUploadURLExternal non-JSON', replies: [answer(200, `${TOKEN} ${UPLOAD_URL}`)], reason: /body is not JSON/ },
  { name: 'getUploadURLExternal missing ok', replies: [answer(200, { upload_url: UPLOAD_URL, file_id: 'F123' })], reason: /files.getUploadURLExternal refused/ },
  { name: 'getUploadURLExternal network failure', replies: [new Error(`${TOKEN} ${UPLOAD_URL}`)], reason: /files.getUploadURLExternal: request failed/ },
  ...[['another host', OTHER_UPLOAD_URL], ['HTTP scheme', 'http://files.slack.com/upload'], ['host suffix trick', 'https://files.slack.com.other.example/upload'], ['embedded credentials', 'https://user:password@files.slack.com/upload'], ['custom port', 'https://files.slack.com:444/upload']].map(([label, url]) => ({
    name: `unsafe upload URL: ${label}`, replies: [answer(200, { ok: true, upload_url: url, file_id: 'F123' })], reason: /refused upload URL/,
  })),
  { name: 'malformed upload URL', replies: [answer(200, { ok: true, upload_url: 'bad URL', file_id: 'F123' })], reason: /invalid upload URL/ },
  { name: 'missing file id', replies: [answer(200, { ok: true, upload_url: UPLOAD_URL })], reason: /no file_id/ },
  { name: 'upload POST HTTP failure', replies: [uploadReplies()[0], answer(500, `${TOKEN} ${UPLOAD_URL}`)], reason: /upload POST: HTTP 500/ },
  { name: 'upload POST redirect', replies: [uploadReplies()[0], answer(302, '', { location: OTHER_UPLOAD_URL })], reason: /upload POST: HTTP 302/ },
  { name: 'upload POST network failure', replies: [uploadReplies()[0], new Error(`${TOKEN} ${UPLOAD_URL}`)], reason: /upload POST: request failed/ },
  { name: 'completeUploadExternal refused', replies: [...uploadReplies().slice(0, 2), answer(200, { ok: false, error: 'upload_failed' })], reason: /files.completeUploadExternal refused: upload_failed/ },
  { name: 'completeUploadExternal HTTP failure', replies: [...uploadReplies().slice(0, 2), answer(500, `${TOKEN} ${UPLOAD_URL}`)], reason: /files.completeUploadExternal: HTTP 500/ },
  { name: 'completeUploadExternal missing ok', replies: [...uploadReplies().slice(0, 2), answer(200, {})], reason: /files.completeUploadExternal refused/ },
  { name: 'echoed secrets in refusal', replies: [...uploadReplies().slice(0, 2), answer(200, { ok: false, error: `${TOKEN} ${UPLOAD_URL}` })], reason: /files.completeUploadExternal refused/ },
];
for (const scenario of dropCases) {
  test(`drops an image and posts the rest: ${scenario.name}`, async (t) => {
    const dir = imageDir(t);
    scenario.setup?.(dir);
    const file = scenario.file ?? 'chart.png';
    const s = slack(...(scenario.replies ?? []), postedReply());
    const { logged, log } = captureLogs();
    const waits = [];
    const args = scenario.noDir ? [] : ['--images-dir', dir];
    assert.equal(await main(args, posterEnv([message.blocks[0], localImage(file), message.blocks[0]]), { fetch: s.fetch, log, wait: async (ms) => waits.push(ms) }), 0);
    assert.equal(s.requests.length, (scenario.replies?.length ?? 0) + 1);
    assert.equal(s.requests.at(-1).url, 'https://slack.com/api/chat.postMessage');
    assert.deepEqual(JSON.parse(s.requests.at(-1).init.body).blocks, [message.blocks[0], message.blocks[0]]);
    assert.equal(logged.length, 2, 'one drop log and one successful post log');
    assert.ok(logged[0].includes(JSON.stringify(file)));
    assert.match(logged[0], scenario.reason);
    assert.deepEqual(waits, []);
  });
}

test('invalid_blocks twice retries the same uploaded message after 2 and 4 seconds', async (t) => {
  const dir = imageDir(t);
  const s = slack(...uploadReplies(), answer(200, { ok: false, error: 'invalid_blocks' }), answer(200, { ok: false, error: 'invalid_blocks' }), postedReply());
  const waits = [];
  const { logged, log } = captureLogs();
  assert.equal(await main(['--images-dir', dir], posterEnv([localImage(), message.blocks[0]]), { fetch: s.fetch, log, wait: async (ms) => waits.push(ms) }), 0);
  const posts = s.requests.slice(3);
  assert.equal(posts.length, 3);
  assert.ok(posts.every((post) => post.url === 'https://slack.com/api/chat.postMessage' && post.init.body === posts[0].init.body));
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(logged.length, 1);
});

test('invalid_blocks four times falls back once without any image blocks and exits 0', async (t) => {
  const dir = imageDir(t);
  const remote = { type: 'image', image_url: 'https://example.com/remote.png', alt_text: 'remote' };
  const s = slack(...uploadReplies(), ...Array.from({ length: 4 }, () => answer(200, { ok: false, error: 'invalid_blocks' })), postedReply());
  const waits = [];
  const { logged, log } = captureLogs();
  const env = posterEnv([message.blocks[0], localImage(), remote, message.blocks[0]]);
  assert.equal(await main(['--images-dir', dir], env, { fetch: s.fetch, log, wait: async (ms) => waits.push(ms) }), 0);
  const posts = s.requests.slice(3);
  assert.equal(posts.length, 5);
  assert.ok(posts.slice(0, 4).every((post) => post.init.body === posts[0].init.body));
  assert.deepEqual(JSON.parse(posts[4].init.body), messageBody({ channel: message.channel, text: message.text, blocks: [message.blocks[0], message.blocks[0]] }));
  assert.deepEqual(waits, [2000, 4000, 8000]);
  assert.equal(logged.filter((line) => line.startsWith('::warning::') && line.includes('invalid_blocks')).length, 1);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /slack_ts=9.9\n/);
});

test('an uploaded image does not retry any refusal other than invalid_blocks', async (t) => {
  const dir = imageDir(t);
  const s = slack(...uploadReplies(), answer(200, { ok: false, error: 'channel_not_found' }));
  const waits = [];
  await assert.rejects(main(['--images-dir', dir], posterEnv([localImage()]), { fetch: s.fetch, log: captureLogs().log, wait: async (ms) => waits.push(ms) }), /channel_not_found/);
  assert.equal(s.requests.length, 4);
  assert.deepEqual(waits, []);
});

test('the text fallback is attempted only once and its refusal still throws', async (t) => {
  const dir = imageDir(t);
  const s = slack(...uploadReplies(), ...Array.from({ length: 5 }, () => answer(200, { ok: false, error: 'invalid_blocks' })));
  await assert.rejects(main(['--images-dir', dir], posterEnv([localImage()]), { fetch: s.fetch, log: captureLogs().log, wait: async () => {} }), /invalid_blocks/);
  assert.equal(s.requests.length, 8);
  assert.deepEqual(JSON.parse(s.requests.at(-1).init.body).blocks, []);
});

test('without local images, existing remote images still make exactly one post with no processing retries', async () => {
  const blocks = [message.blocks[0], { type: 'image', slack_file: { id: 'FEXISTING' }, alt_text: 'existing' }];
  const s = slack(answer(200, { ok: false, error: 'invalid_blocks' }));
  const waits = [];
  await assert.rejects(main([], posterEnv(blocks), { fetch: s.fetch, log: captureLogs().log, wait: async (ms) => waits.push(ms) }), /invalid_blocks/);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(JSON.parse(s.requests[0].init.body), messageBody({ channel: message.channel, text: message.text, blocks }));
  assert.deepEqual(waits, []);
});

test('a dropped local image does not enable retries for an existing remote image', async () => {
  const s = slack(answer(200, { ok: false, error: 'invalid_blocks' }));
  await assert.rejects(main([], posterEnv([localImage(), { type: 'image', slack_file: { id: 'FOLD' }, alt_text: 'old' }]), { fetch: s.fetch, log: captureLogs().log, wait: async () => assert.fail('unexpected retry') }), /invalid_blocks/);
  assert.equal(s.requests.length, 1);
});

test('no token: local images stay in the summary unchanged and nothing is uploaded or waited for', async (t) => {
  const dir = imageDir(t);
  const payload = { text: message.text, blocks: [message.blocks[0], localImage()] };
  const env = actionsEnv();
  const payloadFile = join(dir, 'payload.json');
  writeFileSync(payloadFile, JSON.stringify(payload));
  const { logged, log } = captureLogs();
  assert.equal(await main(['--payload-file', payloadFile, '--images-dir', dir, '--channel', message.channel], env, {
    fetch: async () => assert.fail('unexpected upload or post'), log, wait: async () => assert.fail('unexpected wait'),
  }), 0);
  assert.deepEqual(logged, [`::notice::${NO_TOKEN_NOTICE}`]);
  assert.ok(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes(JSON.stringify(payload, null, 2)));
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), '');
});

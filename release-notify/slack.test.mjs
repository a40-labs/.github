// node --test release-notify/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_TOKEN_NOTICE, SlackError, fence, main, messageBody, postMessage } from './slack.mjs';

const TOKEN = 'xoxb-1111-2222-secretvalue';
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
  const logged = [];
  await assert.rejects(postMessage({ ...message, fetch: s.fetch, log: (m) => logged.push(m) }), (e) => {
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
  const logged = [];
  const log = (m) => logged.push(String(m));
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
  const logged = [];
  assert.equal(await main(['--channel', 'C02DEV2BWRZ'], quiet, { fetch: s.fetch, log: (m) => logged.push(m) }), 0);
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

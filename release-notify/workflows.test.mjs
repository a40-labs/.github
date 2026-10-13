// The shared workflows' contract with their callers, read as text (no YAML parser: zero dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (name) => readFileSync(join(root, '.github', 'workflows', name), 'utf8');
/** The text of one `key:` block at `indent`, up to the next key at the same indent. */
const block = (text, key, indent) => {
  const pad = ' '.repeat(indent);
  const start = text.indexOf(`\n${pad}${key}:\n`);
  assert.ok(start >= 0, `no ${key}: at indent ${indent}`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(new RegExp(`\\n${pad}\\S`));
  return end < 0 ? rest : rest.slice(0, end + 2);
};

test('release-notify.yml is called with product, tag, paths, dry_run and channel, and two optional secrets', () => {
  const wf = workflow('release-notify.yml');
  assert.match(wf, /^on:\n {2}workflow_call:\n/m);
  const inputs = block(wf, 'inputs', 4);
  for (const [name, type, required] of [['product', 'string', true], ['tag', 'string', true], ['paths', 'string', false], ['dry_run', 'boolean', false], ['channel', 'string', false]]) {
    const input = block(inputs, name, 6);
    assert.match(input, new RegExp(`required: ${required}\\n`), name);
    assert.match(input, new RegExp(`type: ${type}\\n`), name);
  }
  assert.match(block(inputs, 'channel', 6), /default: C02DEV2BWRZ\n/);
  const secrets = block(wf, 'secrets', 4);
  for (const name of ['slack_bot_token', 'cross_repo_token']) assert.match(block(secrets, name, 6), /required: false\n/, name);
  assert.match(wf, /slack_ts:\n {8}description: [^\n]+\n {8}value: \$\{\{ jobs\.notify\.outputs\.slack_ts \}\}/);
});

test('release-notify.yml runs on a40-runner over the caller\'s full history, with the script from this repository', () => {
  const wf = workflow('release-notify.yml');
  const job = block(wf, 'notify', 2);
  assert.match(job, /\n {4}runs-on: a40-runner\n/);
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {6}issues: read\n/);
  assert.match(job, /- uses: actions\/checkout@v4\n {8}with:\n {10}path: caller\n {10}fetch-depth: 0\n/);
  assert.match(job, /repository: a40-labs\/\.github\n {10}ref: \$\{\{ startsWith\(github\.workflow_ref, 'a40-labs\/\.github\/'\) && github\.workflow_sha \|\| 'main' \}\}/);
  assert.match(job, /node-version: "20"/);
  assert.match(job, /SLACK_BOT_TOKEN: \$\{\{ secrets\.slack_bot_token \}\}/);
  assert.match(job, /CROSS_REPO_TOKEN: \$\{\{ secrets\.cross_repo_token \}\}/);
  assert.match(job, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(job, /working-directory: caller\n/);
  assert.match(job, /node "\$GITHUB_WORKSPACE\/notifier\/release-notify\/notify\.mjs" "\$\{args\[@\]\}"/);
  assert.match(job, /if \[ "\$DRY_RUN" = "true" \]; then args\+=\(--dry-run\); fi/);
});

test('slack-post.yml takes a channel and a payload and posts with the bot token', () => {
  const wf = workflow('slack-post.yml');
  assert.match(wf, /^on:\n {2}workflow_call:\n/m);
  const inputs = block(wf, 'inputs', 4);
  for (const name of ['channel', 'payload_json']) assert.match(block(inputs, name, 6), /required: true\n {8}type: string\n/, name);
  assert.match(block(block(wf, 'secrets', 4), 'slack_bot_token', 6), /required: false\n/);
  const job = block(wf, 'post', 2);
  assert.match(job, /\n {4}runs-on: a40-runner\n/);
  assert.match(job, /SLACK_PAYLOAD_JSON: \$\{\{ inputs\.payload_json \}\}/);
  assert.match(job, /node "\$GITHUB_WORKSPACE\/notifier\/release-notify\/slack\.mjs" --channel "\$CHANNEL"/);
});

test('the tests run on every pull request, on a hosted runner because this repository is public', () => {
  const wf = workflow('test.yml');
  assert.match(wf, /^on:\n {2}pull_request:\n/m);
  assert.match(wf, /runs-on: ubuntu-latest\n/);
  assert.match(wf, /- run: node --test release-notify\/\n/);
});

test('nothing posts through an incoming webhook', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else files.push(path);
    }
  };
  walk(root);
  const webhook = ['DEV_PRODUCT', 'SLACK_WEBHOOK'].join('_');
  const hooks = ['hooks', 'slack', 'com'].join('.');
  for (const file of files.filter((f) => !f.endsWith('workflows.test.mjs'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(webhook) && !text.includes(hooks), file);
  }
});

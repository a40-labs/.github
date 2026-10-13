// node --test release-notify/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CHANNEL, DEPLOY, LIMITS, MAX_LINES, bodyReferences, gather, githubClient, issueTitle, main, parseArgs,
  previousRelease, render, sentence, splitPaths, toPlainText, truncate, validatePayload,
} from './notify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const lines = (payload) => toPlainText(payload).split('\n');
const sha = (n) => n.toString(16).padStart(40, 'a');

// ------------------------------------------------------------------------------- fixtures

/** An A40 release of 32 changes: 12 feat, 19 fix and one test, interleaved, newest first as git logs them. */
function a40Facts(overrides = {}) {
  const types = Array.from({ length: 32 }, (_, i) => (i === 17 ? 'test' : i % 8 < 3 || (i >= 24 && i % 2 === 0) ? 'feat' : 'fix'));
  // Fix the mix exactly: 12 feat, 19 fix, 1 test.
  let feats = types.filter((t) => t === 'feat').length;
  for (let i = 0; feats !== 12; i += 1) {
    if (feats > 12 && types[i] === 'feat') { types[i] = 'fix'; feats -= 1; } else if (feats < 12 && types[i] === 'fix') { types[i] = 'feat'; feats += 1; }
  }
  const changes = types.map((type, i) => {
    const number = 2001 + i;
    const title = `${type}(${type === 'feat' ? 'model' : 'agent'}): fixture ${type} change ${number}`;
    return { sha: sha(number), subject: `${title} (#${number})`, pr: { number, title, url: `https://github.com/a40-labs/backend/pull/${number}` }, issues: [] };
  }).reverse();
  return {
    product: 'a40', repo: 'a40-labs/backend', tag: 'a40-v1.1.0',
    commit: '3831dfba9eb7eea67783cda5d44a81db44145ff4',
    previous: { tag: 'a40-v1.0.0', commit: 'c60ee5d9d503ca55b2267ba54fcf2e982bd21dd9' },
    releaseUrl: 'https://github.com/a40-labs/backend/releases/tag/a40-v1.1.0',
    paths: [], changes, migrations: 4, protos: 4, requires: null,
    production: { known: true, pin: 'f'.repeat(40), kind: 'release', release: 'a40-v1.0.0' },
    ...overrides,
  };
}

function pingboFacts(overrides = {}) {
  return { ...fixture('pingbo-v1.1.0.facts.json'), ...overrides };
}

function change(number, title, issues = []) {
  return { sha: sha(number), subject: `${title} (#${number})`, pr: { number, title, url: `https://github.com/a40-labs/pingbo/pull/${number}` }, issues };
}

// ----------------------------------------------------------------------------- rendering

test('the approved Pingbo mock renders as its golden text', () => {
  const payload = render(pingboFacts());
  assert.equal(toPlainText(payload), readFileSync(join(here, 'fixtures', 'pingbo-v1.1.0.golden.txt'), 'utf8'));
  assert.deepEqual(validatePayload(payload), []);
});

test('the A40 header and summary are the approved ones, and its 32 changes group by type', () => {
  const payload = render(a40Facts());
  const text = lines(payload);
  assert.equal(text[0], '📦  A40 foundation a40-v1.1.0 released');
  assert.equal(text[1], 'backend@3831dfba9 · after a40-v1.0.0 · 32 changes · 4 migrations · 4 API (proto) files · production: not yet pinned');
  const headings = text.filter((l) => /^\S+ [A-Z][a-z]+ \(\d+\)$/.test(l));
  assert.deepEqual(headings, ['✨ Features (12)', '🐛 Fixes (19)', '🧰 Other (1)']);
  assert.equal(text.filter((l) => l.startsWith('• ')).length, 12 + 12 + 1);
  assert.ok(text.includes('+7 more'));
  assert.deepEqual(validatePayload(payload), []);
});

test('groups come in the approved order and empty ones are left out', () => {
  const facts = pingboFacts({
    changes: [
      change(9, 'chore: tidy'), change(8, 'docs: write it down'), change(7, 'perf(db): faster'),
      change(6, 'fix(api): mend'), change(5, 'feat(ui): add'), change(4, 'refactor: move'), change(3, 'not conventional'),
    ],
  });
  const headings = lines(render(facts)).filter((l) => /\(\d+\)$/.test(l));
  assert.deepEqual(headings, ['✨ Features (1)', '🐛 Fixes (1)', '⚡ Performance (1)', '📝 Docs (1)', '🧰 Other (3)']);
  const onlyFixes = lines(render(pingboFacts({ changes: [change(6, 'fix(api): mend')] }))).filter((l) => /\(\d+\)$/.test(l));
  assert.deepEqual(onlyFixes, ['🐛 Fixes (1)']);
});

test('a line is the PR title as a sentence: type(scope)!: and a trailing (#n) stripped, first letter capitalised', () => {
  const cases = [
    ['feat(onboarding): the look asks', 'The look asks'],
    ['fix!: breaking change', 'Breaking change'],
    ['feat(a-b.c)!: scoped and breaking (#12)', 'Scoped and breaking'],
    ['fix(ios): reland (#4272) (#4276)', 'Reland'],
    ['Plain title', 'Plain title'],
    ['docs:   extra   spaces', 'Extra spaces'],
    ['feat(x): §5 readings', '§5 readings'],
    ['feat(x): keeps (#12) in the middle', 'Keeps (#12) in the middle'],
  ];
  for (const [title, want] of cases) assert.equal(sentence(title), want, title);
  // The PR's title is what shows, not the commit subject; the type and scope come from the commit.
  const facts = pingboFacts({ changes: [{ ...change(7, 'feat(scope): the title on GitHub'), subject: 'feat(scope): the subject in git (#7)' }] });
  const text = lines(render(facts));
  assert.ok(text.includes('• The title on GitHub'));
  assert.ok(text.includes('    scope · PR #7'));
});

test('within a group the newest pull request comes first, and a commit without one after them', () => {
  const noPr = { sha: sha(1), subject: 'feat: pushed without a pull request', pr: null, issues: [] };
  const facts = pingboFacts({ changes: [change(20, 'feat: twenty'), noPr, change(31, 'feat: thirty-one'), change(25, 'feat: twenty-five')] });
  const items = lines(render(facts)).filter((l) => l.startsWith('• '));
  assert.deepEqual(items, ['• Thirty-one', '• Twenty-five', '• Twenty', '• Pushed without a pull request']);
  assert.ok(lines(render(facts)).includes(`    commit ${sha(1).slice(0, 9)}`));
});

test('at most 12 lines a group, then "+N more" linking to the GitHub release', () => {
  const many = (n) => pingboFacts({ changes: Array.from({ length: n }, (_, i) => change(100 + i, `fix: change ${i}`)) });
  const twelve = render(many(MAX_LINES));
  assert.ok(!lines(twelve).some((l) => /more$/.test(l)));
  assert.equal(lines(twelve).filter((l) => l.startsWith('• ')).length, 12);
  const thirteen = render(many(13));
  assert.equal(lines(thirteen).filter((l) => l.startsWith('• ')).length, 12);
  assert.ok(lines(thirteen).includes('+1 more'));
  const fixes = thirteen.blocks.filter((b) => b.type === 'section').map((b) => b.text.text).join('\n');
  assert.match(fixes, /<https:\/\/github\.com\/a40-labs\/pingbo\/releases\/tag\/pingbo-v1\.1\.0\|\+1 more>$/);
  // The heading counts every change, not the twelve shown; the shown are the twelve newest.
  assert.ok(lines(thirteen).includes('🐛 Fixes (13)'));
  assert.ok(!lines(thirteen).includes('• Change 0'));
});

test('an issue title is cut to about 80 characters at a word, and an issue form tag is dropped', () => {
  const long = 'A candidate who applied to the owner\'s role is named "Recruiters" on the read card';
  assert.equal(issueTitle(long), 'A candidate who applied to the owner\'s role is named "Recruiters" on the read…');
  assert.ok([...issueTitle(long)].length <= 80);
  assert.equal(issueTitle('[Feature] The decision lane moves from TypeSafe jev-1.13.0 to gpt-6-luna-decisions'),
    'The decision lane moves from TypeSafe jev-1.13.0 to gpt-6-luna-decisions');
  assert.equal(issueTitle('[Bug] main is red: ci'), 'main is red: ci');
  assert.equal(issueTitle('short'), 'short');
  const unbroken = 'x'.repeat(200);
  assert.equal([...issueTitle(unbroken)].length, 80);
  assert.equal(truncate('a b c', 5), 'a b c');
});

test('the summary counts in the singular, says "no migrations", and a first release says so', () => {
  const one = lines(render(pingboFacts({ changes: [change(1, 'fix: one')], migrations: 1 })))[1];
  assert.match(one, / · 1 change · 1 migration · /);
  const none = lines(render(pingboFacts({ migrations: 0 })))[1];
  assert.match(none, / · 5 changes · no migrations · /);
  const a40 = lines(render(a40Facts({ migrations: 0, protos: 0 })))[1];
  assert.match(a40, / · no migrations · no API \(proto\) changes · /);
  const first = render(pingboFacts({ previous: null, changes: [], migrations: null }));
  assert.equal(lines(first)[1], 'pingbo@6a6af3fa0 · first release · needs A40 a40-v1.1.0 ✓');
  const buttons = first.blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text);
  assert.deepEqual(buttons, ['Release notes']);
  assert.ok(!first.blocks.some((b) => b.type === 'section'));
  assert.deepEqual(validatePayload(first), []);
});

test('what production runs: the ✓, and the A40 production clause, only when it can be read', () => {
  const summary = (facts) => lines(render(facts))[1];
  const prod = (release) => ({ known: true, pin: 'f'.repeat(40), kind: 'release', release });
  assert.match(summary(pingboFacts({ production: prod('a40-v1.1.0') })), /needs A40 a40-v1\.1\.0 ✓$/);
  assert.match(summary(pingboFacts({ production: prod('a40-v1.2.0') })), /needs A40 a40-v1\.1\.0 ✓$/);
  assert.match(summary(pingboFacts({ production: prod('a40-v1.0.9') })), /needs A40 a40-v1\.1\.0$/);
  assert.match(summary(pingboFacts({ production: { known: true, pin: 'f'.repeat(40), kind: 'unreleased' } })), /needs A40 a40-v1\.1\.0$/);
  assert.match(summary(pingboFacts({ production: { known: false } })), /needs A40 a40-v1\.1\.0$/);
  assert.match(summary(pingboFacts({ requires: null })), /no migrations$/);
  assert.match(summary(a40Facts({ production: prod('a40-v1.1.0') })), / · production: runs it$/);
  assert.match(summary(a40Facts({ production: prod('a40-v1.0.0') })), / · production: not yet pinned$/);
  assert.match(summary(a40Facts({ production: { known: true, kind: 'unreleased' } })), / · production: not yet pinned$/);
  assert.match(summary(a40Facts({ production: prod('a40-v1.2.0') })), / · production: runs a40-v1\.2\.0$/);
  assert.match(summary(a40Facts({ production: { known: false } })), / · 4 API \(proto\) files$/);
});

test('titles are escaped, and no @-mention or Slack markup survives', () => {
  const facts = pingboFacts({
    changes: [change(50, 'fix: <!channel> & <@U123> ping @here and a>b', [
      { repo: 'a40-labs/pingbo', number: 9, url: 'https://github.com/a40-labs/pingbo/issues/9', readable: true, title: 'Issue <!here> @everyone', state: 'OPEN' },
    ])],
  });
  const payload = render(facts);
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('<!'), 'no <!channel> or <!here>');
  assert.ok(!json.includes('<@'), 'no user mention');
  assert.ok(!/@(here|everyone|channel)/.test(json), 'no bare @here');
  assert.match(json, /&amp; &lt;@\u200bU123&gt;/);
  assert.deepEqual(validatePayload(payload), []);
  // It still reads as written.
  assert.ok(lines(payload).includes('• <!channel> & <@U123> ping @here and a>b'));
});

test('the message stays inside Block Kit limits however large the release', () => {
  const issues = (n) => Array.from({ length: 40 }, (_, i) => ({
    repo: 'a40-labs/pingbo', number: n * 100 + i, url: `https://github.com/a40-labs/pingbo/issues/${n * 100 + i}`, readable: true,
    title: `An issue title that goes on for a long while, ${'word '.repeat(30)}`, state: 'OPEN',
  }));
  const types = ['feat', 'fix', 'perf', 'docs', 'chore'];
  const changes = Array.from({ length: 200 }, (_, i) => change(5000 + i, `${types[i % 5]}(${'s'.repeat(40)}): ${'a long title '.repeat(20)}`, issues(i)));
  const payload = render(pingboFacts({ changes }));
  assert.deepEqual(validatePayload(payload), []);
  assert.ok(payload.blocks.length <= LIMITS.blocks);
  for (const b of payload.blocks.filter((x) => x.type === 'section')) assert.ok([...b.text.text].length <= LIMITS.section);
  // Every group still says how many it has, and what did not fit is one click away.
  assert.match(toPlainText(payload), /more issues/);
  // The header holds the tag, and the longest tag a release can have still fits.
  const longest = `${'9'.repeat(9)}.${'9'.repeat(9)}.${'9'.repeat(9)}`;
  for (const facts of [pingboFacts({ tag: `pingbo-v${longest}` }), a40Facts({ tag: `a40-v${longest}` })]) {
    assert.deepEqual(validatePayload(render(facts)), []);
    assert.ok([...render(facts).blocks[0].text.text].length <= LIMITS.header);
  }
});

test('more sections than blocks allow end in one link to the release notes', () => {
  const issues = Array.from({ length: 12 }, (_, i) => ({
    repo: 'a40-labs/pingbo', number: 9000 + i, url: `https://github.com/a40-labs/pingbo/issues/${9000 + i}`, readable: true, title: 'y'.repeat(80), state: 'OPEN',
  }));
  const types = ['feat', 'fix', 'perf', 'docs', 'chore'];
  const changes = Array.from({ length: 60 }, (_, i) => change(7000 + i, `${types[i % 5]}: ${'z'.repeat(250)}`, issues));
  const payload = render(pingboFacts({ changes }));
  assert.equal(payload.blocks.length, LIMITS.blocks);
  const last = payload.blocks[payload.blocks.length - 2];
  assert.equal(last.text.text, '<https://github.com/a40-labs/pingbo/releases/tag/pingbo-v1.1.0|The rest is in the release notes>');
  assert.deepEqual(validatePayload(payload), []);
});

test('validatePayload refuses what Slack would', () => {
  const good = render(pingboFacts());
  const mutate = (fn) => { const p = structuredClone(good); fn(p); return validatePayload(p); };
  assert.deepEqual(validatePayload(good), []);
  assert.match(mutate((p) => { while (p.blocks.length <= LIMITS.blocks) p.blocks.splice(2, 0, p.blocks[2]); }).join(), /blocks \(max 50\)/);
  assert.match(mutate((p) => { p.blocks[2].text.text = 'x'.repeat(3001); }).join(), /3001 characters \(max 3000\)/);
  assert.match(mutate((p) => { p.blocks[0].text.text = 'x'.repeat(151); }).join(), /151 characters \(max 150\)/);
  assert.match(mutate((p) => { p.blocks[0].text.type = 'mrkdwn'; }).join(), /header needs plain_text/);
  assert.match(mutate((p) => { p.blocks.at(-1).elements[1].url = 'http://example.com'; }).join(), /not an https URL/);
  assert.match(mutate((p) => { p.blocks.at(-1).elements[1].action_id = 'release_notes'; }).join(), /must be unique/);
  assert.match(mutate((p) => { p.blocks.at(-1).elements[0].text.text = 'x'.repeat(76); }).join(), /button text/);
  assert.match(mutate((p) => { p.blocks[2].text.text += ' <!here>'; }).join(), /raw markup/);
  assert.match(mutate((p) => { p.blocks.push({ type: 'image' }); }).join(), /not a block this message uses/);
  assert.match(mutate((p) => { p.text = ''; }).join(), /no text fallback/);
});

// ------------------------------------------------------------------------- references

test('a PR body names issues as #n, repo#n, a40-labs/repo#n and issue URLs, in order, outside code', () => {
  const body = [
    'Closes #4254, and see deploy#1669 and a40-labs/cloud#453.',
    'Also https://github.com/a40-labs/backend/issues/1461#issuecomment-1 and https://github.com/a40-labs/pingbo/pull/4267.',
    'Not someone-else/repo#5, not `#77`, not <!-- #78 -->, not a color #fff or abc#12x, not C#.',
    '```', 'nor #79 in code', '```',
    'Repeated #4254, and pingbo#4262 is this repository.',
  ].join('\n');
  assert.deepEqual(bodyReferences(body, 'a40-labs/pingbo'), [
    { repo: 'a40-labs/pingbo', number: 4254 },
    { repo: 'a40-labs/deploy', number: 1669 },
    { repo: 'a40-labs/cloud', number: 453 },
    { repo: 'a40-labs/backend', number: 1461 },
    { repo: 'a40-labs/pingbo', number: 4262 },
  ]);
});

// ------------------------------------------------------------------------------ gather

const ISOLATED = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'release-notify-test', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'release-notify-test', GIT_COMMITTER_EMAIL: '',
};

/** A throwaway git repository. */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-notify-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ISOLATED }).trim();
  run('init', '-q', '-b', 'main');
  const commit = (subject, files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    run('add', '-A');
    run('commit', '-q', '--allow-empty', '-m', subject);
    return run('rev-parse', 'HEAD');
  };
  const tag = (name, rev = 'HEAD') => run('tag', '-a', name, '-m', name, rev);
  return { dir, run, commit, tag };
}

const CALLER = 'caller-token';
const CROSS = 'cross-token';
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), headers: { get: () => null } });

/**
 * A fake GitHub: `prs` by repository and number, `issues` by `repo#n` (kind issue or pr), the
 * repositories each token can read, the published releases, and deploy's two files.
 */
function fakeGitHub({ prs = {}, associated = {}, issues = {}, readable = {}, releases = [], deploy = null }) {
  const calls = [];
  const prNode = (repo, number) => {
    const pr = prs[repo]?.[number];
    if (!pr) return null;
    return {
      number, title: pr.title, url: `https://github.com/${repo}/pull/${number}`, body: pr.body || '',
      closingIssuesReferences: { nodes: (pr.closing || []).map((c) => ({ ...c, url: `https://github.com/${c.repo}/issues/${c.number}`, repository: { nameWithOwner: c.repo } })) },
    };
  };
  const fetch = async (url, init = {}) => {
    const token = String(init.headers?.Authorization || '').replace(/^Bearer /, '');
    const can = (repo) => (readable[token] || []).includes(repo);
    if (url.endsWith('/graphql')) {
      const { query } = JSON.parse(init.body);
      const [, owner, name] = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(query);
      const repo = `${owner}/${name}`.toLowerCase();
      calls.push({ kind: 'graphql', token, repo });
      if (!can(repo)) return response(200, { data: { repository: null }, errors: [{ message: `Could not resolve to a Repository with the name '${repo}'.` }] });
      const data = {};
      for (const m of query.matchAll(/(c\d+): pullRequest\(number: (\d+)\)/g)) data[m[1]] = prNode(repo, Number(m[2]));
      for (const m of query.matchAll(/(c\d+): object\(oid: "([0-9a-f]+)"\)/g)) {
        const n = associated[m[2]];
        data[m[1]] = { associatedPullRequests: { nodes: n ? [{ mergedAt: '2026-10-13T00:00:00Z', ...prNode(repo, n) }] : [] } };
      }
      for (const m of query.matchAll(/(i\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
        const it = issues[`${repo}#${m[2]}`];
        data[m[1]] = !it ? null : it.kind === 'pr' ? { __typename: 'PullRequest' }
          : { __typename: 'Issue', number: Number(m[2]), title: it.title, state: it.state, url: `https://github.com/${repo}/issues/${m[2]}` };
      }
      return response(200, { data: { repository: data } });
    }
    calls.push({ kind: 'rest', token, url });
    const rel = /\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(url);
    if (rel) {
      if (!can(rel[1]) || !releases.includes(decodeURIComponent(rel[2]))) return response(404, { message: 'Not Found' });
      return response(200, { html_url: `https://github.com/${rel[1]}/releases/tag/${decodeURIComponent(rel[2])}` });
    }
    const file = /\/repos\/a40-labs\/deploy\/contents\/(.+)\?ref=(.+)$/.exec(url);
    if (file && deploy && can('a40-labs/deploy')) {
      const ref = decodeURIComponent(file[2]);
      if (file[1] === DEPLOY.appset && ref === 'main') return response(200, { content: Buffer.from(deploy.appset).toString('base64') });
      if (file[1] === DEPLOY.values && ref === deploy.pin) return response(200, { content: Buffer.from(deploy.values).toString('base64') });
    }
    return response(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}

const PIN = 'c'.repeat(40);
const deployFiles = (release) => ({
  pin: PIN,
  appset: `spec:\n  generators:\n    - git:\n        revision: &pin ${PIN}\n`,
  values: `images:\n  # comment\n  tags:\n    agent-backend: "${release}"\n    model-backend: "${release}"\n\nnext: 1\n`,
});

/** A pingbo-like history: v1.0.0, then server and non-server commits, a migration, then v1.1.0. */
function pingboHistory() {
  const r = gitRepo();
  r.commit('feat: the start', { 'server/a.ts': '1', 'server/drizzle/0001_a.sql': 'select 1;' });
  r.tag('pingbo-v1.0.0');
  r.commit('feat(apple): not the server (#10)', { 'apple/x.swift': '1' });
  const fix = r.commit('fix(server): mend (#11)', { 'server/a.ts': '2', 'server/drizzle/0001_a.sql': 'select 2;' });
  r.commit('feat(server): add a table (#12)', { 'server/drizzle/0002_b.sql': 'create table b();', 'server/drizzle/meta/x.sql': 'not a migration' });
  r.commit('docs(server): explain (#13)', { 'server/README.md': 'x', 'server/a40-foundation.json': '{"requires":"a40-v1.1.0"}' });
  const direct = r.commit('chore(ci): bump the pull script', { 'scripts/ci-pull-image.sh': 'x' });
  r.tag('pingbo-v1.1.0');
  return { ...r, fix, direct };
}

const PINGBO_PATHS = ['server', '.github/workflows/server-image.yml', 'scripts/ci-pull-image.sh'];

test('gather keeps issues, drops references that are pull requests, and links an unreadable repository plainly', async () => {
  const h = pingboHistory();
  const gh = fakeGitHub({
    prs: {
      'a40-labs/pingbo': {
        11: { title: 'fix(server): mend', body: 'Fixes #4254. After #4267 (a PR) and deploy#1669 (a PR), see cloud#7 and #999999.', closing: [{ repo: 'a40-labs/pingbo', number: 4257, title: '[Feature] The lane', state: 'CLOSED' }] },
        12: { title: 'feat(server): add a table', body: 'Mentions #4257 again, which it also closes.' , closing: [] },
        13: { title: 'docs(server): explain', body: '' },
      },
    },
    issues: {
      'a40-labs/pingbo#4254': { kind: 'issue', title: 'Named "Recruiters"', state: 'OPEN' },
      'a40-labs/pingbo#4257': { kind: 'issue', title: '[Feature] The lane', state: 'CLOSED' },
      'a40-labs/pingbo#4267': { kind: 'pr' },
      'a40-labs/deploy#1669': { kind: 'pr' },
      'a40-labs/cloud#7': { kind: 'issue', title: 'Cloud issue', state: 'OPEN' },
    },
    readable: { [CALLER]: ['a40-labs/pingbo'], [CROSS]: ['a40-labs/pingbo', 'a40-labs/deploy', 'a40-labs/cloud'] },
    releases: ['pingbo-v1.1.0'],
    deploy: deployFiles('a40-v1.1.0'),
  });
  const github = githubClient({ token: CALLER, crossToken: CROSS, fetch: gh.fetch });
  const facts = await gather({ product: 'pingbo', tag: 'pingbo-v1.1.0', repoDir: h.dir, paths: PINGBO_PATHS, github });
  const fix = facts.changes.find((c) => c.pr?.number === 11);
  assert.deepEqual(fix.issues.map((i) => `${i.repo}#${i.number}:${i.readable}`), [
    'a40-labs/pingbo#4257:true', // closes it
    'a40-labs/pingbo#4254:true', // names it
    'a40-labs/cloud#7:true', // another repository, read with the cross-repository token
  ]);
  const feat = facts.changes.find((c) => c.pr?.number === 12);
  assert.deepEqual(feat.issues, [{ repo: 'a40-labs/pingbo', number: 4257, url: 'https://github.com/a40-labs/pingbo/issues/4257', readable: true, title: '[Feature] The lane', state: 'CLOSED' }]);
  // The cross-repository token reads other repositories; the caller's reads its own.
  assert.ok(gh.calls.filter((c) => c.repo === 'a40-labs/cloud').every((c) => c.token === CROSS));
  assert.ok(gh.calls.filter((c) => c.kind === 'graphql' && c.repo === 'a40-labs/pingbo').every((c) => c.token === CALLER));

  // Without the cross-repository token, another repository's issue is a plain link, and a
  // reference that might be a pull request cannot be told apart, so it is one too.
  const bare = await gather({ product: 'pingbo', tag: 'pingbo-v1.1.0', repoDir: h.dir, paths: PINGBO_PATHS, github: githubClient({ token: CALLER, fetch: gh.fetch }) });
  const fixBare = bare.changes.find((c) => c.pr?.number === 11);
  assert.deepEqual(fixBare.issues.map((i) => `${i.repo}#${i.number}:${i.readable}`), [
    'a40-labs/pingbo#4257:true', 'a40-labs/pingbo#4254:true', 'a40-labs/deploy#1669:false', 'a40-labs/cloud#7:false',
  ]);
  const text = toPlainText(render(bare));
  assert.match(text, / · PR #11 · issue #4257 The lane \(closed\) · issue #4254 Named "Recruiters" \(open\) · deploy#1669 · cloud#7\n/);
  assert.equal(bare.production.known, false);
  assert.match(text.split('\n')[1], /needs A40 a40-v1\.1\.0$/);
});

test('gather counts changes under --paths, added migrations only, and finds the PR of a commit without (#n)', async () => {
  const h = pingboHistory();
  const gh = fakeGitHub({
    prs: { 'a40-labs/pingbo': { 11: { title: 'fix(server): mend' }, 12: { title: 'feat(server): add a table' }, 13: { title: 'docs(server): explain' }, 14: { title: 'chore(ci): bump the pull script' } } },
    readable: { [CALLER]: ['a40-labs/pingbo'], [CROSS]: ['a40-labs/deploy'] },
    releases: ['pingbo-v1.1.0'],
    deploy: deployFiles('a40-v1.1.0'),
  });
  const github = githubClient({ token: CALLER, crossToken: CROSS, fetch: gh.fetch });
  const facts = await gather({ product: 'pingbo', tag: 'pingbo-v1.1.0', repoDir: h.dir, paths: PINGBO_PATHS, github });
  assert.deepEqual(facts.changes.map((c) => c.subject), [
    'chore(ci): bump the pull script', 'docs(server): explain (#13)', 'feat(server): add a table (#12)', 'fix(server): mend (#11)',
  ]);
  assert.equal(facts.changes[0].pr, null, 'no (#n) and no associated PR: the commit links itself');
  assert.equal(facts.migrations, 1, 'added server/drizzle/*.sql only: not the modified one, not one in a subdirectory');
  assert.equal(facts.requires, 'a40-v1.1.0');
  assert.deepEqual(facts.production, { known: true, pin: PIN, kind: 'release', release: 'a40-v1.1.0' });
  assert.equal(lines(render(facts))[1], `pingbo@${h.run('rev-parse', 'pingbo-v1.1.0^{commit}').slice(0, 9)} · after pingbo-v1.0.0 · 4 changes · 1 migration · needs A40 a40-v1.1.0 ✓`);

  // A commit without (#n) whose pull request GitHub knows is described by that pull request.
  const assoc = fakeGitHub({
    prs: { 'a40-labs/pingbo': { 14: { title: 'chore(ci): bump the pull script' } } },
    associated: { [h.direct]: 14 },
    readable: { [CALLER]: ['a40-labs/pingbo'] },
    releases: ['pingbo-v1.1.0'],
  });
  const withPr = await gather({ product: 'pingbo', tag: 'pingbo-v1.1.0', repoDir: h.dir, paths: PINGBO_PATHS, github: githubClient({ token: CALLER, fetch: assoc.fetch }) });
  assert.equal(withPr.changes[0].pr.number, 14);

  // Without --paths every commit counts, as A40's do.
  const all = await gather({ product: 'pingbo', tag: 'pingbo-v1.1.0', repoDir: h.dir, paths: [], github });
  assert.equal(all.changes.length, 5);
});

test('gather counts A40 migrations and proto files the way release.py does', async () => {
  const r = gitRepo();
  r.commit('feat: start', { 'proto/a/v1/a.proto': '1', 'proto/protogen/x.go': '1', 'services/agent/pkg/db/migration/000001_a.up.sql': '1' });
  r.tag('a40-v1.0.0');
  r.commit('feat(agent): migrate (#1)', {
    'services/agent/pkg/db/migration/000002_b.up.sql': '1', 'services/agent/pkg/db/migration/000002_b.down.sql': '1',
    'services/model/pkg/db/migration/000003_c.up.sql': '1', 'services/agent/pkg/db/migration/000001_a.up.sql': '2',
  });
  r.commit('feat(proto): change the api (#2)', { 'proto/a/v1/a.proto': '2', 'proto/b/v1/b.proto': '1', 'proto/protogen/x.go': '2', 'proto/openapi/v2/service.swagger.yaml': '1' });
  r.tag('a40-v1.1.0');
  const gh = fakeGitHub({ prs: { 'a40-labs/backend': { 1: { title: 'feat(agent): migrate' }, 2: { title: 'feat(proto): change the api' } } }, readable: { [CALLER]: ['a40-labs/backend'] }, releases: ['a40-v1.1.0'] });
  const facts = await gather({ product: 'a40', tag: 'a40-v1.1.0', repoDir: r.dir, github: githubClient({ token: CALLER, fetch: gh.fetch }) });
  assert.equal(facts.migrations, 2, 'two .up.sql added; a .down.sql and a modified .up.sql are not migrations added');
  assert.equal(facts.protos, 3, 'every proto/ change but protogen/');
  assert.equal(facts.changes.length, 2);
  assert.deepEqual(facts.production, { known: false, reason: 'no cross-repository token' });
  assert.equal(lines(render(facts))[1], `backend@${facts.commit.slice(0, 9)} · after a40-v1.0.0 · 2 changes · 2 migrations · 3 API (proto) files`);
});

test('the previous release is the highest ancestor tag of the same prefix, the tag itself excluded', () => {
  const r = gitRepo();
  r.commit('a', { a: '1' }); r.tag('pingbo-v1.0.0'); r.tag('a40-v9.0.0');
  r.commit('b', { a: '2' }); r.tag('pingbo-v1.0.1'); r.tag('pingbo-v1.0.1-rc1');
  const side = r.run('rev-parse', 'HEAD');
  r.run('checkout', '-q', '-b', 'side');
  r.commit('c', { b: '1' }); r.tag('pingbo-v1.5.0'); // not an ancestor of main's next commit
  r.run('checkout', '-q', 'main');
  r.commit('d', { a: '3' }); r.tag('pingbo-v1.1.0');
  const head = r.run('rev-parse', 'HEAD');
  assert.deepEqual(previousRelease(r.dir, 'pingbo-v', 'pingbo-v1.1.0', head), { tag: 'pingbo-v1.0.1', commit: side });
  const first = r.run('rev-parse', 'pingbo-v1.0.0^{commit}');
  assert.equal(previousRelease(r.dir, 'pingbo-v', 'pingbo-v1.0.0', first), null, 'a first release has none');
});

test('gather refuses a tag of the wrong product, a tag with no published release, and a checkout without the tag', async () => {
  const h = pingboHistory();
  const gh = fakeGitHub({ readable: { [CALLER]: ['a40-labs/pingbo'] }, releases: [] });
  const github = githubClient({ token: CALLER, fetch: gh.fetch });
  await assert.rejects(gather({ product: 'pingbo', tag: 'a40-v1.1.0', repoDir: h.dir, github }), /not a pingbo release/);
  await assert.rejects(gather({ product: 'pingbo', tag: 'pingbo-v1.1.0', repoDir: h.dir, github }), /no published GitHub release pingbo-v1\.1\.0/);
  await assert.rejects(gather({ product: 'pingbo', tag: 'pingbo-v1.2.0', repoDir: h.dir, github }), /fetch-depth: 0 and its tags/);
  await assert.rejects(gather({ product: 'shubo', tag: 'shubo-v1.0.0', repoDir: h.dir, github }), /unknown product/);
});

test('a first release gathers no changes and renders "first release"', async () => {
  const r = gitRepo();
  r.commit('feat: everything (#1)', { 'server/a.ts': '1' });
  r.tag('pingbo-v1.0.0');
  const gh = fakeGitHub({ readable: { [CALLER]: ['a40-labs/pingbo'] }, releases: ['pingbo-v1.0.0'] });
  const facts = await gather({ product: 'pingbo', tag: 'pingbo-v1.0.0', repoDir: r.dir, paths: PINGBO_PATHS, github: githubClient({ token: CALLER, fetch: gh.fetch }) });
  assert.equal(facts.previous, null);
  assert.deepEqual(facts.changes, []);
  assert.equal(lines(render(facts))[1], `pingbo@${facts.commit.slice(0, 9)} · first release`);
});

// --------------------------------------------------------------------------------- main

function actionsEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-notify-env-'));
  const env = { GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'output'), ...extra };
  writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  writeFileSync(env.GITHUB_OUTPUT, '');
  return env;
}
const factsFile = () => join(here, 'fixtures', 'pingbo-v1.1.0.facts.json');

test('without a Slack token the message goes to the job summary, nothing is posted, and the run exits 0', async () => {
  const env = actionsEnv();
  const logged = [];
  let fetched = 0;
  const code = await main(['--facts', factsFile()], env, { fetch: async () => { fetched += 1; }, log: (m) => logged.push(m) });
  assert.equal(code, 0);
  assert.equal(fetched, 0);
  assert.ok(logged.includes('::notice::A40_SLACK_BOT_TOKEN not set: not posted'));
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /^### A40_SLACK_BOT_TOKEN not set: not posted/);
  assert.ok(summary.includes(readFileSync(join(here, 'fixtures', 'pingbo-v1.1.0.golden.txt'), 'utf8').trim()));
  assert.match(summary, /"channel": "C02DEV2BWRZ"/);
  assert.match(summary, /"unfurl_links": false/);
  // --dry-run does the same with a token, and says so.
  const dry = actionsEnv({ SLACK_BOT_TOKEN: 'xoxb-test' });
  assert.equal(await main(['--facts', factsFile(), '--dry-run'], dry, { fetch: async () => { fetched += 1; }, log: () => {} }), 0);
  assert.equal(fetched, 0);
  assert.match(readFileSync(dry.GITHUB_STEP_SUMMARY, 'utf8'), /^### Dry run: not posted/);
});

test('with a Slack token it posts to the channel and reports the ts', async () => {
  const env = actionsEnv({ SLACK_BOT_TOKEN: 'xoxb-test-token' });
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, init }); return response(200, { ok: true, channel: 'C0CHANNEL', ts: '1760000000.000100' }); };
  const logged = [];
  assert.equal(await main(['--facts', factsFile(), '--channel', 'C0CHANNEL'], env, { fetch, log: (m) => logged.push(m) }), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://slack.com/api/chat.postMessage');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.channel, 'C0CHANNEL');
  assert.deepEqual(body.blocks, render(fixture('pingbo-v1.1.0.facts.json')).blocks);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /^slack_channel=C0CHANNEL\nslack_ts=1760000000\.000100\n$/);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /message ts `1760000000\.000100`/);
  assert.ok(!logged.join('\n').includes('xoxb-test-token'));
  // A refusal fails the run.
  const refused = async () => response(200, { ok: false, error: 'not_in_channel' });
  await assert.rejects(main(['--facts', factsFile()], actionsEnv({ SLACK_BOT_TOKEN: 'xoxb-test-token' }), { fetch: refused, log: () => {} }), /not_in_channel/);
});

test('the run refuses a product released from another repository, and needs the caller token', async () => {
  await assert.rejects(main(['--product', 'a40', '--tag', 'a40-v1.1.0'], { GITHUB_REPOSITORY: 'a40-labs/pingbo', GITHUB_TOKEN: 'x' }, { log: () => {} }), /released from a40-labs\/backend, but this run is in a40-labs\/pingbo/);
  await assert.rejects(main(['--product', 'pingbo', '--tag', 'pingbo-v1.1.0'], { GITHUB_REPOSITORY: 'a40-labs/pingbo' }, { log: () => {} }), /GITHUB_TOKEN is not set/);
  await assert.rejects(main(['--product', 'shubo', '--tag', 'x'], {}, { log: () => {} }), /--product must be/);
});

test('arguments and the paths input parse as the workflow passes them', () => {
  assert.deepEqual(parseArgs(['--product', 'pingbo', '--tag=pingbo-v1.1.0', '--dry-run', '--paths', 'a\nb']), { 'dry-run': true, product: 'pingbo', tag: 'pingbo-v1.1.0', paths: 'a\nb' });
  assert.throws(() => parseArgs(['--webhook', 'x']), /unknown argument/);
  assert.deepEqual(splitPaths('server\n  .github/workflows/server-image.yml \n\nscripts/ci-pull-image.sh\n'), PINGBO_PATHS);
  assert.deepEqual(splitPaths(''), []);
  assert.equal(DEFAULT_CHANNEL, 'C02DEV2BWRZ');
});

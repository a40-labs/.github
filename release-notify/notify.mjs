// The release notification: one Slack message when an A40 foundation release (a40-v*, a40-labs/backend)
// or a Pingbo release (pingbo-v*, a40-labs/pingbo) is published. Zero dependencies, Node 20. Run by
// .github/workflows/release-notify.yml from the caller's checkout:
//
//   node notify.mjs --product a40|pingbo --tag <tag> [--paths "<pathspec>\n..."] [--channel C...]
//                   [--repo-dir <checkout>] [--dry-run] [--out <dir>] [--facts <facts.json>]
//
//   GITHUB_TOKEN       the caller's token: its own pull requests, issues and release (required)
//   CROSS_REPO_TOKEN   optional: issues in other a40-labs repositories, and what production runs
//                      (a40-labs/deploy). Without it those issues are plain links and the
//                      production clause is left out (A40) or the ✓ dropped (Pingbo)
//   SLACK_BOT_TOKEN    optional: the A40 app's bot token. Without it, or with --dry-run, the
//                      message goes to the job summary instead, and the run exits 0
//
// Three stages, so the rendering can be tested without git or the network:
//   gather  git facts from the caller's checkout + GitHub GraphQL/REST  -> facts (plain JSON)
//   render  a pure function of the facts -> { text, blocks }, inside Slack's Block Kit limits
//   post    chat.postMessage (slack.mjs), or the dry run
//
// The layout is the one the owner approved (2026-10-13). What it counts:
//   - changes: the commits since the previous release (the highest tag of the same prefix that is
//     an ancestor of the tag's commit, the tag itself excluded), limited to --paths when given.
//     Pingbo passes scripts/pingbo-release.cjs's IMAGE_INPUTS; A40 passes none, as release.py's
//     notes list every commit.
//   - migrations: files ADDED since the previous release, as backend's release.py counts them
//     (services/<service>/pkg/db/migration/*.up.sql; Pingbo's are server/drizzle/*.sql).
//   - API (proto) files (A40 only): release.py's proto_changes, every status, protogen/ excluded.
// Groups follow the conventional-commit type of each commit: feat, fix, perf, docs, then the rest.
// A line is the pull request's title as a sentence; under it, the scope, the PR and its issues
// (closingIssuesReferences, then the #n / repo#n / a40-labs/repo#n / issue URLs its body names,
// resolved with issueOrPullRequest so that pull requests drop out). Lines are newest first, by
// pull request number. No @-mention reaches Slack, and nothing names a person.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_TOKEN_NOTICE, appendSummary, fence, messageBody, postMessage, redact, reportPosted } from './slack.mjs';

export const OWNER = 'a40-labs';
export const DEFAULT_CHANNEL = 'C02DEV2BWRZ'; // #dev-product
const GITHUB = 'https://github.com';

export const PRODUCTS = {
  a40: {
    repo: 'a40-labs/backend',
    prefix: 'a40-v',
    short: 'backend',
    header: (tag) => `📦  A40 foundation ${tag} released`,
    migrations: { pathspec: 'services', match: /^services\/[^/]+\/pkg\/db\/migration\/[^/]+\.up\.sql$/ },
    protos: true,
    requirement: null,
  },
  pingbo: {
    repo: 'a40-labs/pingbo',
    prefix: 'pingbo-v',
    short: 'pingbo',
    header: (tag) => `🚀  Pingbo ${tag} is live in production`,
    migrations: { pathspec: 'server/drizzle', match: /^server\/drizzle\/[^/]+\.sql$/ },
    protos: false,
    requirement: 'server/a40-foundation.json',
  },
};

// What a40-prod runs: the ApplicationSet's one `revision: &pin <sha>` on deploy main is the commit
// production renders, and values-gke-prod.yaml's images.tags at that pin name the release (the
// same read pingbo's scripts/cloud-roll-pr.cjs makes before every roll).
export const DEPLOY = {
  repo: 'a40-labs/deploy',
  appset: 'k8s/gke-prod/argocd/applicationset.yaml',
  values: 'k8s/charts/a40/values-gke-prod.yaml',
};

export const GROUPS = [
  { key: 'feat', title: '✨ Features' },
  { key: 'fix', title: '🐛 Fixes' },
  { key: 'perf', title: '⚡ Performance' },
  { key: 'docs', title: '📝 Docs' },
  { key: 'other', title: '🧰 Other' },
];
export const MAX_LINES = 12;
export const ISSUE_TITLE_MAX = 80;
// Block Kit: https://api.slack.com/reference/block-kit/blocks
export const LIMITS = {
  blocks: 50, header: 150, section: 3000, contextElements: 10, contextText: 3000,
  actionElements: 25, buttonText: 75, url: 3000, actionId: 255, text: 3000,
};
// One item's two lines: well under a section, so a group packs into few sections.
const ITEM_MAX = 2400;
// The second line's indent. Slack keeps no-break spaces where it may trim plain ones.
const INDENT = '\u00a0'.repeat(4);

// --------------------------------------------------------------------------------- versions

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** The release `tag` names under `prefix` (strict: no leading zero, no pre-release), or null. */
export function parseRelease(prefix, tag) {
  if (typeof tag !== 'string') return null;
  const m = new RegExp(`^${escapeRegExp(prefix)}(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$`).exec(tag);
  return m ? { tag, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
}

/** Negative when `a` is older than `b`, zero when the same, positive when newer. */
export function compareReleases(a, b) {
  return a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];
}

// ------------------------------------------------------------------------------------ text

const CONVENTIONAL = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?:[ \t]*(?=\S)/;
const TRAILING_PRS = /(?:\s*\(#[0-9]+\))+\s*$/;

/** A conventional-commit header's type and scope, or null when it is not one. */
export function parseHeader(header) {
  const m = CONVENTIONAL.exec(String(header ?? '').trim());
  if (!m) return null;
  return { type: m.groups.type.toLowerCase(), scope: (m.groups.scope || '').trim() || null, breaking: Boolean(m.groups.bang) };
}

/** A PR title as a sentence: `type(scope)!:` and a trailing `(#n)` stripped, the first letter capitalised. */
export function sentence(title) {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim();
  const m = CONVENTIONAL.exec(t);
  if (m) t = t.slice(m[0].length);
  t = t.replace(TRAILING_PRS, '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** The group a change belongs to, from its conventional-commit type. */
export function groupOf(type) {
  return GROUPS.some((g) => g.key === type && g.key !== 'other') ? type : 'other';
}

/** `text` cut to at most `max` characters (the ellipsis included), at a word boundary when one is near. */
export function truncate(text, max) {
  const chars = [...String(text)];
  if (chars.length <= max) return String(text);
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const head = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:–—-]+$/, '')}…`;
}

/** An issue title as shown: an issue form's `[Feature] ` style tag dropped, about 80 characters. */
export function issueTitle(title, max = ISSUE_TITLE_MAX) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim().replace(/^\[[A-Za-z][A-Za-z -]{0,30}\]\s*/, '');
  return truncate(t, max);
}

/** Text made safe for mrkdwn: `&`, `<` and `>` escaped, and no `@` that Slack could read as a mention. */
export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@(?=[A-Za-z0-9_.-])/g, '@\u200b');
}

const link = (url, label) => `<${url}|${label}>`;

// ------------------------------------------------------------------------- issue references

const ISSUE_URL = /https?:\/\/github\.com\/(?<owner>[A-Za-z0-9-]+)\/(?<repo>[A-Za-z0-9_.-]+)\/issues\/(?<number>[0-9]{1,7})(?![0-9])/gi;
const SHORT_REF = /(?<![\w/.#@-])(?:(?<owner>[A-Za-z0-9-]+)\/)?(?<repo>[A-Za-z0-9_.-]*[A-Za-z0-9_])?#(?<number>[0-9]{1,7})(?![\w-])/g;

/** A PR body as prose: HTML comments, fenced code blocks and inline code removed (GitHub links none of them). */
export function prose(body) {
  const out = [];
  let fenced = null;
  for (const line of String(body ?? '').replace(/<!--[\s\S]*?-->/g, ' ').split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      if (m && m[1][0] === fenced[0] && m[1].length >= fenced.length) fenced = null;
      continue;
    }
    if (m) { fenced = m[1]; continue; }
    out.push(line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)));
  }
  return out.join('\n');
}

/**
 * The issues a PR body names, in order: `#n` (this repository), `repo#n` and `a40-labs/repo#n`,
 * and issue URLs. Other owners are not ours to resolve and are skipped. Pull requests are among
 * these until resolveReferences drops them.
 */
export function bodyReferences(body, home) {
  const homeName = home.split('/')[1].toLowerCase();
  const text = prose(body);
  const found = [];
  const add = (index, owner, repo, number) => {
    if (owner && owner.toLowerCase() !== OWNER) return;
    found.push({ index, repo: `${OWNER}/${(repo || homeName).toLowerCase()}`, number: Number(number) });
  };
  for (const m of text.matchAll(ISSUE_URL)) add(m.index, m.groups.owner, m.groups.repo, m.groups.number);
  // URLs are read above; blank them (keeping offsets) so their fragments are not read as references.
  const rest = text.replace(/https?:\/\/\S+/g, (s) => ' '.repeat(s.length));
  for (const m of rest.matchAll(SHORT_REF)) add(m.index, m.groups.owner, m.groups.repo, m.groups.number);
  const seen = new Set();
  return found.sort((a, b) => a.index - b.index)
    .map(({ repo, number }) => ({ repo, number }))
    .filter((r) => { const k = refKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

const refKey = (r) => `${r.repo}#${r.number}`;
const NAME = /^[A-Za-z0-9_.-]+$/;

// ------------------------------------------------------------------------------------- git

const git = (cwd, args) => execFileSync('git', ['-c', 'log.showSignature=false', ...args],
  { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

function commitOf(cwd, rev) {
  let out = '';
  try { out = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim(); } catch { /* below */ }
  if (!out) throw new Error(`${rev} is not a commit in this checkout (check it out with fetch-depth: 0 and its tags)`);
  return out;
}

function isAncestor(cwd, ancestor, commit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw new Error(`git merge-base --is-ancestor ${ancestor} ${commit} failed (exit ${e.status})`);
  }
}

/** The previous release: the highest `prefix` tag that is an ancestor of `commit`, `tag` itself excluded. */
export function previousRelease(cwd, prefix, tag, commit) {
  const names = git(cwd, ['for-each-ref', '--format=%(refname:strip=2)', `refs/tags/${prefix}*`]).split('\n').filter(Boolean);
  let best = null;
  for (const name of names) {
    const release = parseRelease(prefix, name);
    if (!release || name === tag) continue;
    const c = commitOf(cwd, `refs/tags/${name}`);
    if (!isAncestor(cwd, c, commit)) continue;
    if (!best || compareReleases(release, best.release) > 0) best = { release, commit: c };
  }
  return best ? { tag: best.release.tag, commit: best.commit } : null;
}

/** (sha, subject) for every commit in from..to, newest first; only those touching `paths` when given. */
export function commitsBetween(cwd, from, to, paths = []) {
  const out = git(cwd, ['log', '--format=%H%x1f%s%x1e', `${from}..${to}`, ...(paths.length ? ['--', ...paths] : [])]);
  return out.split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((r) => {
    const [sha, subject] = r.split('\x1f');
    return { sha, subject: subject.trim() };
  });
}

/** Files added between two commits under `pathspec` whose path matches `match` (release.py's added_migrations). */
export function addedFiles(cwd, from, to, { pathspec, match }) {
  return git(cwd, ['diff', '--name-status', '--no-renames', '--diff-filter=A', from, to, '--', pathspec])
    .split('\n').filter(Boolean).map((l) => l.split('\t')[1]).filter((p) => p && match.test(p)).sort();
}

/** Proto files changed between two commits, every status, protogen/ excluded (release.py's proto_changes). */
export function protoFiles(cwd, from, to) {
  return git(cwd, ['diff', '--name-status', '--no-renames', from, to, '--', 'proto'])
    .split('\n').filter(Boolean).map((l) => l.split('\t')[1])
    .filter((p) => p && p.startsWith('proto/') && !p.includes('protogen/')).sort();
}

/** The A40 release a Pingbo commit requires (`server/a40-foundation.json`), or null. */
export function requirementAt(cwd, commit, file, warn = () => {}) {
  let text;
  try { text = git(cwd, ['show', `${commit}:${file}`]); } catch { return null; }
  try {
    const requires = JSON.parse(text).requires;
    if (parseRelease('a40-v', requires)) return requires;
  } catch { /* below */ }
  warn(`${file} at ${commit.slice(0, 9)} names no a40-vX.Y.Z requirement; leaving it out`);
  return null;
}

// ---------------------------------------------------------------------------------- GitHub

/** GitHub's REST and GraphQL APIs over fetch, for one or two tokens. */
export function githubClient({ token, crossToken = null, fetch: send = globalThis.fetch, apiUrl, graphqlUrl }) {
  const api = (apiUrl || 'https://api.github.com').replace(/\/$/, '');
  const gql = graphqlUrl || `${api}/graphql`;
  const headers = (tok) => ({
    Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'a40-release-notify',
  });
  const secrets = [token, crossToken].filter(Boolean);
  const clean = (s) => secrets.reduce((acc, t) => redact(acc, t), String(s));
  return {
    token,
    crossToken,
    async graphql(tok, query) {
      const res = await send(gql, { method: 'POST', headers: { ...headers(tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      const body = await res.text();
      if (!res.ok) throw new Error(clean(`GitHub GraphQL: HTTP ${res.status} ${body.slice(0, 300)}`));
      return JSON.parse(body);
    },
    async get(tok, path) {
      const res = await send(`${api}${path}`, { headers: headers(tok) });
      const body = await res.text();
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* left null */ }
      return { status: res.status, ok: res.ok, json };
    },
  };
}

const PR_FIELDS = 'number title url body closingIssuesReferences(first: 50) { nodes { number title state url repository { nameWithOwner } } }';
const BATCH = 20;

/** The pull request of each commit: the trailing `(#n)` of a squash subject, else the PR GitHub associates with the commit. */
async function pullRequests(gh, repo, commits) {
  const [owner, name] = repo.split('/');
  const found = new Map();
  for (let i = 0; i < commits.length; i += BATCH) {
    const batch = commits.slice(i, i + BATCH);
    const parts = batch.map((c, j) => {
      const n = /\(#([0-9]+)\)\s*$/.exec(c.subject);
      if (n) return `c${j}: pullRequest(number: ${Number(n[1])}) { ${PR_FIELDS} }`;
      if (!/^[0-9a-f]{40}$/.test(c.sha)) throw new Error(`not a commit sha: ${c.sha}`);
      return `c${j}: object(oid: "${c.sha}") { ... on Commit { associatedPullRequests(first: 5) { nodes { mergedAt ${PR_FIELDS} } } } }`;
    });
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${parts.join('\n')}\n} }`;
    const { data, errors } = await gh.graphql(gh.token, query);
    if (!data?.repository) throw new Error(`GitHub GraphQL could not read ${repo}: ${(errors || []).map((e) => e.message).join('; ') || 'no data'}`);
    batch.forEach((c, j) => {
      const node = data.repository[`c${j}`];
      // null: the (#n) named no pull request (an issue, or a number that is gone); the change keeps its commit link.
      const pr = node?.associatedPullRequests ? node.associatedPullRequests.nodes.find((p) => p.mergedAt) : node;
      if (pr && pr.number) found.set(c.sha, pr);
    });
  }
  return found;
}

/**
 * What each reference is: an issue (title, state, url), a pull request, or missing. A reference in
 * the caller's repository is read with the caller's token; one elsewhere with the cross-repository
 * token, then the caller's. A repository no token can read leaves its references unresolved.
 */
export async function resolveReferences(gh, refs, home, warn = () => {}) {
  const result = new Map();
  const byRepo = new Map();
  for (const r of refs) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    if (!byRepo.get(r.repo).some((x) => x.number === r.number)) byRepo.get(r.repo).push(r);
  }
  for (const [repo, list] of byRepo) {
    const [owner, name] = repo.split('/');
    if (!NAME.test(owner) || !NAME.test(name)) continue;
    const tokens = [...new Set(repo === home ? [gh.token] : [gh.crossToken, gh.token])].filter(Boolean);
    for (const tok of tokens) {
      const pending = list.filter((r) => !result.has(refKey(r)));
      if (!pending.length) break;
      for (let i = 0; i < pending.length; i += 50) {
        const batch = pending.slice(i, i + 50);
        const parts = batch.map((r, j) => `i${j}: issueOrPullRequest(number: ${r.number}) { __typename ... on Issue { number title state url } }`);
        const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${parts.join('\n')}\n} }`;
        let data;
        try {
          ({ data } = await gh.graphql(tok, query));
        } catch (e) {
          warn(`reading issues in ${repo}: ${e.message}`);
          break;
        }
        if (!data?.repository) break; // this token cannot read the repository
        batch.forEach((r, j) => {
          const node = data.repository[`i${j}`];
          if (!node) result.set(refKey(r), { kind: 'missing' });
          else if (node.__typename === 'Issue') result.set(refKey(r), { kind: 'issue', title: node.title, state: node.state, url: node.url });
          else result.set(refKey(r), { kind: 'pr' });
        });
      }
    }
  }
  return result;
}

/** Each change with its pull request and issues. */
async function describeChanges(gh, repo, commits, warn) {
  const prs = await pullRequests(gh, repo, commits);
  const mentioned = new Map();
  for (const c of commits) {
    const pr = prs.get(c.sha);
    if (!pr) continue;
    const closing = new Set(pr.closingIssuesReferences.nodes.map((n) => `${n.repository.nameWithOwner.toLowerCase()}#${n.number}`));
    mentioned.set(c.sha, bodyReferences(pr.body, repo).filter((r) => !closing.has(refKey(r))));
  }
  const resolved = await resolveReferences(gh, [...mentioned.values()].flat(), repo, warn);
  return commits.map((c) => {
    const pr = prs.get(c.sha);
    if (!pr) return { sha: c.sha, subject: c.subject, pr: null, issues: [] };
    const issues = pr.closingIssuesReferences.nodes.map((n) => ({
      repo: n.repository.nameWithOwner.toLowerCase(), number: n.number, url: n.url, readable: true, title: n.title, state: n.state,
    }));
    for (const r of mentioned.get(c.sha)) {
      const what = resolved.get(refKey(r));
      if (!what) issues.push({ repo: r.repo, number: r.number, url: `${GITHUB}/${r.repo}/issues/${r.number}`, readable: false });
      else if (what.kind === 'issue') issues.push({ repo: r.repo, number: r.number, url: what.url, readable: true, title: what.title, state: what.state });
    }
    return { sha: c.sha, subject: c.subject, pr: { number: pr.number, title: pr.title, url: pr.url }, issues };
  });
}

/** The page of the published GitHub release `tag`; the notification announces one, so it must exist. */
async function releasePage(gh, repo, tag) {
  const r = await gh.get(gh.token, `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (r.status === 404) throw new Error(`${repo} has no published GitHub release ${tag}: the notification announces a release, so there must be one`);
  if (!r.ok || !r.json?.html_url) throw new Error(`reading the GitHub release ${tag} of ${repo}: HTTP ${r.status}`);
  return r.json.html_url;
}

const PIN_LINE = /^\s*revision: &pin ([0-9a-f]{40})\s*$/gm;

/** `images.tags` of a values file, read as text (pingbo's scripts/cloud-roll-pr.cjs readImageTags). */
export function readImageTags(values) {
  const lines = values.split('\n');
  const images = lines.findIndex((l) => /^images:\s*(#.*)?$/.test(l));
  if (images < 0) throw new Error('no top-level images:');
  let i = images + 1;
  for (; i < lines.length && !/^\S/.test(lines[i]); i += 1) if (/^ {2}tags:\s*(#.*)?$/.test(lines[i])) break;
  if (i >= lines.length || !/^ {2}tags:/.test(lines[i])) throw new Error('no images.tags');
  const tags = {};
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = /^ {4}([A-Za-z0-9._-]+):\s*"?([^"\s#]+)"?\s*(#.*)?$/.exec(line);
    if (!m) break;
    tags[m[1]] = m[2];
  }
  if (!Object.keys(tags).length) throw new Error('images.tags is empty');
  return tags;
}

/** What images.tags says a40-prod runs: one release, or not a release. */
export function prodReleaseOf(tags) {
  const values = Object.values(tags);
  const releases = [...new Set(values.filter((v) => parseRelease('a40-v', v)))];
  if (releases.length === 1 && values.every((v) => v === releases[0])) return { kind: 'release', release: releases[0] };
  if (releases.length > 1) throw new Error(`a40-prod's images name more than one release (${releases.join(', ')})`);
  return { kind: 'unreleased' };
}

/** The A40 release a40-prod runs, through the cross-repository token; { known: false } when it cannot be read. */
export async function readProduction(gh, warn = () => {}) {
  if (!gh.crossToken) return { known: false, reason: 'no cross-repository token' };
  const file = async (path, ref) => {
    const r = await gh.get(gh.crossToken, `/repos/${DEPLOY.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!r.ok || typeof r.json?.content !== 'string') throw new Error(`${DEPLOY.repo} ${path} at ${ref}: HTTP ${r.status}`);
    return Buffer.from(r.json.content, 'base64').toString('utf8');
  };
  try {
    const pins = [...(await file(DEPLOY.appset, 'main')).matchAll(PIN_LINE)].map((m) => m[1]);
    if (pins.length !== 1) throw new Error(`${DEPLOY.appset}: expected one \`revision: &pin <sha>\`, found ${pins.length}`);
    return { known: true, pin: pins[0], ...prodReleaseOf(readImageTags(await file(DEPLOY.values, pins[0]))) };
  } catch (e) {
    warn(`what production runs is unknown: ${e.message}`);
    return { known: false, reason: e.message };
  }
}

/** Everything the message says, as plain JSON. */
export async function gather({ product, tag, repoDir = '.', paths = [], github, warn = () => {} }) {
  const cfg = PRODUCTS[product];
  if (!cfg) throw new Error(`unknown product ${JSON.stringify(product)}: want ${Object.keys(PRODUCTS).join(' or ')}`);
  if (!parseRelease(cfg.prefix, tag)) throw new Error(`${JSON.stringify(tag)} is not a ${product} release: want ${cfg.prefix}<MAJOR>.<MINOR>.<PATCH>`);
  const commit = commitOf(repoDir, `refs/tags/${tag}`);
  const previous = previousRelease(repoDir, cfg.prefix, tag, commit);
  const facts = {
    product, repo: cfg.repo, tag, commit, previous,
    releaseUrl: await releasePage(github, cfg.repo, tag),
    paths, changes: [], migrations: null, protos: null, requires: null, production: { known: false },
  };
  if (previous) {
    facts.changes = await describeChanges(github, cfg.repo, commitsBetween(repoDir, previous.commit, commit, paths), warn);
    facts.migrations = addedFiles(repoDir, previous.commit, commit, cfg.migrations).length;
    if (cfg.protos) facts.protos = protoFiles(repoDir, previous.commit, commit).length;
  }
  if (cfg.requirement) facts.requires = requirementAt(repoDir, commit, cfg.requirement, warn);
  if (product === 'a40' || facts.requires) facts.production = await readProduction(github, warn);
  return facts;
}

// ---------------------------------------------------------------------------------- render

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const releaseUrlOf = (repo, tag) => `${GITHUB}/${repo}/releases/tag/${tag}`;

/** The summary line under the header, as mrkdwn parts. */
function summaryParts(facts) {
  const cfg = PRODUCTS[facts.product];
  const parts = [link(`${GITHUB}/${facts.repo}/commit/${facts.commit}`, `${cfg.short}@${facts.commit.slice(0, 9)}`)];
  if (!facts.previous) {
    parts.push('first release');
  } else {
    parts.push(`after ${link(releaseUrlOf(facts.repo, facts.previous.tag), esc(facts.previous.tag))}`);
    parts.push(plural(facts.changes.length, 'change'));
    parts.push(facts.migrations ? plural(facts.migrations, 'migration') : 'no migrations');
    if (facts.protos !== null && facts.protos !== undefined) {
      parts.push(facts.protos ? plural(facts.protos, 'API (proto) file') : 'no API (proto) changes');
    }
  }
  const prod = facts.production;
  const prodRelease = prod?.known && prod.kind === 'release' ? parseRelease('a40-v', prod.release) : null;
  if (facts.product === 'a40' && prod?.known) {
    const cmp = prodRelease ? compareReleases(prodRelease, parseRelease('a40-v', facts.tag)) : -1;
    parts.push(cmp === 0 ? 'production: runs it' : cmp > 0 ? `production: runs ${esc(prod.release)}` : 'production: not yet pinned');
  }
  if (facts.requires) {
    const met = prodRelease && compareReleases(prodRelease, parseRelease('a40-v', facts.requires)) >= 0;
    parts.push(`needs A40 ${link(releaseUrlOf(PRODUCTS.a40.repo, facts.requires), esc(facts.requires))}${met ? ' ✓' : ''}`);
  }
  return parts;
}

/** One change: what it is, and under it the scope, the PR (or commit) and the issues. */
export function describe(change, home) {
  const header = parseHeader(change.subject) || parseHeader(change.pr?.title) || { type: 'other', scope: null };
  return {
    group: groupOf(header.type),
    scope: header.scope,
    text: sentence(change.pr?.title || change.subject),
    order: change.pr ? change.pr.number : -1,
    meta: change.pr
      ? link(change.pr.url, `PR #${change.pr.number}`)
      : link(`${GITHUB}/${home}/commit/${change.sha}`, `commit ${change.sha.slice(0, 9)}`),
    issues: change.issues.map((i) => {
      const label = i.repo === home ? `#${i.number}` : `${i.repo.split('/')[1]}#${i.number}`;
      if (!i.readable) return link(i.url, label);
      return `${link(i.url, `issue ${label}`)} ${esc(issueTitle(i.title))} (${String(i.state).toLowerCase()})`;
    }),
  };
}

/** One item as mrkdwn, within ITEM_MAX: issues that do not fit become "+n more issues". */
function itemText(d) {
  const build = (issues, dropped, title) => {
    const meta = [d.scope && esc(d.scope), d.meta, ...issues, dropped ? `+${plural(dropped, 'more issue')}` : null].filter(Boolean);
    return `• ${esc(title)}\n${INDENT}${meta.join(' · ')}`;
  };
  let issues = d.issues;
  let text = build(issues, 0, d.text);
  while ([...text].length > ITEM_MAX && issues.length) {
    issues = issues.slice(0, -1);
    text = build(issues, d.issues.length - issues.length, d.text);
  }
  if ([...text].length > ITEM_MAX) text = build([], d.issues.length, truncate(d.text, 300));
  return text;
}

/** Lines packed into sections of at most `max` characters, the group heading on the first. */
function pack(heading, lines, max) {
  const sections = [];
  let current = heading;
  for (const line of lines) {
    if ([...current].length + 1 + [...line].length > max) { sections.push(current); current = line; } else current = `${current}\n${line}`;
  }
  sections.push(current);
  return sections;
}

/** The Slack message for `facts`: { text, blocks }. Pure. */
export function render(facts) {
  const cfg = PRODUCTS[facts.product];
  if (!cfg) throw new Error(`unknown product ${facts.product}`);
  const releaseUrl = facts.releaseUrl || releaseUrlOf(facts.repo, facts.tag);
  const header = cfg.header(facts.tag); // within LIMITS.header for every tag parseRelease accepts (tested)
  const summary = summaryParts(facts).join(' · ');
  const sections = [];
  const described = facts.changes.map((c) => describe(c, facts.repo));
  for (const g of GROUPS) {
    // Newest first: by pull request number, then a commit without one in history order.
    const items = described.filter((d) => d.group === g.key).map((d, i) => ({ d, i }))
      .sort((a, b) => b.d.order - a.d.order || a.i - b.i).map(({ d }) => d);
    if (!items.length) continue;
    const lines = items.slice(0, MAX_LINES).map(itemText);
    if (items.length > MAX_LINES) lines.push(link(releaseUrl, `+${items.length - MAX_LINES} more`));
    sections.push(...pack(`*${g.title} (${items.length})*`, lines, LIMITS.section));
  }
  // Header, summary and buttons take three blocks; past the limit the rest is in the release notes.
  const room = LIMITS.blocks - 3;
  if (sections.length > room) sections.splice(room - 1, Infinity, link(releaseUrl, 'The rest is in the release notes'));
  const buttons = [{ type: 'button', text: { type: 'plain_text', text: 'Release notes' }, url: releaseUrl, action_id: 'release_notes' }];
  if (facts.previous) {
    const version = (tag) => tag.slice(cfg.prefix.length - 1);
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: truncate(`Compare ${version(facts.previous.tag)}…${version(facts.tag)}`, LIMITS.buttonText) },
      url: `${GITHUB}/${facts.repo}/compare/${facts.previous.tag}...${facts.tag}`,
      action_id: 'compare',
    });
  }
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: summary }] },
    ...sections.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } })),
    { type: 'actions', elements: buttons },
  ];
  return { text: truncate(`${esc(header)}\n${summary}`, LIMITS.text), blocks };
}

const chars = (s) => [...String(s ?? '')].length;
const httpsUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s<>|]+$/.test(u) && chars(u) <= LIMITS.url;

/** Every way `payload` breaks Block Kit's structure or limits; empty when it is valid. */
export function validatePayload(payload) {
  const problems = [];
  const { text, blocks } = payload || {};
  if (typeof text !== 'string' || !text) problems.push('no text fallback');
  else if (chars(text) > LIMITS.text) problems.push(`text is ${chars(text)} characters (max ${LIMITS.text})`);
  if (!Array.isArray(blocks) || !blocks.length) return [...problems, 'no blocks'];
  if (blocks.length > LIMITS.blocks) problems.push(`${blocks.length} blocks (max ${LIMITS.blocks})`);
  const actionIds = new Set();
  blocks.forEach((b, i) => {
    const at = `block ${i} (${b?.type})`;
    if (b.type === 'header') {
      if (b.text?.type !== 'plain_text' || !b.text.text) problems.push(`${at}: a header needs plain_text`);
      else if (chars(b.text.text) > LIMITS.header) problems.push(`${at}: ${chars(b.text.text)} characters (max ${LIMITS.header})`);
    } else if (b.type === 'section') {
      if (b.text?.type !== 'mrkdwn' || !b.text.text) problems.push(`${at}: a section needs mrkdwn text`);
      else if (chars(b.text.text) > LIMITS.section) problems.push(`${at}: ${chars(b.text.text)} characters (max ${LIMITS.section})`);
    } else if (b.type === 'context') {
      if (!Array.isArray(b.elements) || !b.elements.length || b.elements.length > LIMITS.contextElements) problems.push(`${at}: 1 to ${LIMITS.contextElements} elements`);
      else b.elements.forEach((e) => {
        if (e.type !== 'mrkdwn' && e.type !== 'plain_text') problems.push(`${at}: element type ${e.type}`);
        else if (!e.text || chars(e.text) > LIMITS.contextText) problems.push(`${at}: element text of ${chars(e.text)} characters`);
      });
    } else if (b.type === 'actions') {
      if (!Array.isArray(b.elements) || !b.elements.length || b.elements.length > LIMITS.actionElements) problems.push(`${at}: 1 to ${LIMITS.actionElements} elements`);
      else b.elements.forEach((e) => {
        if (e.type !== 'button') problems.push(`${at}: element type ${e.type}`);
        if (e.text?.type !== 'plain_text' || !e.text.text || chars(e.text.text) > LIMITS.buttonText) problems.push(`${at}: button text must be plain_text of 1 to ${LIMITS.buttonText} characters`);
        if (!httpsUrl(e.url)) problems.push(`${at}: button url ${JSON.stringify(e.url)} is not an https URL of at most ${LIMITS.url} characters`);
        if (!e.action_id || chars(e.action_id) > LIMITS.actionId || actionIds.has(e.action_id)) problems.push(`${at}: action_id ${JSON.stringify(e.action_id)} must be unique, 1 to ${LIMITS.actionId} characters`);
        actionIds.add(e.action_id);
      });
    } else {
      problems.push(`${at}: not a block this message uses`);
    }
  });
  const mrkdwn = blocks.flatMap((b) => [b.text?.type === 'mrkdwn' ? b.text.text : null, ...(b.elements || []).map((e) => (e.type === 'mrkdwn' ? e.text : null))]).filter(Boolean);
  for (const t of [text, ...mrkdwn]) {
    // Every < opens a link we made: an escaped title cannot open one, or a mention (<@…>, <!here>).
    for (const m of String(t ?? '').matchAll(/<([^<>]*)>?/g)) {
      if (!/^<https:\/\/[^\s<>|]+\|[^<>]+>$/.test(m[0])) problems.push(`raw markup ${JSON.stringify(m[0].slice(0, 40))}`);
    }
  }
  return problems;
}

/** The message as it reads in Slack, as plain text: the golden rendering, and the dry run's summary. */
export function toPlainText({ blocks }) {
  const plain = (mrkdwn) => String(mrkdwn).split('\n').map((l) => l.replace(/^\*(.+)\*$/, '$1')).join('\n')
    .replace(/<([^|<>]+)\|([^<>]+)>/g, '$2')
    .replace(/\u00a0/g, ' ').replace(/\u200b/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const out = [];
  for (const b of blocks) {
    if (b.type === 'header') out.push(b.text.text);
    else if (b.type === 'context') out.push(b.elements.map((e) => plain(e.text)).join(' '));
    else if (b.type === 'section') out.push('', plain(b.text.text));
    else if (b.type === 'actions') out.push('', b.elements.map((e) => `[ ${e.text.text} ]`).join('  '));
  }
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------- CLI

const FLAGS = new Set(['product', 'tag', 'paths', 'channel', 'repo-dir', 'out', 'facts']);

export function parseArgs(argv) {
  const args = { 'dry-run': false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') { args['dry-run'] = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    if (!m || !FLAGS.has(m[1])) throw new Error(`unknown argument ${a}`);
    if (m[2] !== undefined) args[m[1]] = m[2];
    else { args[m[1]] = argv[i + 1]; i += 1; }
    if (args[m[1]] === undefined) throw new Error(`--${m[1]} needs a value`);
  }
  return args;
}

/** A newline-separated pathspec list (the workflow input), blank lines and surrounding space dropped. */
export function splitPaths(value) {
  return String(value ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
}

/** The entry point; returns the exit code. */
export async function main(argv = process.argv.slice(2), env = process.env, { fetch: send = globalThis.fetch, log = console.log } = {}) {
  const args = parseArgs(argv);
  const warn = (m) => log(`::warning::${m}`);
  let facts;
  if (args.facts) {
    facts = JSON.parse(readFileSync(args.facts, 'utf8'));
  } else {
    const cfg = PRODUCTS[args.product];
    if (!cfg) throw new Error(`--product must be ${Object.keys(PRODUCTS).join(' or ')}`);
    if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY.toLowerCase() !== cfg.repo) {
      throw new Error(`product ${args.product} is released from ${cfg.repo}, but this run is in ${env.GITHUB_REPOSITORY}`);
    }
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set: the caller's token reads its pull requests, issues and release");
    const github = githubClient({ token: env.GITHUB_TOKEN, crossToken: env.CROSS_REPO_TOKEN || null, fetch: send, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });
    facts = await gather({ product: args.product, tag: args.tag, repoDir: args['repo-dir'] || '.', paths: splitPaths(args.paths), github, warn });
  }
  const payload = render(facts);
  const problems = validatePayload(payload);
  if (problems.length) throw new Error(`the message breaks Slack's Block Kit limits: ${problems.join('; ')}`);
  const channel = args.channel || DEFAULT_CHANNEL;
  const body = messageBody({ channel, ...payload });
  const text = toPlainText(payload);
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, `${facts.tag}.txt`), text);
    writeFileSync(join(args.out, `${facts.tag}.json`), `${JSON.stringify(body, null, 2)}\n`);
    writeFileSync(join(args.out, `${facts.tag}.facts.json`), `${JSON.stringify(facts, null, 2)}\n`);
  }
  log(text);
  const token = env.SLACK_BOT_TOKEN;
  if (args['dry-run'] || !token) {
    const notice = token ? 'Dry run: not posted' : NO_TOKEN_NOTICE;
    log(`::notice::${notice}`);
    appendSummary([
      `### ${notice}`, '', `The message for channel \`${channel}\`:`, '', fence(text, 'text'), '',
      '<details><summary>chat.postMessage payload</summary>', '', fence(JSON.stringify(body, null, 2), 'json'), '', '</details>',
    ].join('\n'), env);
    return 0;
  }
  const posted = await postMessage({ token, channel, text: payload.text, blocks: payload.blocks, fetch: send, log });
  reportPosted(posted, env, log);
  appendSummary(fence(text, 'text'), env);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    const secrets = [process.env.SLACK_BOT_TOKEN, process.env.GITHUB_TOKEN, process.env.CROSS_REPO_TOKEN];
    console.error(`::error::${secrets.reduce((m, s) => redact(m, s), e.message)}`);
    process.exitCode = 1;
  });
}

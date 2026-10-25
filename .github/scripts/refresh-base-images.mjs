#!/usr/bin/env node
// refresh-base-images.mjs — the CVE patch routine's base-image refresh (design T1: "a base-image
// digest refresh within its tag"). Deterministic: no agent, no dependencies (Node 22).
//
//   node refresh-base-images.mjs [--dry-run] [--group <group.json>] [--report <report.json>]
//                                [--body <body.md>] [<Dockerfile> …]
//
// For each Dockerfile (the positional paths, or the group's `paths`):
//   1. every `FROM [--flag=… …] <ref>@sha256:<old> [AS <stage>]` and `ARG <NAME>=<ref>@sha256:<old>`
//      is a pin. `${VAR}` / `$VAR` in <ref> expands from the file's own `ARG VAR=default` lines, by
//      Docker's scoping (a FROM sees the ARGs declared before the first FROM); a variable with no
//      default in the file skips that line with a notice.
//   2. the tag's CURRENT digest is read from its registry over the v2 API with anonymous auth
//      (`HEAD /v2/<name>/manifests/<tag>`, Accept: index, manifest list, OCI and Docker v2 manifest;
//      `Docker-Content-Digest`). Docker Hub's token comes from auth.docker.io; every other registry
//      (gcr.io, ghcr.io, *.pkg.dev, …) names its token realm in the 401 challenge.
//   3. a digest that moved is rewritten on every pin line of that ref, at its exact position: the
//      `--platform=…` flag, the `AS <stage>`, the spacing and every other byte stay as they were.
//
// Outputs: the report (JSON: bumps, current, skipped, failed), the PR body for the group (Markdown),
// `moved=` and `bumps=` to $GITHUB_OUTPUT, the step summary, and workflow-command notices. Nothing
// moved and nothing failed → `::notice::base images are current for <files>; <N> fixable findings
// wait on upstream`, exit 0, no file touched. A lookup that failed with nothing moved → exit 1:
// "current" is not claimed on evidence the run could not read.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const DIGEST = /^sha256:[0-9a-f]{64}$/;
// `FROM [--flag …] <ref>@sha256:<64 hex>` then whitespace or the end of the line (`AS <stage>` follows).
const FROM_PIN = /^(\s*FROM\s+(?:--\S+\s+)*)([^\s@]+)@(sha256:[0-9a-f]{64})(?=\s|$)/i;
// `ARG <NAME>=<ref>@sha256:<64 hex>`, optionally double-quoted.
const ARG_PIN = /^(\s*ARG\s+)([A-Za-z_][A-Za-z0-9_]*)=("?)([^\s"@]+)@(sha256:[0-9a-f]{64})\3(?=\s|$)/i;
const FROM_LINE = /^\s*FROM\s/i;
const ARG_LINE = /^\s*ARG\s+(.*)$/i;
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expand `${V}`, `$V`, `${V:-word}` and `${V-word}` from `vars`; names it could not expand are `missing`. */
export function expandVars(text, vars) {
  const missing = [];
  const value = String(text).replace(VAR, (m, braced, op, word, bare) => {
    const name = braced || bare;
    const has = Object.prototype.hasOwnProperty.call(vars, name);
    const v = has ? vars[name] : undefined;
    if (op === ':-' && (!has || v === '')) return word;
    if (op === '-' && !has) return word;
    if (has) return v;
    missing.push(name);
    return m;
  });
  return { value, missing };
}

const unquote = (s) => (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'")) ? s.slice(1, -1) : s);

/** `ARG A B=1 C="x"` → [['A', undefined], ['B', '1'], ['C', 'x']]. */
function argDeclarations(rest) {
  return rest.trim().split(/\s+/).filter(Boolean).map((tok) => {
    const eq = tok.indexOf('=');
    return eq < 0 ? [tok, undefined] : [tok.slice(0, eq), unquote(tok.slice(eq + 1))];
  }).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/**
 * `[registry/]repository[:tag]` (no digest) → { registry, repository, tag }. Docker Hub names are
 * normalised (`node` → docker.io `library/node`); `tag` is '' when the ref names none.
 */
export function parseImageRef(ref) {
  let rest = String(ref);
  let registry = 'docker.io';
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') { registry = first; rest = rest.slice(slash + 1); }
  }
  let tag = '';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  return { registry, repository: rest, tag };
}

/** Every digest pin in a Dockerfile's text, with its ref expanded (or the reason it cannot be). */
export function findPins(text) {
  const lines = String(text).split('\n');
  const globals = {};
  let stage = null;                                // null before the first FROM
  const pins = [];
  // A stage's bare `ARG NAME` takes the global default; `ARG NAME=value` sets it in the current scope.
  const declare = (vars, decls) => {
    for (const [name, def] of decls) {
      if (def === undefined) { if (stage && Object.prototype.hasOwnProperty.call(globals, name)) vars[name] = globals[name]; }
      else vars[name] = expandVars(def, vars).value;
    }
  };
  lines.forEach((line, i) => {
    const from = FROM_PIN.exec(line);
    if (from) {
      const [, lead, raw, old] = from;
      const { value, missing } = expandVars(raw, globals);
      pins.push({ line: i + 1, kind: 'FROM', raw, ref: value, old, missing, at: lead.length + raw.length + 1 });
    }
    if (FROM_LINE.test(line)) { stage = {}; return; }
    const argPin = ARG_PIN.exec(line);
    if (argPin) {
      const [, lead, name, quote, raw, old] = argPin;
      const { value, missing } = expandVars(raw, stage || globals);
      pins.push({ line: i + 1, kind: 'ARG', name, raw, ref: value, old, missing, at: lead.length + name.length + 1 + quote.length + raw.length + 1 });
    }
    const arg = ARG_LINE.exec(line);
    if (arg) declare(stage || globals, argDeclarations(arg[1]));
  });
  return pins;
}

function parseChallenge(header) {
  const h = String(header || '');
  const m = /^\s*(\w+)\s+(.*)$/.exec(h);
  if (!m) return null;
  const params = {};
  for (const [, k, v] of m[2].matchAll(/(\w+)="([^"]*)"/g)) params[k.toLowerCase()] = v;
  return { scheme: m[1].toLowerCase(), ...params };
}

/**
 * The digest a tag points at now. `fetch` is injectable (tests run without the network).
 * @param {{registry: string, repository: string, tag: string}} ref
 */
export async function resolveDigest(ref, { fetch: f = globalThis.fetch, tokens = new Map(), timeoutMs = 20000, retryDelayMs = 2000 } = {}) {
  const host = ref.registry === 'docker.io' ? 'registry-1.docker.io' : ref.registry;
  const url = `https://${host}/v2/${ref.repository}/manifests/${ref.tag}`;
  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  const call = async (u, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await f(u, { ...init, signal: signal() });
        if (res.status >= 500 && attempt === 0) { await new Promise((r) => setTimeout(r, retryDelayMs)); continue; }
        return res;
      } catch (e) {
        if (attempt > 0) throw new Error(`${u}: ${e.message}`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  };
  const token = async (realm, service, scope) => {
    const key = `${realm} ${service} ${scope}`;
    if (tokens.has(key)) return tokens.get(key);
    const u = new URL(realm);
    if (service) u.searchParams.set('service', service);
    u.searchParams.set('scope', scope);
    const res = await call(u.href, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`token ${u.origin}${u.pathname}: HTTP ${res.status}`);
    const body = await res.json();
    const t = body.token || body.access_token;
    if (!t) throw new Error(`token ${u.origin}${u.pathname}: no token in the response`);
    tokens.set(key, t);
    return t;
  };
  const head = (bearer) => call(url, { method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });

  let res;
  if (ref.registry === 'docker.io') {
    // Docker Hub always wants a token; ask auth.docker.io for it up front.
    res = await head(await token('https://auth.docker.io/token', 'registry.docker.io', `repository:${ref.repository}:pull`));
  } else {
    res = await head(null);
    if (res.status === 401) {
      const ch = parseChallenge(res.headers.get('www-authenticate'));
      if (!ch || ch.scheme !== 'bearer' || !ch.realm) throw new Error(`${url}: HTTP 401 without a bearer challenge`);
      res = await head(await token(ch.realm, ch.service, ch.scope || `repository:${ref.repository}:pull`));
    }
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const digest = String(res.headers.get('docker-content-digest') || '').trim();
  if (!DIGEST.test(digest)) throw new Error(`${url}: no sha256 Docker-Content-Digest in the response`);
  return digest;
}

const isRelativePath = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '');

/**
 * Refresh the digests in `files`. `read`/`write` default to the filesystem, `resolve` to the
 * registry lookup; each distinct ref is looked up once.
 * @returns {Promise<{bumps: object[], current: object[], skipped: object[], failed: object[], changed: string[]}>}
 */
export async function refreshDockerfiles(files, { read = (p) => readFileSync(p, 'utf8'), write = (p, t) => writeFileSync(p, t), resolve = resolveDigest, dryRun = false } = {}) {
  const report = { bumps: [], current: [], skipped: [], failed: [], changed: [] };
  const lookups = new Map();                                       // "registry/repository:tag" → Promise<digest>
  const lookup = (parsed) => {
    const k = `${parsed.registry}/${parsed.repository}:${parsed.tag}`;
    if (!lookups.has(k)) lookups.set(k, resolve(parsed).then((digest) => ({ digest }), (error) => ({ error: error.message || String(error) })));
    return lookups.get(k);
  };
  for (const file of [...new Set(files)]) {
    if (!isRelativePath(file)) { report.failed.push({ file, reason: 'not a relative path inside the checkout' }); continue; }
    let text;
    try { text = read(file); } catch (e) { report.failed.push({ file, reason: `cannot read the file (${e.code || e.message})` }); continue; }
    const pins = findPins(text);
    if (!pins.length) { report.skipped.push({ file, reason: 'no digest-pinned FROM or ARG' }); continue; }
    const lines = text.split('\n');
    const bumpsHere = new Map();                                   // "ref old" → bump
    for (const pin of pins) {
      const where = { file, line: pin.line, kind: pin.kind, raw: pin.raw };
      if (pin.missing.length) { report.skipped.push({ ...where, reason: `\${${pin.missing[0]}} has no default in the file` }); continue; }
      const parsed = parseImageRef(pin.ref);
      if (!parsed.tag) { report.skipped.push({ ...where, ref: pin.ref, reason: 'no tag to refresh within' }); continue; }
      const got = await lookup(parsed);
      const image = pin.ref.slice(0, pin.ref.length - parsed.tag.length - 1);
      if (got.error) { report.failed.push({ ...where, ref: pin.ref, reason: got.error }); continue; }
      if (got.digest === pin.old) { report.current.push({ ...where, ref: image, tag: parsed.tag, digest: pin.old }); continue; }
      const line = lines[pin.line - 1];
      lines[pin.line - 1] = line.slice(0, pin.at) + got.digest + line.slice(pin.at + pin.old.length);
      const key = `${pin.ref} ${pin.old}`;
      if (!bumpsHere.has(key)) bumpsHere.set(key, { file, ref: image, tag: parsed.tag, old: pin.old, new: got.digest, lines: [] });
      bumpsHere.get(key).lines.push(pin.line);
    }
    if (bumpsHere.size) {
      report.bumps.push(...bumpsHere.values());
      report.changed.push(file);
      if (!dryRun) write(file, lines.join('\n'));
    }
  }
  return report;
}

const short = (d) => String(d || '').slice(0, 19);            // sha256: + 12 hex
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The notices for a finished run: { lines, ok } — ok is false when nothing moved because a lookup failed. */
export function runNotices(files, report, fixableCount) {
  const lines = [];
  for (const s of report.skipped) lines.push(`::notice::cve-patch: ${s.file}${s.line ? `:${s.line}` : ''}: ${s.raw ? `skipped ${s.raw} — ` : ''}${s.reason}`);
  for (const f of report.failed) lines.push(`::warning::cve-patch: ${f.file}${f.line ? `:${f.line}` : ''}: ${f.ref ? `could not read the current digest of ${f.ref} — ` : ''}${f.reason}`);
  if (report.bumps.length) {
    lines.push(`::notice::cve-patch: refreshed ${plural(report.bumps.length, 'base-image digest', 'base-image digests')} in ${plural(report.changed.length, 'Dockerfile', 'Dockerfiles')}: ${report.bumps.map((b) => `${b.ref}:${b.tag} ${short(b.old)} → ${short(b.new)} (${b.file})`).join('; ')}`);
    return { lines, ok: true };
  }
  if (report.failed.length) {
    lines.push(`::error::cve-patch: nothing refreshed and ${plural(report.failed.length, 'lookup or file', 'lookups or files')} could not be read — not claiming the base images of ${files.join(', ')} are current`);
    return { lines, ok: false };
  }
  lines.push(`::notice::base images are current for ${files.join(', ')}; ${fixableCount} fixable findings wait on upstream`);
  return { lines, ok: true };
}

/** The step summary (Markdown). */
export function stepSummary(files, report, fixableCount) {
  const out = ['### CVE patch — base-image refresh', ''];
  if (report.bumps.length) {
    out.push('| Dockerfile | image:tag | old | new | lines |', '|---|---|---|---|---|');
    for (const b of report.bumps) out.push(`| \`${b.file}\` | \`${b.ref}:${b.tag}\` | \`${b.old}\` | \`${b.new}\` | ${b.lines.join(', ')} |`);
  } else if (!report.failed.length) {
    out.push(`Base images are current for ${files.map((f) => `\`${f}\``).join(', ')}; ${fixableCount} fixable findings wait on upstream. No commit, no PR.`);
  } else {
    out.push(`Nothing refreshed; ${plural(report.failed.length, 'lookup or file', 'lookups or files')} could not be read, so the base images are not claimed current.`);
  }
  for (const f of report.failed) out.push(`- Not read: \`${f.file}\`${f.line ? `:${f.line}` : ''}${f.ref ? ` \`${f.ref}\`` : ''} — ${f.reason}`);
  for (const s of report.skipped) out.push(`- Skipped: \`${s.file}\`${s.line ? `:${s.line}` : ''}${s.raw ? ` \`${s.raw}\`` : ''} — ${s.reason}`);
  return `${out.join('\n')}\n`;
}

/** The PR body for a base-image group: Because (the pinned images and their findings) / This commit (the bumps, the proof). */
export function renderPrBody({ group, report, runUrl = '' }) {
  const severity = String(group.severity || 'unknown');
  const images = Array.isArray(group.images) ? group.images : [];
  const n = (group.advisories || []).length;
  const because = [
    `- The production images below carry ${plural(group.fixableCount || 0, 'CRITICAL or HIGH finding', 'CRITICAL or HIGH findings')} with a fixed version (worst: ${severity}; ${plural(n, 'advisory', 'advisories')}, none in the exceptions ledger${group.firstSeen ? `; first seen ${group.firstSeen}` : ''}), read by GCP Container Scanning in the patrol's \`container_scanning.pinned\`. OS packages come from the base images, which no lockfile here names.`,
  ];
  for (const im of images) {
    const pd = im.platform_digests || {};
    const plats = Object.entries(pd).map(([p, d]) => `${p} \`${d}\``).join(', ');
    const counts = im.fixable && typeof im.fixable === 'object'
      ? ` Fixable: ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].filter((s) => im.fixable[s] != null).map((s) => `${s} ${im.fixable[s]}`).join(' · ')}.`
      : '';
    because.push(`- \`${im.key}\` (${(im.dockerfiles || []).map((d) => `\`${d}\``).join(', ')}): ${im.reference ? `\`${im.reference}\`, ` : ''}index \`${im.index_digest || 'unknown'}\`${plats ? ` (${plats})` : ''}${im.scanned ? `, scanned ${im.scanned}` : ''}${im.complete ? '' : ', read incompletely'}.${counts}`);
    for (const f of im.findings || []) because.push(`  - ${f.id || '(no id)'} \`${f.pkg}\` ${f.installed || '?'} → ${f.fixed} (${f.severity})`);
    if (im.more) because.push(`  - … and ${im.more} more`);
  }
  const thisCommit = report.bumps.map((b) => `- Refresh \`${b.ref}:${b.tag}\` \`${b.old}\` → \`${b.new}\` in \`${b.file}\` (line${b.lines.length === 1 ? '' : 's'} ${b.lines.join(', ')}), within its tag.`);
  const current = [...new Set(report.current.map((c) => `\`${c.ref}:${c.tag}\` in \`${c.file}\``))];
  if (current.length) thisCommit.push(`- Unchanged — the tag still points at the pinned digest: ${current.join(', ')}.`);
  for (const f of report.failed) thisCommit.push(`- Not refreshed: \`${f.file}\`${f.line ? `:${f.line}` : ''}${f.ref ? ` \`${f.ref}\`` : ''} — ${f.reason}.`);
  for (const s of report.skipped) thisCommit.push(`- Skipped: \`${s.file}\`${s.line ? `:${s.line}` : ''}${s.raw ? ` \`${s.raw}\`` : ''} — ${s.reason}.`);
  thisCommit.push(
    "- The caller's `fast_checks` were not run: they prove lockfile bumps, and this change moves only `FROM`/`ARG` digests. The proof is the repository's image workflow, which builds both platforms (linux/amd64 and linux/arm64) on a Dockerfile PR; the findings are re-read by the patrol after the next publish.",
    "- A refresh moves only to what upstream has published under the same tag: a finding whose fix upstream has not shipped yet, or one in the application's own dependencies (the lockfile groups patch those), stays after this merges.",
  );
  const refs = report.bumps.length;
  return [
    '**Because**', '',
    ...because, '',
    '**This commit**', '',
    ...thisCommit, '',
    '<!-- slack:start -->',
    `*CVE patch* · ${String(group.tier || 't1').toUpperCase()} · ${severity.toUpperCase()} base images: ${plural(refs, 'digest', 'digests')} refreshed in ${plural(report.changed.length, 'Dockerfile', 'Dockerfiles')}, ${plural(n, 'advisory', 'advisories')}`,
    '_ready for review_',
    '<!-- slack:end -->', '',
    `Opened by the A40 CVE patch routine (\`.github/workflows/cve-patch.yml\`)${runUrl ? `: ${runUrl}` : ''}`, '',
    '🤖 Generated by the A40 CVE patch routine\'s base-image refresh (`.github/scripts/refresh-base-images.mjs`; deterministic, no agent)',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { dryRun: false, group: '', report: '', body: '', files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--group' || a === '--report' || a === '--body') opts[a.slice(2)] = argv[++i] || '';
    else if (a === '--') opts.files.push(...argv.slice(i + 1)), (i = argv.length);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

/** The CLI. Returns the exit code. */
export async function main(argv, { env = process.env, log = (l) => console.log(l), resolve = resolveDigest, read, write } = {}) {
  const opts = parseArgs(argv);
  const group = opts.group ? JSON.parse(readFileSync(opts.group, 'utf8')) : {};
  const files = opts.files.length ? opts.files : (Array.isArray(group.paths) ? group.paths : []);
  if (!files.length) { log('::error::cve-patch: refresh-base-images: no Dockerfile given (positional paths, or --group with paths)'); return 1; }
  const report = await refreshDockerfiles(files, { resolve, dryRun: opts.dryRun, ...(read ? { read } : {}), ...(write ? { write } : {}) });
  const fixable = Number(group.fixableCount) || 0;
  const { lines, ok } = runNotices(files, report, fixable);
  for (const l of lines) log(l);
  if (opts.report) writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.body && report.bumps.length) writeFileSync(opts.body, `${renderPrBody({ group, report, runUrl: env.RUN_URL || '' })}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `moved=${report.bumps.length ? 'true' : 'false'}\nbumps=${report.bumps.length}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummary(files, report, fixable));
  if (opts.dryRun) log(JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.log(`::error::cve-patch: refresh-base-images: ${e.message}`); process.exitCode = 1; });
}

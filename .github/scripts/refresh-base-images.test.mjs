// node --test ".github/scripts/*.test.mjs" — the deterministic base-image refresh. No network: the registry is
// an injected fetch, the filesystem a map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPins, parseImageRef, expandVars, resolveDigest, refreshDockerfiles, runNotices, stepSummary, renderPrBody, main, MANIFEST_ACCEPT,
} from './refresh-base-images.mjs';

const OLD = {
  golang: 'sha256:f96cc555eb8db430159a3aa6797cd5bae561945b7b0fe7d0e284c63a3b291609',
  static: 'sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab',
  bookworm: 'sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8',
  base: 'sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5',
  krakend: 'sha256:f8bdaa8a1a43e157cdebadc8050f4bc8bf1432c29572968e0421c800ba590116',
  node24: 'sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53',
  node20: 'sha256:357deca6eb61149534d32faaf5e4b2e4fa3549c2be610ee1019bf340ea8c51ec',
  nodejs20: 'sha256:2cd820156cf039c8b54ae2d2a97e424b6729070714de8707a6b79f20d56f6a9a',
};
const NEW = (c) => `sha256:${c.repeat(64)}`;

// Excerpts of the real Dockerfiles (backend, shubo, pingbo; 25 October), every pin shape kept.
const AGENT = `ARG GOLANG_VERSION=1.26.4

FROM --platform=$BUILDPLATFORM golang:\${GOLANG_VERSION}@${OLD.golang} AS build
ARG SERVICE_NAME SERVICE_VERSION TARGETOS TARGETARCH
RUN go build ./...

FROM gcr.io/distroless/static-debian12:nonroot@${OLD.static}
ARG SERVICE_NAME SERVICE_VERSION
`;
const GATEWAY = `ARG GOLANG_VERSION=1.26.4
ARG KRAKEND_CE_VERSION=2.13.7

# Minimal glibc runtime base.
ARG RUNTIME_BASE=gcr.io/distroless/base-debian12:nonroot

FROM --platform=$BUILDPLATFORM golang:\${GOLANG_VERSION}@${OLD.golang} AS build
ARG SERVICE_NAME SERVICE_VERSION KRAKEND_CE_VERSION GOLANG_VERSION

FROM \${RUNTIME_BASE}@${OLD.base}
ARG SERVICE_NAME SERVICE_VERSION
`;
const RENDERER = `ARG KRAKEND_RENDER_VERSION=2.9.4

FROM devopsfaith/krakend:\${KRAKEND_RENDER_VERSION}@${OLD.krakend}
`;
const MODEL = `ARG GOLANG_VERSION=1.26.4
FROM --platform=$BUILDPLATFORM golang:\${GOLANG_VERSION}-bookworm@${OLD.golang} AS base-deps
FROM base-deps AS onnx-runtime
FROM --platform=$BUILDPLATFORM debian:bookworm-slim@${OLD.bookworm} AS codex
FROM debian:bookworm-slim@${OLD.bookworm}
`;
const CONSOLE = `ARG NODE_OPTIONS=--max-old-space-size=8192
ARG PNPM_VERSION=10.30.3

FROM --platform=$BUILDPLATFORM node:24-alpine@${OLD.node24} AS pruner
ARG PNPM_VERSION
FROM --platform=$BUILDPLATFORM node:24-alpine@${OLD.node24} AS deps
FROM --platform=$BUILDPLATFORM node:24-alpine@${OLD.node24} AS builder
FROM --platform=$BUILDPLATFORM node:24-alpine@${OLD.node24} AS standalone
FROM node:24-alpine@${OLD.node24} AS runner
`;
const SERVER = `# The build stage's base is an argument.
ARG NODE_IMAGE=node:20.11-bookworm-slim@${OLD.node20}

FROM \${NODE_IMAGE} AS build
RUN npm ci

FROM gcr.io/distroless/nodejs20-debian12:nonroot@${OLD.nodejs20} AS runtime
`;

/** A resolver over a table "registry/repository:tag" → digest; anything else throws. */
const table = (t) => async (ref) => {
  const k = `${ref.registry}/${ref.repository}:${ref.tag}`;
  if (!(k in t)) throw new Error(`no such tag ${k}`);
  return t[k];
};
const fsMap = (files) => {
  const disk = { ...files };
  const writes = [];
  return { disk, writes, read: (p) => { if (!(p in disk)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return disk[p]; }, write: (p, t) => { writes.push(p); disk[p] = t; } };
};
const ALL_CURRENT = {
  'docker.io/library/golang:1.26.4': OLD.golang,
  'docker.io/library/golang:1.26.4-bookworm': OLD.golang,
  'gcr.io/distroless/static-debian12:nonroot': OLD.static,
  'gcr.io/distroless/base-debian12:nonroot': OLD.base,
  'docker.io/devopsfaith/krakend:2.9.4': OLD.krakend,
  'docker.io/library/debian:bookworm-slim': OLD.bookworm,
  'docker.io/library/node:24-alpine': OLD.node24,
  'docker.io/library/node:20.11-bookworm-slim': OLD.node20,
  'gcr.io/distroless/nodejs20-debian12:nonroot': OLD.nodejs20,
};

// ── Parsing ──────────────────────────────────────────────────────────────────────────────
test('every pin shape is found, with its ref expanded from the file\'s own ARG defaults', () => {
  const pick = (t) => findPins(t).map((p) => [p.line, p.kind, p.ref, p.old, p.missing]);
  assert.deepEqual(pick(AGENT), [[3, 'FROM', 'golang:1.26.4', OLD.golang, []], [7, 'FROM', 'gcr.io/distroless/static-debian12:nonroot', OLD.static, []]]);
  assert.deepEqual(pick(GATEWAY), [[7, 'FROM', 'golang:1.26.4', OLD.golang, []], [10, 'FROM', 'gcr.io/distroless/base-debian12:nonroot', OLD.base, []]]);
  assert.deepEqual(pick(RENDERER), [[3, 'FROM', 'devopsfaith/krakend:2.9.4', OLD.krakend, []]]);
  assert.deepEqual(pick(MODEL).map((p) => p.slice(0, 3)), [[2, 'FROM', 'golang:1.26.4-bookworm'], [4, 'FROM', 'debian:bookworm-slim'], [5, 'FROM', 'debian:bookworm-slim']]);
  assert.deepEqual(pick(CONSOLE).map((p) => p[0]), [4, 6, 7, 8, 9]);
  assert.deepEqual(pick(SERVER), [[2, 'ARG', 'node:20.11-bookworm-slim', OLD.node20, []], [7, 'FROM', 'gcr.io/distroless/nodejs20-debian12:nonroot', OLD.nodejs20, []]]);
});

test('a FROM sees only the ARGs declared before the first FROM (Docker\'s scoping)', () => {
  const text = `FROM alpine:3.20@${OLD.static} AS one\nARG LATE=debian:bookworm-slim\nFROM \${LATE}@${OLD.bookworm}\n`;
  assert.deepEqual(findPins(text)[1].missing, ['LATE']);
  // A stage's bare ARG inherits the global default, and an ARG pin inside a stage expands with it.
  const staged = `ARG TAG=bookworm-slim\nFROM scratch\nARG TAG\nARG BASE=debian:\${TAG}@${OLD.bookworm}\n`;
  assert.equal(findPins(staged)[0].ref, 'debian:bookworm-slim');
});

test('variables: ${V}, $V, ${V:-word} and ${V-word}; an undefined one is reported, not guessed', () => {
  assert.deepEqual(expandVars('a:${V}-$W', { V: '1', W: '2' }), { value: 'a:1-2', missing: [] });
  assert.deepEqual(expandVars('${V:-x}${U:-y}${E:-z}${E-q}', { V: '1', E: '' }), { value: '1yz', missing: [] });
  assert.deepEqual(expandVars('golang:${GOLANG_VERSION}', {}), { value: 'golang:${GOLANG_VERSION}', missing: ['GOLANG_VERSION'] });
});

test('refs: Docker Hub names normalise to library/, other registries keep their host', () => {
  assert.deepEqual(parseImageRef('node:24-alpine'), { registry: 'docker.io', repository: 'library/node', tag: '24-alpine' });
  assert.deepEqual(parseImageRef('devopsfaith/krakend:2.9.4'), { registry: 'docker.io', repository: 'devopsfaith/krakend', tag: '2.9.4' });
  assert.deepEqual(parseImageRef('docker.io/library/debian:bookworm-slim'), { registry: 'docker.io', repository: 'library/debian', tag: 'bookworm-slim' });
  assert.deepEqual(parseImageRef('index.docker.io/node:20'), { registry: 'docker.io', repository: 'library/node', tag: '20' });
  assert.deepEqual(parseImageRef('gcr.io/distroless/static-debian12:nonroot'), { registry: 'gcr.io', repository: 'distroless/static-debian12', tag: 'nonroot' });
  assert.deepEqual(parseImageRef('ghcr.io/a40-labs/tool:v1'), { registry: 'ghcr.io', repository: 'a40-labs/tool', tag: 'v1' });
  assert.deepEqual(parseImageRef('localhost:5000/x/y'), { registry: 'localhost:5000', repository: 'x/y', tag: '' });
});

// ── Rewriting ────────────────────────────────────────────────────────────────────────────
test('the repeated node:24-alpine ref moves in all five stages; --platform and AS stay byte for byte', async () => {
  const fs = fsMap({ 'apps/console/Dockerfile.monorepo': CONSOLE });
  const report = await refreshDockerfiles(['apps/console/Dockerfile.monorepo'], { ...fs, resolve: table({ ...ALL_CURRENT, 'docker.io/library/node:24-alpine': NEW('1') }) });
  assert.equal(fs.disk['apps/console/Dockerfile.monorepo'], CONSOLE.replaceAll(OLD.node24, NEW('1')));
  assert.match(fs.disk['apps/console/Dockerfile.monorepo'], new RegExp(`^FROM --platform=\\$BUILDPLATFORM node:24-alpine@${NEW('1')} AS pruner$`, 'm'));
  assert.deepEqual(report.bumps, [{ file: 'apps/console/Dockerfile.monorepo', ref: 'node', tag: '24-alpine', old: OLD.node24, new: NEW('1'), lines: [4, 6, 7, 8, 9] }]);
  assert.deepEqual(report.changed, ['apps/console/Dockerfile.monorepo']);
});

test('${RUNTIME_BASE}@sha256 moves on its FROM line; the ARG default (no digest) is left as written', async () => {
  const fs = fsMap({ 'dockerfiles/api-gateway.Dockerfile': GATEWAY });
  const report = await refreshDockerfiles(['dockerfiles/api-gateway.Dockerfile'], { ...fs, resolve: table({ ...ALL_CURRENT, 'gcr.io/distroless/base-debian12:nonroot': NEW('2') }) });
  const after = fs.disk['dockerfiles/api-gateway.Dockerfile'];
  assert.equal(after, GATEWAY.replace(`FROM \${RUNTIME_BASE}@${OLD.base}`, `FROM \${RUNTIME_BASE}@${NEW('2')}`));
  assert.match(after, /^ARG RUNTIME_BASE=gcr\.io\/distroless\/base-debian12:nonroot$/m);
  assert.deepEqual(report.bumps.map((b) => [b.ref, b.tag, b.lines]), [['gcr.io/distroless/base-debian12', 'nonroot', [10]]]);
  // The unmoved golang pin on line 7 is untouched and reported current.
  assert.ok(after.includes(`golang:\${GOLANG_VERSION}@${OLD.golang} AS build`));
  assert.deepEqual(report.current.map((c) => [c.line, c.ref, c.tag]), [[7, 'golang', '1.26.4']]);
});

test('ARG NODE_IMAGE=<ref>@sha256 moves on the ARG line; FROM ${NODE_IMAGE} is not a pin and stays', async () => {
  const fs = fsMap({ 'server/Dockerfile': SERVER });
  const report = await refreshDockerfiles(['server/Dockerfile'], { ...fs, resolve: table({ ...ALL_CURRENT, 'docker.io/library/node:20.11-bookworm-slim': NEW('3'), 'gcr.io/distroless/nodejs20-debian12:nonroot': NEW('4') }) });
  assert.equal(fs.disk['server/Dockerfile'], SERVER.replace(OLD.node20, NEW('3')).replace(OLD.nodejs20, NEW('4')));
  assert.match(fs.disk['server/Dockerfile'], /^FROM \$\{NODE_IMAGE\} AS build$/m);
  assert.match(fs.disk['server/Dockerfile'], new RegExp(`^FROM gcr\\.io/distroless/nodejs20-debian12:nonroot@${NEW('4')} AS runtime$`, 'm'));
  assert.deepEqual(report.bumps.map((b) => [b.ref, b.tag, b.lines]), [['node', '20.11-bookworm-slim', [2]], ['gcr.io/distroless/nodejs20-debian12', 'nonroot', [7]]]);
});

test('golang:${GOLANG_VERSION}, krakend:${KRAKEND_RENDER_VERSION} and a -bookworm suffix resolve to the tag they name', async () => {
  const fs = fsMap({ a: AGENT, r: RENDERER, m: MODEL });
  const seen = [];
  const resolve = async (ref) => { seen.push(`${ref.registry}/${ref.repository}:${ref.tag}`); return NEW('5'); };
  const report = await refreshDockerfiles(['a', 'r', 'm'], { ...fs, resolve });
  assert.deepEqual([...new Set(seen)].sort(), ['docker.io/devopsfaith/krakend:2.9.4', 'docker.io/library/debian:bookworm-slim', 'docker.io/library/golang:1.26.4', 'docker.io/library/golang:1.26.4-bookworm', 'gcr.io/distroless/static-debian12:nonroot']);
  assert.equal(seen.length, 5, 'one lookup per distinct ref, however many lines name it');
  assert.equal(fs.disk.m, MODEL.replaceAll(OLD.golang, NEW('5')).replaceAll(OLD.bookworm, NEW('5')));
  assert.match(fs.disk.m, /^FROM base-deps AS onnx-runtime$/m);
  assert.equal(report.bumps.find((b) => b.file === 'm' && b.ref === 'debian').lines.join(), '4,5');
});

test('nothing moved: no file written, every pin current', async () => {
  const fs = fsMap({ 'dockerfiles/agent.Dockerfile': AGENT, 'server/Dockerfile': SERVER });
  const report = await refreshDockerfiles(['dockerfiles/agent.Dockerfile', 'server/Dockerfile'], { ...fs, resolve: table(ALL_CURRENT) });
  assert.deepEqual(report.bumps, []);
  assert.deepEqual(fs.writes, []);
  assert.equal(report.current.length, 4);
});

test('a variable with no default in the file skips that line with a notice; the line is untouched', async () => {
  const text = `FROM golang:\${GO}@${OLD.golang} AS build\nFROM debian:bookworm-slim@${OLD.bookworm}\n`;
  const fs = fsMap({ d: text });
  const report = await refreshDockerfiles(['d'], { ...fs, resolve: table({ 'docker.io/library/debian:bookworm-slim': NEW('6') }) });
  assert.equal(fs.disk.d, text.replace(OLD.bookworm, NEW('6')));
  assert.deepEqual(report.skipped, [{ file: 'd', line: 1, kind: 'FROM', raw: 'golang:${GO}', reason: '${GO} has no default in the file' }]);
  const { lines } = runNotices(['d'], report, 3);
  assert.ok(lines.includes('::notice::cve-patch: d:1: skipped golang:${GO} — ${GO} has no default in the file'), lines.join('\n'));
});

test('a pin with no tag is skipped (nothing to refresh within); CRLF files keep their CRLF', async () => {
  const text = `FROM debian@${OLD.bookworm}\r\nFROM debian:bookworm-slim@${OLD.bookworm} AS x\r\n`;
  const fs = fsMap({ d: text });
  const report = await refreshDockerfiles(['d'], { ...fs, resolve: table({ 'docker.io/library/debian:bookworm-slim': NEW('7') }) });
  assert.equal(fs.disk.d, `FROM debian@${OLD.bookworm}\r\nFROM debian:bookworm-slim@${NEW('7')} AS x\r\n`);
  assert.equal(report.skipped[0].reason, 'no tag to refresh within');
});

test('a path outside the checkout or a missing file is a failure, never read', async () => {
  const fs = fsMap({});
  const report = await refreshDockerfiles(['/etc/passwd', '../x/Dockerfile', 'gone/Dockerfile'], { ...fs, resolve: table({}) });
  assert.deepEqual(report.failed.map((f) => [f.file, f.reason]), [['/etc/passwd', 'not a relative path inside the checkout'], ['../x/Dockerfile', 'not a relative path inside the checkout'], ['gone/Dockerfile', 'cannot read the file (ENOENT)']]);
});

// ── The registry ─────────────────────────────────────────────────────────────────────────
/** A fake registry: records every request, answers from `routes` (url prefix → handler). */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: { ...(init.headers || {}) } });
    for (const [prefix, handler] of routes) if (url.startsWith(prefix)) return handler(url, init);
    return new Response(null, { status: 404 });
  };
  return { f, calls };
}
const digestResponse = (d) => new Response(null, { status: 200, headers: { 'Docker-Content-Digest': d } });

test('Docker Hub: a pull token from auth.docker.io for library/<name>, then HEAD with every manifest type accepted', async () => {
  const { f, calls } = fakeFetch([
    ['https://auth.docker.io/token', () => Response.json({ token: 'hub-token' })],
    ['https://registry-1.docker.io/v2/library/node/manifests/24-alpine', (u, init) => (init.headers.Authorization === 'Bearer hub-token' ? digestResponse(NEW('8')) : new Response(null, { status: 401 }))],
  ]);
  assert.equal(await resolveDigest(parseImageRef('node:24-alpine'), { fetch: f, retryDelayMs: 0 }), NEW('8'));
  const tok = new URL(calls[0].url);
  assert.equal(tok.searchParams.get('service'), 'registry.docker.io');
  assert.equal(tok.searchParams.get('scope'), 'repository:library/node:pull');
  assert.equal(calls[1].method, 'HEAD');
  for (const t of ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']) {
    assert.ok(calls[1].headers.Accept.includes(t), t);
  }
  assert.equal(calls[1].headers.Accept, MANIFEST_ACCEPT);
});

test('Docker Hub namespaced image: the scope names <ns>/<name>', async () => {
  const { f, calls } = fakeFetch([
    ['https://auth.docker.io/token', () => Response.json({ access_token: 'tok' })],
    ['https://registry-1.docker.io/v2/devopsfaith/krakend/manifests/2.9.4', () => digestResponse(NEW('9'))],
  ]);
  assert.equal(await resolveDigest(parseImageRef('devopsfaith/krakend:2.9.4'), { fetch: f }), NEW('9'));
  assert.equal(new URL(calls[0].url).searchParams.get('scope'), 'repository:devopsfaith/krakend:pull');
});

test('gcr.io and ghcr.io: the 401 challenge names the realm, service and scope of the anonymous token', async () => {
  for (const [ref, host, realm, service] of [
    ['gcr.io/distroless/static-debian12:nonroot', 'gcr.io', 'https://gcr.io/v2/token', 'gcr.io'],
    ['ghcr.io/a40-labs/tool:v1', 'ghcr.io', 'https://ghcr.io/token', 'ghcr.io'],
  ]) {
    const parsed = parseImageRef(ref);
    const scope = `repository:${parsed.repository}:pull`;
    const { f, calls } = fakeFetch([
      [realm, () => Response.json({ token: `t-${host}` })],
      [`https://${host}/v2/${parsed.repository}/manifests/${parsed.tag}`, (u, init) => (init.headers.Authorization === `Bearer t-${host}`
        ? digestResponse(NEW('a'))
        : new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="${realm}",service="${service}",scope="${scope}"` } }))],
    ]);
    assert.equal(await resolveDigest(parsed, { fetch: f }), NEW('a'), ref);
    assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET', 'HEAD'], ref);
    const tok = new URL(calls[1].url);
    assert.equal(tok.searchParams.get('service'), service);
    assert.equal(tok.searchParams.get('scope'), scope);
  }
});

test('a registry that answers without auth needs no token; one token serves a repeated scope', async () => {
  const { f, calls } = fakeFetch([['https://registry.example.com/v2/x/manifests/1', () => digestResponse(NEW('b'))]]);
  assert.equal(await resolveDigest(parseImageRef('registry.example.com/x:1'), { fetch: f }), NEW('b'));
  assert.equal(calls.length, 1);
  const hub = fakeFetch([['https://auth.docker.io/token', () => Response.json({ token: 't' })], ['https://registry-1.docker.io/', () => digestResponse(NEW('c'))]]);
  const tokens = new Map();
  await resolveDigest(parseImageRef('node:24-alpine'), { fetch: hub.f, tokens });
  await resolveDigest(parseImageRef('node:24-alpine'), { fetch: hub.f, tokens });
  assert.equal(hub.calls.filter((c) => c.url.startsWith('https://auth.docker.io/')).length, 1);
});

test('a missing tag, a missing digest header, or a dead registry is an error, never a digest', async () => {
  const notFound = fakeFetch([['https://auth.docker.io/token', () => Response.json({ token: 't' })]]);
  await assert.rejects(resolveDigest(parseImageRef('node:99'), { fetch: notFound.f }), /HTTP 404/);
  const noHeader = fakeFetch([['https://gcr.io/v2/', () => new Response(null, { status: 200 })]]);
  await assert.rejects(resolveDigest(parseImageRef('gcr.io/a/b:c'), { fetch: noHeader.f }), /no sha256 Docker-Content-Digest/);
  const down = fakeFetch([['https://gcr.io/v2/', () => new Response(null, { status: 503 })]]);
  await assert.rejects(resolveDigest(parseImageRef('gcr.io/a/b:c'), { fetch: down.f, retryDelayMs: 0 }), /HTTP 503/);
  assert.equal(down.calls.length, 2, 'one retry on a 5xx');
  const noChallenge = fakeFetch([['https://gcr.io/v2/', () => new Response(null, { status: 401 })]]);
  await assert.rejects(resolveDigest(parseImageRef('gcr.io/a/b:c'), { fetch: noChallenge.f }), /401 without a bearer challenge/);
});

// ── The CLI: notices, outputs, summary, body ─────────────────────────────────────────────
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-base-images-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('nothing moved: the exact notice, exit 0, moved=false, the summary says the same, nothing written', () => withTmp(async (dir) => {
  const group = { paths: ['dockerfiles/agent.Dockerfile', 'server/Dockerfile'], fixableCount: 4 };
  writeFileSync(join(dir, 'group.json'), JSON.stringify(group));
  const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  const fs = fsMap({ 'dockerfiles/agent.Dockerfile': AGENT, 'server/Dockerfile': SERVER });
  const log = [];
  const code = await main(['--group', join(dir, 'group.json'), '--report', join(dir, 'report.json'), '--body', join(dir, 'body.md')], { env, log: (l) => log.push(l), resolve: table(ALL_CURRENT), ...fs });
  assert.equal(code, 0);
  assert.deepEqual(log, ['::notice::base images are current for dockerfiles/agent.Dockerfile, server/Dockerfile; 4 fixable findings wait on upstream']);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'moved=false\nbumps=0\n');
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Base images are current for `dockerfiles\/agent\.Dockerfile`, `server\/Dockerfile`; 4 fixable findings wait on upstream\. No commit, no PR\./);
  assert.deepEqual(fs.writes, []);
  assert.throws(() => readFileSync(join(dir, 'body.md')), /ENOENT/);
}));

test('a lookup that failed with nothing moved is a red step, not "current"', () => withTmp(async (dir) => {
  const env = { GITHUB_OUTPUT: join(dir, 'out') };
  const fs = fsMap({ 'server/Dockerfile': SERVER });
  const log = [];
  const code = await main(['server/Dockerfile'], { env, log: (l) => log.push(l), resolve: table({ 'docker.io/library/node:20.11-bookworm-slim': OLD.node20 }), ...fs });
  assert.equal(code, 1);
  assert.ok(log.some((l) => l.startsWith('::warning::cve-patch: server/Dockerfile:7: could not read the current digest of gcr.io/distroless/nodejs20-debian12:nonroot — no such tag')), log.join('\n'));
  assert.equal(log.at(-1), '::error::cve-patch: nothing refreshed and 1 lookup or file could not be read — not claiming the base images of server/Dockerfile are current');
  assert.ok(!log.some((l) => l.includes('base images are current for')));
}));

test('a refresh: moved=true, the report lists ref/tag/old/new, and the PR body carries images, findings, bumps and the proof', () => withTmp(async (dir) => {
  const group = {
    ecosystem: 'base-image', tier: 't1', severity: 'high', paths: ['apps/console/Dockerfile.monorepo'], fixableCount: 1, advisories: ['CVE-2026-0001'], firstSeen: '2026-10-20T06:00:00+00:00',
    images: [{ key: 'a40-prod/console-shubo', dockerfiles: ['apps/console/Dockerfile.monorepo'], reference: 'europe-west2-docker.pkg.dev/a40-prod/a40/console-shubo:v1', index_digest: NEW('d'),
      platform_digests: { 'linux/amd64': NEW('e'), 'linux/arm64': NEW('f') }, scanned: '2026-10-25T02:00:00Z', complete: true, fixable: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      findings: [{ id: 'CVE-2026-0001', pkg: 'musl', installed: '1.2.5-r0', fixed: '1.2.5-r1', severity: 'high' }], more: 0 }],
  };
  writeFileSync(join(dir, 'group.json'), JSON.stringify(group));
  const env = { GITHUB_OUTPUT: join(dir, 'out'), RUN_URL: 'https://github.com/a40-labs/shubo/actions/runs/1' };
  const fs = fsMap({ 'apps/console/Dockerfile.monorepo': CONSOLE });
  const log = [];
  const code = await main(['--group', join(dir, 'group.json'), '--report', join(dir, 'report.json'), '--body', join(dir, 'body.md')], { env, log: (l) => log.push(l), resolve: table({ 'docker.io/library/node:24-alpine': NEW('1') }), ...fs });
  assert.equal(code, 0);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'moved=true\nbumps=1\n');
  assert.deepEqual(log, [`::notice::cve-patch: refreshed 1 base-image digest in 1 Dockerfile: node:24-alpine ${OLD.node24.slice(0, 19)} → ${NEW('1').slice(0, 19)} (apps/console/Dockerfile.monorepo)`]);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.deepEqual(report.bumps[0], { file: 'apps/console/Dockerfile.monorepo', ref: 'node', tag: '24-alpine', old: OLD.node24, new: NEW('1'), lines: [4, 6, 7, 8, 9] });
  const body = readFileSync(join(dir, 'body.md'), 'utf8');
  assert.match(body, /^\*\*Because\*\*\n\n- /);
  assert.match(body, /\n\*\*This commit\*\*\n\n- /);
  assert.ok(body.includes(`- \`a40-prod/console-shubo\` (\`apps/console/Dockerfile.monorepo\`): \`europe-west2-docker.pkg.dev/a40-prod/a40/console-shubo:v1\`, index \`${NEW('d')}\` (linux/amd64 \`${NEW('e')}\`, linux/arm64 \`${NEW('f')}\`)`));
  assert.ok(body.includes('  - CVE-2026-0001 `musl` 1.2.5-r0 → 1.2.5-r1 (high)'));
  assert.ok(body.includes(`- Refresh \`node:24-alpine\` \`${OLD.node24}\` → \`${NEW('1')}\` in \`apps/console/Dockerfile.monorepo\` (lines 4, 6, 7, 8, 9), within its tag.`));
  assert.ok(body.includes("The caller's `fast_checks` were not run"));
  assert.ok(body.includes("the repository's image workflow, which builds both platforms (linux/amd64 and linux/arm64) on a Dockerfile PR; the findings are re-read by the patrol after the next publish."));
  assert.ok(body.includes('*CVE patch* · T1 · HIGH base images: 1 digest refreshed in 1 Dockerfile, 1 advisory'));
  assert.ok(body.includes('https://github.com/a40-labs/shubo/actions/runs/1'));
}));

test('the summary tabulates the bumps', async () => {
  const fs = fsMap({ d: AGENT });
  const report = await refreshDockerfiles(['d'], { ...fs, resolve: table({ ...ALL_CURRENT, 'gcr.io/distroless/static-debian12:nonroot': NEW('2') }) });
  assert.match(stepSummary(['d'], report, 2), new RegExp(`\\| \`d\` \\| \`gcr\\.io/distroless/static-debian12:nonroot\` \\| \`${OLD.static}\` \\| \`${NEW('2')}\` \\| 7 \\|`));
  assert.match(renderPrBody({ group: { severity: 'high', advisories: [], images: [] }, report }), /Unchanged — the tag still points at the pinned digest: `golang:1\.26\.4` in `d`\./);
});

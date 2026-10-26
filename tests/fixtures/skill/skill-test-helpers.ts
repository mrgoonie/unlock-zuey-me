/**
 * Shared helpers for tests/unit/skill-*.test.ts: temp HOME/project dirs (the real ~/.claude and ~/.config are never
 * touched), a local fake ingest server on 127.0.0.1, and spawning the skill scripts with a scrubbed environment.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SKILL_DIR = path.join(REPO_ROOT, 'skills/ai-unlocked');
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures/skill');

export const fixture = (rel: string): string => path.join(FIXTURES_DIR, rel);
export const readFixture = (rel: string): string => fs.readFileSync(fixture(rel), 'utf8');

/** A syntactically valid ingestion token (never a real one). */
export const TEST_TOKEN = `aiu_ing_${'T'.repeat(39)}abcd`;

export interface TempEnv {
  root: string;
  home: string;
  cwd: string;
  configDir: string;
  ctx: { home: string; cwd: string; env: Record<string, string | undefined>; platform: string };
  /** Environment for spawned scripts: only PATH + HOME (+ extras); nothing inherited from the test runner. */
  spawnEnv: (extra?: Record<string, string>) => Record<string, string>;
  cleanup: () => void;
}

export function makeTempEnv(): TempEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-skill-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env: Record<string, string | undefined> = { HOME: home };
  return {
    root,
    home,
    cwd,
    configDir: path.join(home, '.config', 'ai-unlocked'),
    ctx: { home, cwd, env, platform: process.platform },
    spawnEnv: (extra = {}) => ({ PATH: process.env.PATH ?? '', HOME: home, ...extra }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Config paths of a temp env (mirrors skills/ai-unlocked/scripts/lib/paths.mjs on POSIX). */
export function configFiles(t: TempEnv) {
  return {
    dir: t.configDir,
    credentials: path.join(t.configDir, 'credentials.json'),
    state: path.join(t.configDir, 'state.json'),
    spool: path.join(t.configDir, 'spool'),
    flushLock: path.join(t.configDir, 'spool', '.flush.lock'),
    log: path.join(t.configDir, 'hook.log'),
  };
}

export function writeCredentialsFile(t: TempEnv, server: string, token = TEST_TOKEN): void {
  fs.mkdirSync(t.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(t.configDir, 'credentials.json'), JSON.stringify({ server, token, label: 'test', expiresAt: '2099-01-01T00:00:00.000Z' }), { mode: 0o600 });
}

export function writeStateFile(t: TempEnv, state: Record<string, unknown>): void {
  fs.mkdirSync(t.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(t.configDir, 'state.json'), JSON.stringify(state), { mode: 0o600 });
}

export const spoolFiles = (t: TempEnv): string[] => {
  try {
    return fs.readdirSync(path.join(t.configDir, 'spool')).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
  } catch {
    return [];
  }
};

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  delayMs?: number;
  /** Never answer (the client must time out). */
  hang?: boolean;
}

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  /** Replace the responder at any time. */
  setResponder: (fn: (req: RecordedRequest) => FakeReply) => void;
  close: () => Promise<void>;
}

/** Local HTTP server standing in for unlock.zuey.me. Default reply: 202 {accepted:true, duplicate:false}. */
export async function startFakeServer(responder?: (req: RecordedRequest) => FakeReply): Promise<FakeServer> {
  let respond: (req: RecordedRequest) => FakeReply = responder ?? (() => ({ status: 202, body: { accepted: true, duplicate: false } }));
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(rec);
      const reply = respond(rec);
      if (reply.hang) return;
      const send = () => {
        const isText = typeof reply.body === 'string' || reply.body instanceof Uint8Array;
        res.writeHead(reply.status, { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json' });
        res.end(reply.body === undefined ? '' : isText ? (reply.body as string | Uint8Array) : JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setResponder: (fn) => { respond = fn; },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs `node <script> ...args` with stdin, a scrubbed env and cwd; resolves when it exits. */
export function runNode(script: string, args: string[], options: { env: Record<string, string>; cwd: string; stdin?: string; timeoutMs?: number }): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [script, ...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout running ${script}`)); }, options.timeoutMs ?? 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - started });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `predicate` until true or `timeoutMs` elapses. */
export async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/** Stop payload fixture with the transcript path filled in. */
export function stopPayload(name: string, transcriptPath: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = readFixture(`stop-payloads/${name}`).replace('TRANSCRIPT_PATH', transcriptPath.replace(/\\/g, '\\\\'));
  return { ...(JSON.parse(raw) as Record<string, unknown>), ...patch };
}

/** Kills a detached uploader still holding the flush lock of `t` (so no process outlives a test). */
export function killUploader(t: TempEnv): void {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(t.configDir, 'spool', '.flush.lock'), 'utf8')) as { pid?: number };
    if (owner.pid) process.kill(owner.pid, 'SIGKILL');
  } catch { /* no uploader running */ }
}

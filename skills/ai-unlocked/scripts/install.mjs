#!/usr/bin/env node
// Bootstrap installer of the ai-unlocked skill, served at https://unlock.zuey.me/skill/install.mjs:
//
//   curl -fsSL https://unlock.zuey.me/skill/install.mjs | node - --scope user
//
// It downloads /skill/manifest.json, fetches every listed file from /skill/files/<path>, verifies its byte length
// and sha256, stages the result in <target>.staging, then swaps it in (the previous copy moves to <target>.prev
// and is restored on any failure). It never touches Claude Code settings: installing the hook, pairing and
// uninstalling are separate commands the agent runs only after the learner agrees.
//
// Targets (https://code.claude.com/docs/en/skills): --scope user → ~/.claude/skills/ai-unlocked (or
// $CLAUDE_CONFIG_DIR/skills/ai-unlocked); --scope project → ./.claude/skills/ai-unlocked.
//
// This file must run when piped to `node -`, where Node may treat it as CommonJS: so no static `import`, no
// `export` and no `import.meta`; Node built-ins are loaded with dynamic import() inside main().

const DEFAULT_SERVER = 'https://unlock.zuey.me';
const SKILL_NAME = 'ai-unlocked';
const PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

class InstallError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const opts = { scope: null, server: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, inline] = a.startsWith('--') ? a.slice(2).split('=', 2) : [null, undefined];
    if (key === 'scope' || key === 'server') opts[key] = inline !== undefined ? inline : argv[++i];
    else if (a !== '-') throw new InstallError(`Tham số không hợp lệ: ${a}`);
  }
  return opts;
}

function normalizeServer(raw) {
  let url;
  try {
    url = new URL((raw || '').trim() || DEFAULT_SERVER);
  } catch {
    throw new InstallError(`Địa chỉ máy chủ không hợp lệ: ${raw}`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new InstallError('Máy chủ phải dùng https (http chỉ cho localhost).');
  return url.origin;
}

/** A manifest path is safe when it matches the pattern and has no empty, `.` or `..` segment. */
function safeRelativePath(p) {
  return typeof p === 'string' && PATH_PATTERN.test(p) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { 'user-agent': `${SKILL_NAME}-installer` } });
    if (!res.ok) throw new InstallError(`Tải ${url} thất bại (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError(`Không tải được ${url} (${err && err.name === 'AbortError' ? 'quá thời gian' : 'lỗi mạng'}).`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new InstallError('Cần Node >= 18 để cài skill (máy này vẫn dùng được MCP).', 2);
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const crypto = (await import('node:crypto')).default;

  const opts = parseArgs(process.argv.slice(2));
  if (opts.scope !== 'user' && opts.scope !== 'project') throw new InstallError('Cần --scope user hoặc --scope project.');
  const server = normalizeServer(opts.server || process.env.AI_UNLOCKED_SERVER);
  const claudeHome = process.env.CLAUDE_CONFIG_DIR && path.isAbsolute(process.env.CLAUDE_CONFIG_DIR)
    ? process.env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude');
  const target = opts.scope === 'user'
    ? path.join(claudeHome, 'skills', SKILL_NAME)
    : path.join(process.cwd(), '.claude', 'skills', SKILL_NAME);

  let manifest;
  try {
    manifest = JSON.parse((await fetchBytes(`${server}/skill/manifest.json`)).toString('utf8'));
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError('manifest.json không phải JSON hợp lệ.');
  }
  if (!manifest || manifest.name !== SKILL_NAME || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) {
    throw new InstallError('manifest.json không đúng định dạng.');
  }
  const seen = new Set();
  for (const f of manifest.files) {
    if (!f || !safeRelativePath(f.path) || seen.has(f.path)) throw new InstallError(`Đường dẫn không an toàn trong manifest: ${f && f.path}`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new InstallError(`sha256 không hợp lệ cho ${f.path}`);
    if (!Number.isInteger(f.bytes) || f.bytes < 0 || f.bytes > MAX_FILE_BYTES) throw new InstallError(`Kích thước không hợp lệ cho ${f.path}`);
    seen.add(f.path);
  }
  if (!seen.has('SKILL.md')) throw new InstallError('manifest.json thiếu SKILL.md.');

  // Download and verify everything before touching the target.
  const files = [];
  for (const f of manifest.files) {
    const bytes = await fetchBytes(`${server}/skill/files/${f.path.split('/').map(encodeURIComponent).join('/')}`);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== f.bytes || digest !== f.sha256) throw new InstallError(`Sai sha256 cho ${f.path}; đã huỷ cài đặt, bản cũ giữ nguyên.`);
    files.push({ path: f.path, bytes });
  }

  const staging = `${target}.staging`;
  const prev = `${target}.prev`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const f of files) {
      const dest = path.join(staging, ...f.path.split('/'));
      if (!dest.startsWith(staging + path.sep)) throw new InstallError(`Đường dẫn không an toàn: ${f.path}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.bytes, { mode: 0o644 });
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  fs.rmSync(prev, { recursive: true, force: true });
  const hadPrevious = fs.existsSync(target);
  try {
    if (hadPrevious) fs.renameSync(target, prev);
    fs.renameSync(staging, target);
  } catch (err) {
    if (hadPrevious && !fs.existsSync(target) && fs.existsSync(prev)) fs.renameSync(prev, target);
    fs.rmSync(staging, { recursive: true, force: true });
    throw new InstallError(`Không thay được thư mục skill (${err.message}); bản cũ giữ nguyên.`);
  }
  fs.rmSync(prev, { recursive: true, force: true });

  const cli = path.join(target, 'scripts', 'ai-unlocked.mjs');
  const log = (s) => process.stdout.write(`${s}\n`);
  log(`Đã cài skill ${SKILL_NAME} v${manifest.version} vào ${target} (${files.length} file, đã kiểm sha256).`);
  log('');
  log('Bước tiếp theo (mỗi bước chỉ chạy khi bạn đồng ý):');
  log(`  1. Kết nối MCP:   claude mcp add --transport http ai-unlocked ${server}/mcp --scope user`);
  log(`  2. (Tuỳ chọn) Ghép nối ai-tutor:  node "${cli}" pair`);
  log(`  3. (Tuỳ chọn) Cài hook:          node "${cli}" hook install --scope ${opts.scope}`);
  log(`  Kiểm tra:  node "${cli}" doctor`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exit(err instanceof InstallError ? err.code : 1);
  },
);

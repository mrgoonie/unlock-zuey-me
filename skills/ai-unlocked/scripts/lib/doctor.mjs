// `ai-unlocked doctor`: read-only health checks with ok / warn / fail. Never prints the token (last 4 chars only),
// never reads conversation transcripts, and never starts `claude` (MCP config is read from Claude Code's files).
//
// Claude Code facts checked here (verified 2026-10-26):
// - `disableAllHooks: true` turns every hook off; `allowManagedHooksOnly` in managed settings blocks user, project
//   and local hooks (https://code.claude.com/docs/en/hooks, "Disable or remove hooks").
// - Interactive sessions hold back hooks from every settings file until the workspace trust dialog is accepted;
//   `-p` sessions treat the folder as trusted (https://code.claude.com/docs/en/hooks, "Workspace trust").
// - MCP server configurations live in `~/.claude.json` (user/local scope) and `.mcp.json` (project scope)
//   (https://code.claude.com/docs/en/settings).
import fs from 'node:fs';
import path from 'node:path';
import { MIN_NODE_MAJOR, SKILL_VERSION } from './constants.mjs';
import { credentialModeWarnings, maskToken, readCredentials } from './credentials.mjs';
import { markerReport } from './hook-installer.mjs';
import { getSkillManifest, getStatus } from './ingest-client.mjs';
import { readState } from './local-state.mjs';
import { claudeHomeDir, configPaths, serverFromEnv, skillDirs } from './paths.mjs';
import { readJsonObject } from './private-files.mjs';
import { listSpool } from './spool.mjs';

/** @typedef {{ group: string, name: string, level: 'ok' | 'warn' | 'fail', detail: string }} Check */

/**
 * Managed settings file locations. [UNVERIFIED] best effort per OS; only used to warn, never to decide.
 * @param {string} platform
 */
export function managedSettingsCandidates(platform) {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

/** True when an MCP server entry points at unlock.zuey.me (or is named ai-unlocked). */
function isUnlockServer(name, cfg) {
  const url = cfg && typeof cfg === 'object' && typeof cfg.url === 'string' ? cfg.url : '';
  return name === 'ai-unlocked' || /unlock\.zuey\.me/.test(url);
}

/** Where an ai-unlocked MCP server is configured (user, local or project scope), best effort. */
function mcpLocations(ctx) {
  const found = [];
  const home = claudeHomeDir(ctx);
  const globalFiles = [path.join(path.dirname(home), '.claude.json'), path.join(home, '.claude.json')];
  for (const file of [...new Set(globalFiles)]) {
    const cfg = readJsonObject(file);
    if (!cfg) continue;
    if (cfg.mcpServers && Object.entries(cfg.mcpServers).some(([n, c]) => isUnlockServer(n, c))) found.push('user');
    const proj = cfg.projects && cfg.projects[ctx.cwd];
    if (proj?.mcpServers && Object.entries(proj.mcpServers).some(([n, c]) => isUnlockServer(n, c))) found.push('local');
  }
  const projectMcp = readJsonObject(path.join(ctx.cwd, '.mcp.json'));
  if (projectMcp?.mcpServers && Object.entries(projectMcp.mcpServers).some(([n, c]) => isUnlockServer(n, c))) found.push('project');
  return [...new Set(found)];
}

const compareSemver = (a, b) => {
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

/**
 * @param {{ ctx: import('./paths.mjs').PathContext, offline?: boolean, now?: number }} args
 * @returns {Promise<Check[]>}
 */
export async function runDoctor({ ctx, offline = false, now = Date.now() }) {
  /** @type {Check[]} */
  const checks = [];
  const add = (group, name, level, detail) => checks.push({ group, name, level, detail });

  // Runtime.
  const major = Number(process.versions.node.split('.')[0]);
  add('runtime', 'node', major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    major >= MIN_NODE_MAJOR ? `Node ${process.versions.node}` : `Node ${process.versions.node}: không hỗ trợ hook trên máy này (cần Node >= ${MIN_NODE_MAJOR}); vẫn dùng được MCP.`);
  if (ctx.platform === 'darwin' || ctx.platform === 'linux') add('runtime', 'platform', 'ok', ctx.platform);
  else if (ctx.platform === 'win32') add('runtime', 'platform', 'warn', 'Windows: chưa kiểm thử, nên dùng WSL.');
  else add('runtime', 'platform', 'warn', `${ctx.platform}: chưa kiểm thử.`);

  // Skill install.
  const dirs = skillDirs(ctx);
  const installed = Object.entries(dirs).filter(([, d]) => fs.existsSync(path.join(d, 'SKILL.md'))).map(([s]) => s);
  add('skill', 'install', installed.length ? 'ok' : 'warn', installed.length ? `đã cài: ${installed.join(', ')} (v${SKILL_VERSION})` : 'chưa thấy skill trong ~/.claude/skills hoặc .claude/skills');
  if (installed.length > 1) add('skill', 'duplicate', 'warn', 'skill được cài ở cả user và project; nên giữ một nơi.');

  // Settings files.
  const reports = markerReport(ctx);
  let totalMarkers = 0;
  for (const r of reports) {
    if (!r.exists) continue;
    if (!r.ok) { add('settings', r.scope, 'fail', `${r.file}: ${r.error}`); continue; }
    totalMarkers += r.markers.length;
    if (r.json?.disableAllHooks === true) add('settings', r.scope, 'fail', `${r.file}: disableAllHooks = true, mọi hook đều tắt.`);
    if (r.markers.length > 1) add('settings', r.scope, 'warn', `${r.file}: ${r.markers.length} hook ai-unlocked (chạy lại hook install để gộp).`);
    for (const m of r.markers) {
      if (m.event !== 'Stop') add('settings', r.scope, 'warn', `${r.file}: hook ai-unlocked nằm ở ${m.event}, chỉ nên ở Stop.`);
      const script = /"([^"]+stop-hook\.mjs)"/.exec(m.command)?.[1];
      if (script && !fs.existsSync(script)) add('settings', r.scope, 'fail', `${r.file}: hook trỏ tới file không còn tồn tại (${script}). Chạy lại hook install.`);
      const nodeBin = /^"([^"]+)"/.exec(m.command)?.[1];
      if (nodeBin && !fs.existsSync(nodeBin)) add('settings', r.scope, 'fail', `${r.file}: không tìm thấy Node tại ${nodeBin}. Chạy lại hook install.`);
    }
    if (r.markers.length === 1) add('settings', r.scope, 'ok', `${r.file}: hook ai-unlocked đã cài.`);
  }
  if (totalMarkers === 0) add('settings', 'hook', 'warn', 'chưa cài hook ai-tutor (không bắt buộc; MCP vẫn hoạt động).');
  if (reports.filter((r) => r.markers.length > 0).length > 1) add('settings', 'hook', 'warn', 'hook ai-unlocked có ở nhiều file settings; nên giữ một nơi.');
  for (const file of managedSettingsCandidates(ctx.platform)) {
    const managed = readJsonObject(file);
    if (!managed) continue;
    if (managed.allowManagedHooksOnly === true) add('settings', 'managed', 'fail', `${file}: allowManagedHooksOnly chặn hook cá nhân [UNVERIFIED path].`);
    if (managed.disableAllHooks === true) add('settings', 'managed', 'fail', `${file}: disableAllHooks = true [UNVERIFIED path].`);
  }
  add('settings', 'trust', 'ok', 'Nhắc: trong phiên tương tác, hook chỉ chạy sau khi bạn tin cậy thư mục (workspace trust).');

  // MCP.
  const mcp = mcpLocations(ctx);
  add('connection', 'mcp', mcp.length ? 'ok' : 'warn', mcp.length ? `MCP ai-unlocked đã cấu hình (${mcp.join(', ')})` : 'chưa thấy MCP ai-unlocked; chạy: claude mcp add --transport http ai-unlocked https://unlock.zuey.me/mcp --scope user');

  // Credentials and server.
  const paths = configPaths(ctx);
  const state = readState(paths);
  const creds = readCredentials(paths, ctx.env);
  if (!creds) add('connection', 'credentials', 'warn', 'chưa ghép nối thiết bị (ai-tutor đang tắt).');
  else {
    add('connection', 'credentials', 'ok', `token ${maskToken(creds.token)} (${creds.source === 'env' ? 'biến môi trường' : 'credentials.json'})`);
    for (const w of credentialModeWarnings(paths, ctx.platform)) add('connection', 'credentials', 'warn', w);
    const exp = creds.expiresAt ? Date.parse(creds.expiresAt) : NaN;
    if (Number.isFinite(exp) && exp < now) add('connection', 'expiry', 'fail', 'token đã hết hạn; chạy lại pair.');
    else if (Number.isFinite(exp) && exp - now < 7 * 86400000) add('connection', 'expiry', 'warn', `token hết hạn lúc ${creds.expiresAt}.`);
  }
  if (state.credentialsInvalid) add('connection', 'credentials', 'fail', 'máy chủ đã từ chối token (401); chạy lại pair.');

  let server = creds?.server;
  if (!server) { try { server = serverFromEnv(ctx); } catch (err) { add('connection', 'server', 'fail', err.message); } }
  if (!offline && server) {
    const manifest = await getSkillManifest(server);
    if (manifest.status === 200 && typeof manifest.body?.version === 'string') {
      const cmp = compareSemver(SKILL_VERSION, manifest.body.version);
      add('skill', 'version', cmp >= 0 ? 'ok' : 'warn', cmp >= 0 ? `bản mới nhất (${SKILL_VERSION})` : `có bản mới ${manifest.body.version}; chạy: ai-unlocked upgrade`);
    } else if (manifest.status === 404) add('skill', 'version', 'warn', 'máy chủ chưa mở trang /skill (tính năng đang tắt).');
    else add('skill', 'version', 'warn', 'không kiểm tra được phiên bản mới (mạng?).');
    if (creds && !state.credentialsInvalid) {
      const st = await getStatus(server, creds.token);
      if (st.status === 200) {
        add('connection', 'server', 'ok', 'máy chủ nhận token.');
        add('connection', 'consent', st.body?.consents?.analysis ? 'ok' : 'warn',
          st.body?.consents?.analysis ? 'đã đồng ý phân tích (analysis).' : 'chưa bật đồng ý phân tích trong Cài đặt; ai-tutor sẽ không nhận dữ liệu.');
      } else if (st.status === 401) add('connection', 'server', 'fail', 'token không còn hiệu lực; chạy lại pair.');
      else if (st.status === 404) add('connection', 'server', 'warn', 'tính năng ai-tutor đang tắt trên máy chủ.');
      else add('connection', 'server', 'warn', st.status ? `máy chủ trả HTTP ${st.status}.` : 'không kết nối được máy chủ.');
    }
  }

  // Local state.
  const spool = listSpool(paths, now);
  add('local', 'spool', spool.length > 40 ? 'warn' : 'ok', `${spool.length} lượt chờ gửi (${spool.reduce((s, e) => s + e.size, 0)} bytes)`);
  if (state.paused) add('local', 'paused', 'warn', 'đang tạm dừng (chạy resume để bật lại).');
  if (state.serverBlockedUntil > now) add('local', 'blocked', 'warn', `tạm ngừng gửi tới ${new Date(state.serverBlockedUntil).toISOString()} (${state.blockReason ?? 'server'}).`);
  if (state.uploadRetryAfter > now) add('local', 'retry', 'warn', `chờ gửi lại sau ${new Date(state.uploadRetryAfter).toISOString()} (${state.blockReason ?? 'quota'}).`);
  if (state.lastResult) add('local', 'last-upload', 'ok', `lần gửi gần nhất: ${state.lastResult.status} lúc ${state.lastResult.at}`);
  if (state.parser === 'degraded') add('local', 'parser', 'warn', 'parser: degraded (không đọc được câu hỏi gần nhất; chỉ gửi câu trả lời cuối).');
  else if (state.parser === 'ok') add('local', 'parser', 'ok', 'parser: ok');
  return checks;
}

/** Human-readable doctor output. @param {Check[]} checks */
export function formatChecks(checks) {
  const tag = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]' };
  return checks.map((c) => `${tag[c.level]} ${c.group}/${c.name}: ${c.detail}`).join('\n');
}

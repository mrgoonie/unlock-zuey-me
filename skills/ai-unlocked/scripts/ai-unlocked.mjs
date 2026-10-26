#!/usr/bin/env node
// ai-unlocked CLI. SKILL.md tells the agent to ask the learner before `hook install`, `pair`, `uninstall` and any
// settings change; this CLI itself never prints the ingestion token.
//
//   status                                   local summary (no network)
//   doctor [--json] [--offline]              health checks
//   pair [--label <name>]                    device pairing; the token goes straight to credentials.json
//   hook install --scope user|project [--dry-run]
//   hook uninstall --scope user|project|all [--dry-run]
//   pause | resume                           stop / restart capture locally (no transcript read, no network)
//   flush                                    upload the local spool now
//   upgrade                                  reinstall the skill from the server (sha256-verified), refresh the hook
//   uninstall [--purge]                      remove hooks, spool and state; --purge also revokes the token
//
// Exit codes: 0 ok, 1 user error, 2 environment unsupported.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_MAJOR, SKILL_VERSION } from './lib/constants.mjs';
import { deleteCredentials, maskToken, readCredentials } from './lib/credentials.mjs';
import { formatChecks, runDoctor } from './lib/doctor.mjs';
import { flushSpool } from './lib/flush-runner.mjs';
import { hookCommand, installHook, markerReport, uninstallHook } from './lib/hook-installer.mjs';
import { revokeSelf } from './lib/ingest-client.mjs';
import { readState, updateState } from './lib/local-state.mjs';
import { pairDevice } from './lib/pairing.mjs';
import { configPaths, processContext, serverFromEnv, skillDirs } from './lib/paths.mjs';
import { clearSpool, listSpool } from './lib/spool.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPTS_DIR);

class UsageError extends Error {}

const out = (line = '') => process.stdout.write(`${line}\n`);

/** Parses `--flag value` / `--flag` options after the positional command words. */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [key, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['scope', 'label'].includes(key)) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { positional, flags };
}

function scopeFlag(flags, allowed) {
  const scope = flags.scope;
  if (typeof scope !== 'string' || !allowed.includes(scope)) throw new UsageError(`Cần --scope ${allowed.join('|')}`);
  return scope;
}

function printDiffs(results) {
  for (const r of results) {
    if (!r.changed) out(`Không cần đổi: ${r.file}`);
    else if (r.diff) out(r.diff);
  }
}

function cmdStatus(ctx) {
  const paths = configPaths(ctx);
  const state = readState(paths);
  const creds = readCredentials(paths, ctx.env);
  out(`ai-unlocked v${SKILL_VERSION}`);
  out(`Ghép nối: ${creds ? `có (token ${maskToken(creds.token)}, máy chủ ${creds.server})` : 'chưa'}`);
  if (state.credentialsInvalid) out('Token bị máy chủ từ chối: chạy lại pair.');
  out(`Trạng thái: ${state.paused ? 'tạm dừng' : 'đang bật'}`);
  if (state.serverBlockedUntil > Date.now()) out(`Tạm ngừng gửi tới ${new Date(state.serverBlockedUntil).toISOString()} (${state.blockReason})`);
  const hooks = markerReport(ctx).filter((r) => r.markers.length > 0).map((r) => r.scope);
  out(`Hook ai-tutor: ${hooks.length ? hooks.join(', ') : 'chưa cài'}`);
  out(`Lượt chờ gửi: ${listSpool(paths).length}`);
  if (state.lastResult) out(`Lần gửi gần nhất: ${state.lastResult.status} lúc ${state.lastResult.at}`);
  return 0;
}

async function cmdDoctor(ctx, flags) {
  const checks = await runDoctor({ ctx, offline: flags.offline === true });
  out(flags.json ? JSON.stringify({ version: SKILL_VERSION, checks }, null, 2) : formatChecks(checks));
  if (checks.some((c) => c.group === 'runtime' && c.name === 'node' && c.level === 'fail')) return 2;
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

async function cmdPair(ctx, flags) {
  const paths = configPaths(ctx);
  const server = serverFromEnv(ctx);
  const label = typeof flags.label === 'string' && flags.label.trim() ? flags.label.trim().slice(0, 64) : `Claude Code trên ${os.hostname()}`.slice(0, 64);
  const { expiresAt } = await pairDevice({ paths, server, label, print: out });
  out(`Đã ghép nối thiết bị "${label}". Token được lưu riêng trên máy này${expiresAt ? `, hết hạn ${expiresAt}` : ''}.`);
  return 0;
}

function cmdHook(ctx, positional, flags) {
  const action = positional[1];
  const dryRun = flags['dry-run'] === true;
  if (action === 'install') {
    const scope = scopeFlag(flags, ['user', 'project']);
    const r = installHook({ ctx, scope, command: hookCommand(SCRIPTS_DIR), dryRun });
    if (dryRun) { out('(--dry-run: không ghi gì)'); printDiffs([r]); return 0; }
    out(r.changed ? `Đã cài hook Stop vào ${r.file}` : `Hook đã có sẵn trong ${r.file}, không đổi gì.`);
    if (r.changed && r.existed) out(`Bản sao lưu: ${r.file}.ai-unlocked.bak`);
    return 0;
  }
  if (action === 'uninstall') {
    const scope = scopeFlag(flags, ['user', 'project', 'all']);
    const { results, errors } = uninstallHook({ ctx, scope, dryRun });
    if (dryRun) out('(--dry-run: không ghi gì)');
    if (dryRun) printDiffs(results);
    else for (const r of results) out(r.changed ? `Đã gỡ hook khỏi ${r.file}` : `Không có hook ai-unlocked trong ${r.file}`);
    for (const e of errors) out(`Bỏ qua ${e.file}: ${e.message}`);
    return errors.length ? 1 : 0;
  }
  throw new UsageError('Dùng: hook install|uninstall --scope …');
}

async function cmdFlush(ctx) {
  const r = await flushSpool(configPaths(ctx), ctx.env);
  if (r.skipped) out(`Không gửi: ${r.skipped}`);
  else out(`Đã gửi ${r.uploaded}, bỏ ${r.dropped}, còn chờ ${r.kept}${r.stopped ? ` (dừng: ${r.stopped})` : ''}.`);
  return 0;
}

function installedScope(ctx) {
  const dirs = skillDirs(ctx);
  if (path.resolve(SKILL_DIR) === path.resolve(dirs.user)) return 'user';
  if (path.resolve(SKILL_DIR) === path.resolve(dirs.project)) return 'project';
  return null;
}

function cmdUpgrade(ctx) {
  const scope = installedScope(ctx);
  if (!scope) throw new UsageError('Chỉ nâng cấp được bản đã cài trong ~/.claude/skills hoặc .claude/skills.');
  const creds = readCredentials(configPaths(ctx), ctx.env);
  const server = creds?.server ?? serverFromEnv(ctx);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'install.mjs'), '--scope', scope, '--server', server], {
    stdio: 'inherit', cwd: ctx.cwd, env: { ...process.env, AI_UNLOCKED_INTERNAL: '1' },
  });
  if (res.status !== 0) return res.status ?? 1;
  // Refresh handlers that point at this skill (same command, re-planned in place).
  for (const r of markerReport(ctx)) {
    if (r.markers.length === 0 || r.scope === 'project-shared') continue;
    const updated = installHook({ ctx, scope: /** @type {'user' | 'project'} */ (r.scope), command: hookCommand(SCRIPTS_DIR) });
    if (updated.changed) out(`Đã cập nhật hook trong ${updated.file}`);
  }
  return 0;
}

async function cmdUninstall(ctx, flags) {
  const paths = configPaths(ctx);
  const { results, errors } = uninstallHook({ ctx, scope: 'all' });
  for (const r of results) if (r.changed) out(`Đã gỡ hook khỏi ${r.file}`);
  for (const e of errors) out(`Bỏ qua ${e.file}: ${e.message}`);
  clearSpool(paths);
  fs.rmSync(paths.state, { force: true });
  fs.rmSync(paths.log, { force: true });
  if (flags.purge === true) {
    const creds = readCredentials(paths, ctx.env);
    if (creds) {
      const r = await revokeSelf(creds.server, creds.token);
      out(r.status === 200 ? 'Đã thu hồi token trên máy chủ.' : 'Không thu hồi được token trên máy chủ; bạn có thể thu hồi trong Cài đặt trên web.');
    }
    deleteCredentials(paths);
    fs.rmSync(paths.dir, { recursive: true, force: true });
    out('Đã xoá thông tin ghép nối trên máy này.');
  }
  const scope = installedScope(ctx);
  if (scope) {
    fs.rmSync(SKILL_DIR, { recursive: true, force: true });
    out(`Đã xoá skill tại ${SKILL_DIR}.`);
  }
  return errors.length ? 1 : 0;
}

async function main(argv) {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    out(`Cần Node >= ${MIN_NODE_MAJOR}; máy này không hỗ trợ hook ai-tutor (MCP vẫn dùng được).`);
    return 2;
  }
  const ctx = processContext();
  const { positional, flags } = parseArgs(argv);
  switch (positional[0]) {
    case 'status': return cmdStatus(ctx);
    case 'doctor': return cmdDoctor(ctx, flags);
    case 'pair': return cmdPair(ctx, flags);
    case 'hook': return cmdHook(ctx, positional, flags);
    case 'pause': updateState(configPaths(ctx), { paused: true }); out('Đã tạm dừng: hook không đọc hội thoại và không gửi gì.'); return 0;
    case 'resume': updateState(configPaths(ctx), { paused: false }); out('Đã bật lại ai-tutor.'); return 0;
    case 'flush': return cmdFlush(ctx);
    case 'upgrade': return cmdUpgrade(ctx);
    case 'uninstall': return cmdUninstall(ctx, flags);
    default:
      throw new UsageError('Lệnh: status | doctor | pair | hook install|uninstall | pause | resume | flush | upgrade | uninstall');
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    out(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);

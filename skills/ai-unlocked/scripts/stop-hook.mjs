#!/usr/bin/env node
// ai-unlocked Stop hook (Claude Code). Registered by `ai-unlocked hook install` as a synchronous command hook:
//   { "type": "command", "command": "\"<node>\" \"<skill>/scripts/stop-hook.mjs\" --ai-unlocked-hook=v1", "timeout": 10 }
//
// Contract with Claude Code (https://code.claude.com/docs/en/hooks, verified 2026-10-26):
// - Exit 0 lets the stop go ahead; stdout of a non-async hook is parsed as JSON output when it is one JSON object,
//   and on Stop a `decision: "block"` or exit code 2 would make Claude continue. This hook therefore ALWAYS exits 0
//   with EMPTY stdout (and empty stderr): it never blocks, never asks Claude to continue, never emits `decision`
//   or `continue`.
// - Not `async: true`: "In non-interactive mode with the -p flag, Claude Code kills any async hook still running at
//   teardown" and "If your hook's work must outlive a claude -p session, start a fully detached process from it".
//   So the hook spools to disk synchronously (the durability point) and starts a detached uploader.
// - Not an `http` hook: those wait for the response, so a slow server would delay every turn.
//
// Every path ends in process.exit(0); a 1.5 s self-deadline guarantees it even if something hangs.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STDIN_MAX_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 1000;
const SELF_DEADLINE_MS = 1500;

const done = () => process.exit(0);
setTimeout(done, SELF_DEADLINE_MS).unref();
// Nothing may reach stdout or stderr: Claude Code would try to parse it as hook output.
process.stdout.write = () => true;
process.stderr.write = () => true;

/** Reads stdin up to `max` bytes within `ms`; null on overflow, timeout, TTY or error. */
function readStdin(max, ms) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        clearTimeout(timer);
        process.stdin.destroy();
        resolve(null);
      } else chunks.push(chunk);
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function main() {
  // Any process this package starts carries AI_UNLOCKED_INTERNAL=1; never capture inside one (no loops).
  if (process.env.AI_UNLOCKED_INTERNAL === '1') return;
  const raw = await readStdin(STDIN_MAX_BYTES, STDIN_TIMEOUT_MS);
  if (raw === null) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const { runStopHook } = await import('./lib/stop-hook-core.mjs');
  const ctx = { home: os.homedir(), cwd: process.cwd(), env: process.env, platform: process.platform };
  const result = runStopHook(input, { ctx });
  if (!result.spawnFlush) return;
  const flushScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flush-spool.mjs');
  const child = spawn(process.execPath, [flushScript], {
    detached: true, // own process group on POSIX, so the uploader survives the Claude Code session ending
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, AI_UNLOCKED_INTERNAL: '1' },
  });
  child.on('error', () => {});
  child.unref();
}

main().then(done, done);

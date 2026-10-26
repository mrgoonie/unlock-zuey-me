#!/usr/bin/env node
// Detached uploader started by the Stop hook (AI_UNLOCKED_INTERNAL=1, stdio ignored). Uploads the spool once
// under the flush lock and exits; a second copy exits at once when the lock is live. See lib/flush-runner.mjs
// for the per-status behaviour. Never prints anything.
import { flushSpool } from './lib/flush-runner.mjs';
import { configPaths, processContext } from './lib/paths.mjs';

flushSpool(configPaths(processContext()), process.env)
  .catch(() => undefined)
  .finally(() => process.exit(0));

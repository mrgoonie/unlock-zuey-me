// Small file helpers for the private config dir: 0700 directories, 0600 files written atomically
// (write tmp → fsync → rename), and tolerant JSON reads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Creates `dir` (and parents) with mode 0700 and tightens an existing dir to 0700 on POSIX. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* not our dir to change; the files are still 0600 */ }
  }
}

/** Writes `text` to `file` atomically with mode 0600. The parent dir must exist. */
export function writePrivateFileAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Parsed JSON object from `file`, or null when missing, unreadable or not an object. */
export function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Permission bits of `file`, or null when it does not exist. */
export function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

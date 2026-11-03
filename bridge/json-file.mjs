import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const READ_RETRIES = 5;
const READ_RETRY_MS = 20;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;

const sleepView = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(sleepView, 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Writes JSON to a temp file in the same directory, then renames it over
 * `file`, so a concurrent reader never sees a half-written document.
 * `mode` (e.g. 0o600) is applied to the new file; without it an existing
 * file's mode is preserved.
 * @param {string} file
 * @param {unknown} value
 * @param {{ mode?: number }} [opts]
 */
export function writeJsonAtomic(file, value, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (mode === undefined && fs.existsSync(file)) {
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      /* stat raced a rename; default mode applies */
    }
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? {} : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp already gone */
    }
    throw err;
  }
}

/**
 * Reads and parses `file`. A missing file returns `fallback`. A file that
 * exists but does not parse is retried a few times (a writer may have been
 * mid-rename) and then throws — the fallback is never returned for a file
 * that exists, so a transient bad read cannot wipe the store on the next
 * write.
 * @param {string} file
 * @param {unknown} fallback
 */
export function readJson(file, fallback) {
  let lastErr;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return fallback;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      sleepSync(READ_RETRY_MS);
    }
  }
  throw lastErr;
}

function lockFilePath(file) {
  return `${file}.lock`;
}

function staleLock(lockFile) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    // Unreadable content: a fresh file may be mid-creation, only an old
    // corrupt lock is stale.
    try {
      return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  if (!pidAlive(lock?.pid)) return true;
  const at = Date.parse(lock?.at);
  return Number.isFinite(at) && Date.now() - at > LOCK_STALE_MS;
}

function acquireFileLock(lockFile) {
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    // tmp + link, so the lock file never exists empty: a waiter that sees
    // it always reads a complete {pid, at} and cannot steal a live lock.
    const tmp = `${lockFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let acquired = false;
    try {
      fs.writeFileSync(tmp, payload);
      fs.linkSync(tmp, lockFile);
      acquired = true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* tmp already gone */
      }
    }
    if (acquired) return;
    if (staleLock(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* another waiter removed it */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const e = new Error(`Timed out waiting for ${lockFile}`);
      e.code = "json_file_locked";
      throw e;
    }
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
}

/**
 * Cross-process read-modify-write on `file` under an exclusive
 * `<file>.lock` file. `fn` receives the parsed value (or `fallback` when
 * the file is missing) and returns the value to store; returning
 * `undefined` keeps the value it received and mutates in place.
 * @param {string} file
 * @param {unknown} fallback
 * @param {(current: unknown) => unknown} fn
 * @param {{ mode?: number }} [opts]
 */
export function updateJson(file, fallback, fn, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = lockFilePath(file);
  acquireFileLock(lockFile);
  try {
    const current = readJson(file, fallback);
    const next = fn(current);
    const value = next === undefined ? current : next;
    writeJsonAtomic(file, value, mode === undefined ? {} : { mode });
    return value;
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* lock already gone */
    }
  }
}

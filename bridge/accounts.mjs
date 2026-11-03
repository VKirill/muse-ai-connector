import fs from "node:fs";
import path from "node:path";
import { readJson, updateJson, writeJsonAtomic } from "./json-file.mjs";
import { bridgeHome, profileDir } from "./paths.mjs";

const STALE_LOCK_MS = 30 * 60 * 1000;
const MAX_PARALLEL_CAP = 50;
const DEFAULT_MAX_PARALLEL = 10;
const STATUSES = new Set(["signed_in", "signed_out", "unknown"]);

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   profileDir: string,
 *   status: "signed_in" | "signed_out" | "unknown",
 *   maxParallel?: number,
 *   createdAt: string,
 *   lastUsedAt: string,
 *   lastCheckedAt: string,
 * }} Account
 */

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

function registryPath() {
  return path.join(bridgeHome(), "accounts.json");
}

function lockPath(id) {
  return path.join(bridgeHome(), "locks", `${id}.lock`);
}

function slotPath(id, n) {
  if (n === 0) return lockPath(id);
  return path.join(bridgeHome(), "locks", `${id}.${n}.lock`);
}

function emptyRegistry() {
  return { version: 1, accounts: [] };
}

function saveRegistry(registry) {
  const home = bridgeHome();
  fs.mkdirSync(home, { recursive: true });
  writeJsonAtomic(registryPath(), registry);
}

function slugify(label) {
  const slug = String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "account";
}

function uniqueId(label, used) {
  const base = slugify(label);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

function migrateDefaultIfNeeded() {
  if (fs.existsSync(registryPath())) return;
  const defaultProfile = profileDir("default");
  if (!fs.existsSync(defaultProfile)) return;
  const at = nowIso();
  saveRegistry({
    version: 1,
    accounts: [
      {
        id: "default",
        label: "default",
        profileDir: defaultProfile,
        status: "unknown",
        createdAt: at,
        lastUsedAt: at,
        lastCheckedAt: at,
      },
    ],
  });
}

function normalizeRegistry(parsed) {
  if (!parsed || !Array.isArray(parsed.accounts)) return emptyRegistry();
  return { version: 1, accounts: parsed.accounts };
}

function loadRegistry() {
  migrateDefaultIfNeeded();
  return normalizeRegistry(readJson(registryPath(), null));
}

function updateRegistry(fn) {
  return updateJson(registryPath(), null, (parsed) => {
    const registry = parsed === null ? loadRegistry() : normalizeRegistry(parsed);
    return fn(registry);
  });
}

function requireAccount(registry, id) {
  const account = registry.accounts.find((a) => a.id === id);
  if (!account) throw codedError("unknown_account", `Unknown account: ${id}`);
  return account;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isStaleLock(lock) {
  if (!lock) return true;
  if (!pidAlive(lock.pid)) return true;
  const at = Date.parse(lock.at);
  if (Number.isFinite(at) && Date.now() - at > STALE_LOCK_MS) return true;
  return false;
}

function slotLockFiles(id) {
  const dir = path.join(bridgeHome(), "locks");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    let n = null;
    if (name === `${id}.lock`) {
      n = 0;
    } else if (name.startsWith(`${id}.`) && name.endsWith(".lock")) {
      const middle = name.slice(id.length + 1, -".lock".length);
      if (/^\d+$/.test(middle)) n = Number(middle);
    }
    if (n !== null) files.push({ n, file: path.join(dir, name) });
  }
  return files;
}

function liveSlots(id) {
  const live = new Set();
  for (const { n, file } of slotLockFiles(id)) {
    if (!isStaleLock(readLock(file))) live.add(n);
  }
  return live;
}

/**
 * @param {Account | null | undefined} account
 * @returns {number}
 */
function maxParallelFor(account) {
  const fromAccount = Number(account?.maxParallel);
  if (Number.isInteger(fromAccount) && fromAccount >= 1) return Math.min(fromAccount, MAX_PARALLEL_CAP);
  const fromEnv = Number(process.env.MUSE_MAX_PARALLEL);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return Math.min(fromEnv, MAX_PARALLEL_CAP);
  return DEFAULT_MAX_PARALLEL;
}

/** @param {string} id */
function findAccount(id) {
  return loadRegistry().accounts.find((a) => a.id === id) ?? null;
}

/** @param {string} id */
export function maxParallelOf(id) {
  return maxParallelFor(findAccount(id));
}

/** @returns {Account[]} */
export function listAccounts() {
  return loadRegistry().accounts;
}

/**
 * @param {string} label
 * @returns {Account}
 */
export function addAccount(label) {
  if (!label || !String(label).trim()) throw codedError("invalid_label", "Account label is required");
  let account;
  updateRegistry((registry) => {
    const used = new Set(registry.accounts.map((a) => a.id));
    const id = uniqueId(label, used);
    const at = nowIso();
    const dir = profileDir(id);
    fs.mkdirSync(dir, { recursive: true });
    account = {
      id,
      label: String(label).trim(),
      profileDir: dir,
      status: "unknown",
      createdAt: at,
      lastUsedAt: at,
      lastCheckedAt: at,
    };
    registry.accounts.push(account);
    return registry;
  });
  return account;
}

/**
 * @param {string} id
 * @param {{ purge?: boolean }} [opts]
 */
export function removeAccount(id, { purge = false } = {}) {
  updateRegistry((registry) => {
    requireAccount(registry, id);
    registry.accounts = registry.accounts.filter((a) => a.id !== id);
    return registry;
  });
  for (const { file } of slotLockFiles(id)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  if (purge) fs.rmSync(profileDir(id), { recursive: true, force: true });
}

/**
 * @param {string} id
 * @param {"signed_in" | "signed_out" | "unknown"} status
 */
export function setStatus(id, status) {
  if (!STATUSES.has(status)) throw codedError("invalid_status", `Invalid status: ${status}`);
  let account;
  updateRegistry((registry) => {
    account = requireAccount(registry, id);
    account.status = status;
    account.lastCheckedAt = nowIso();
    return registry;
  });
  return account;
}

/** @param {string} id */
export function touch(id) {
  let account;
  updateRegistry((registry) => {
    account = requireAccount(registry, id);
    account.lastUsedAt = nowIso();
    return registry;
  });
  return account;
}

/**
 * @param {string} id
 * @param {number} value
 * @returns {Account}
 */
export function setMaxParallel(id, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL_CAP) {
    throw codedError("invalid_max_parallel", `maxParallel must be an integer 1..${MAX_PARALLEL_CAP}, got ${value}`);
  }
  let account;
  updateRegistry((registry) => {
    account = requireAccount(registry, id);
    account.maxParallel = n;
    return registry;
  });
  return account;
}

/** @param {string} id */
export function busySlots(id) {
  return liveSlots(id).size;
}

/** @param {string} id */
export function isLocked(id) {
  const max = maxParallelFor(findAccount(id));
  const live = liveSlots(id);
  for (let n = 0; n < max; n++) {
    if (!live.has(n)) return false;
  }
  return true;
}

/**
 * @param {string} id
 * @param {{ owner?: string }} [opts]
 * @returns {() => void}
 */
export function acquire(id, { owner } = {}) {
  fs.mkdirSync(path.join(bridgeHome(), "locks"), { recursive: true });
  const max = maxParallelFor(findAccount(id));
  const payload = `${JSON.stringify({
    pid: process.pid,
    owner: owner ?? `pid:${process.pid}`,
    at: nowIso(),
  })}\n`;
  for (let n = 0; n < max; n++) {
    const file = slotPath(id, n);
    let held = false;
    try {
      fs.writeFileSync(file, payload, { flag: "wx" });
      held = true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (isStaleLock(readLock(file))) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
        try {
          fs.writeFileSync(file, payload, { flag: "wx" });
          held = true;
        } catch (retry) {
          if (retry.code !== "EEXIST") throw retry;
        }
      }
    }
    if (!held) continue;
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    };
  }
  throw codedError("account_locked", `Account ${id} is locked`);
}

/**
 * @param {{ prefer?: string }} [opts]
 * @returns {Account}
 */
export function pickAccount({ prefer } = {}) {
  const accounts = listAccounts();
  if (prefer) {
    const preferred = accounts.find((a) => a.id === prefer);
    if (preferred && preferred.status === "signed_in" && !isLocked(preferred.id)) return preferred;
  }
  const signedIn = accounts.filter((a) => a.status === "signed_in");
  const unknown = accounts.filter((a) => a.status === "unknown");
  const candidates = [...signedIn, ...unknown];
  if (candidates.length === 0) {
    throw codedError("no_signed_in_account", "No signed-in Muse account");
  }
  const freeSigned = signedIn.filter((a) => !isLocked(a.id));
  const freeUnknown = unknown.filter((a) => !isLocked(a.id));
  const pool = freeSigned.length > 0 ? freeSigned : freeUnknown;
  if (pool.length === 0) {
    throw codedError("no_free_account", "All Muse accounts are busy");
  }
  pool.sort(
    (a, b) =>
      busySlots(a.id) - busySlots(b.id) ||
      String(a.lastUsedAt ?? "").localeCompare(String(b.lastUsedAt ?? "")),
  );
  return pool[0];
}

import fs from "node:fs";
import path from "node:path";
import { bridgeHome, profileDir } from "./paths.mjs";

const STALE_LOCK_MS = 30 * 60 * 1000;
const STATUSES = new Set(["signed_in", "signed_out", "unknown"]);

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   profileDir: string,
 *   status: "signed_in" | "signed_out" | "unknown",
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

function emptyRegistry() {
  return { version: 1, accounts: [] };
}

function saveRegistry(registry) {
  const home = bridgeHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
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

function loadRegistry() {
  migrateDefaultIfNeeded();
  const file = registryPath();
  if (!fs.existsSync(file)) return emptyRegistry();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || !Array.isArray(parsed.accounts)) return emptyRegistry();
  return { version: 1, accounts: parsed.accounts };
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
  const registry = loadRegistry();
  const used = new Set(registry.accounts.map((a) => a.id));
  const id = uniqueId(label, used);
  const at = nowIso();
  const dir = profileDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const account = {
    id,
    label: String(label).trim(),
    profileDir: dir,
    status: "unknown",
    createdAt: at,
    lastUsedAt: at,
    lastCheckedAt: at,
  };
  registry.accounts.push(account);
  saveRegistry(registry);
  return account;
}

/**
 * @param {string} id
 * @param {{ purge?: boolean }} [opts]
 */
export function removeAccount(id, { purge = false } = {}) {
  const registry = loadRegistry();
  requireAccount(registry, id);
  registry.accounts = registry.accounts.filter((a) => a.id !== id);
  saveRegistry(registry);
  const lock = lockPath(id);
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
  if (purge) fs.rmSync(profileDir(id), { recursive: true, force: true });
}

/**
 * @param {string} id
 * @param {"signed_in" | "signed_out" | "unknown"} status
 */
export function setStatus(id, status) {
  if (!STATUSES.has(status)) throw codedError("invalid_status", `Invalid status: ${status}`);
  const registry = loadRegistry();
  const account = requireAccount(registry, id);
  account.status = status;
  account.lastCheckedAt = nowIso();
  saveRegistry(registry);
  return account;
}

/** @param {string} id */
export function touch(id) {
  const registry = loadRegistry();
  const account = requireAccount(registry, id);
  account.lastUsedAt = nowIso();
  saveRegistry(registry);
  return account;
}

/** @param {string} id */
export function isLocked(id) {
  const file = lockPath(id);
  if (!fs.existsSync(file)) return false;
  return !isStaleLock(readLock(file));
}

/**
 * @param {string} id
 * @param {{ owner?: string }} [opts]
 * @returns {() => void}
 */
export function acquire(id, { owner } = {}) {
  fs.mkdirSync(path.join(bridgeHome(), "locks"), { recursive: true });
  const file = lockPath(id);
  const payload = `${JSON.stringify({
    pid: process.pid,
    owner: owner ?? `pid:${process.pid}`,
    at: nowIso(),
  })}\n`;
  try {
    fs.writeFileSync(file, payload, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const existing = readLock(file);
    if (!isStaleLock(existing)) {
      throw codedError("account_locked", `Account ${id} is locked`);
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
    fs.writeFileSync(file, payload, { flag: "wx" });
  }
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
  pool.sort((a, b) => String(a.lastUsedAt ?? "").localeCompare(String(b.lastUsedAt ?? "")));
  return pool[0];
}

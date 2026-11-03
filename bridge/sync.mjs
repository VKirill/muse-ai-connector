import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listAccounts } from "./accounts.mjs";
import { cookiesPath, loadCookies } from "./cookies.mjs";
import { readJson, updateJson } from "./json-file.mjs";
import { bridgeHome } from "./paths.mjs";

const SSH_TIMEOUT_MS = 30_000;

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function syncTargetsPath() {
  return path.join(bridgeHome(), "sync.json");
}

function readTargets() {
  const parsed = readJson(syncTargetsPath(), null);
  if (!parsed || !Array.isArray(parsed.targets)) return [];
  return parsed.targets
    .filter((t) => t && typeof t.name === "string" && t.name.trim())
    .map((t) => ({ name: t.name }));
}

/** @returns {{ name: string }[]} */
export function listTargets() {
  return readTargets();
}

/** @param {string} name */
export function addTarget(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw codedError("invalid_target", "Sync target name is required");
  updateJson(
    syncTargetsPath(),
    { targets: [] },
    (current) => {
      const targets = Array.isArray(current?.targets) ? current.targets : [];
      if (!targets.some((t) => t && t.name === trimmed)) targets.push({ name: trimmed });
      return { targets };
    },
    { mode: 0o600 },
  );
}

/** @param {string} name */
export function removeTarget(name) {
  updateJson(
    syncTargetsPath(),
    { targets: [] },
    (current) => {
      const targets = Array.isArray(current?.targets) ? current.targets : [];
      return { targets: targets.filter((t) => t && t.name !== name) };
    },
    { mode: 0o600 },
  );
}

function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Default runner: spawn `cmd args`, feed `input` to its stdin, resolve with
 * stdout on exit 0, reject with the first stderr line otherwise. The cookie
 * payload only ever travels on stdin — never argv.
 */
function sshRun(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "utf8", timeout: SSH_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const detail =
        String(stderr ?? "")
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean) ?? error.message;
      reject(new Error(detail || "ssh failed"));
    });
    child.stdin.end(input, "utf8");
  });
}

function labelFor(id) {
  return listAccounts().find((a) => a.id === id)?.label ?? id;
}

/**
 * Push the account's cookies to every sync target over ssh:
 * `ssh -o BatchMode=yes -o ConnectTimeout=10 <name> musebridge accounts import <id> --label <label>`
 * with the cookies JSON on stdin. `run` (cmd, args, input) is injectable for
 * tests. One failed target never throws; the result is one entry per target.
 * @param {string} id
 * @param {{ targets?: ({name:string}|string)[], run?: Function }} [opts]
 * @returns {Promise<{name: string, ok: boolean, error?: string}[]>}
 */
export async function syncAccount(id, { targets, run } = {}) {
  const names = (targets ?? readTargets()).map((t) => (typeof t === "string" ? t : t.name));
  if (names.length === 0) return [];
  const cookies = loadCookies(id);
  const remote = `musebridge accounts import ${shq(id)} --label ${shq(labelFor(id))}`;
  const results = [];
  for (const name of names) {
    try {
      await (run ?? sshRun)("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", name, remote], JSON.stringify(cookies));
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.message ?? error) });
    }
  }
  return results;
}

/**
 * Push every signed-in account that has a cookies file to every target.
 * @param {{ run?: Function }} [opts]
 * @returns {Promise<{account: string, name: string, ok: boolean, error?: string}[]>}
 */
export async function syncAll({ run } = {}) {
  const targets = readTargets();
  if (targets.length === 0) return [];
  const results = [];
  for (const account of listAccounts()) {
    if (account.status !== "signed_in" || !fs.existsSync(cookiesPath(account.id))) continue;
    for (const r of await syncAccount(account.id, { targets, run })) {
      results.push({ account: account.id, ...r });
    }
  }
  return results;
}

/**
 * Push one account only when targets exist and it has a cookies file.
 * @param {string} id
 * @param {{ run?: Function }} [opts]
 * @returns {Promise<{account: string, name: string, ok: boolean, error?: string}[]>}
 */
export async function syncIfTargets(id, { run } = {}) {
  const targets = readTargets();
  if (targets.length === 0 || !fs.existsSync(cookiesPath(id))) return [];
  return (await syncAccount(id, { targets, run })).map((r) => ({ account: id, ...r }));
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addAccount, setStatus } from "../bridge/accounts.mjs";
import { readJson, updateJson, writeJsonAtomic } from "../bridge/json-file.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function withHome(home, fn) {
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

function spawnWorker(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, err }));
  });
}

const ACCOUNT_WORKER = `import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, id, n] = process.argv.slice(2);
const acc = await import(pathToFileURL(path.join(root, "bridge/accounts.mjs")).href);
for (let i = 0; i < Number(n); i++) { acc.touch(id); acc.listAccounts(); acc.pickAccount(); }
`;

const SESSION_WORKER = `import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, prefix, n] = process.argv.slice(2);
const acp = await import(pathToFileURL(path.join(root, "bin/muse-acp.mjs")).href);
for (let i = 0; i < Number(n); i++) {
  acp.saveSession({ id: prefix + "-" + i, accountId: "a", museChatId: "chat-" + i, cwd: "/" });
}
`;

test("writeJsonAtomic writes the file, keeps mode 0600 and leaves no .tmp", () => {
  const dir = fs.mkdtempSync("/tmp/muse-json-");
  const file = path.join(dir, "state.json");
  writeJsonAtomic(file, { a: 1 }, { mode: 0o600 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 2 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("readJson returns the fallback for a missing file and throws for a corrupt one", () => {
  const dir = fs.mkdtempSync("/tmp/muse-json-");
  assert.deepEqual(readJson(path.join(dir, "missing.json"), { d: 1 }), { d: 1 });
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.throws(() => readJson(bad, {}));
});

test("updateJson takes over a lock left by a dead process", () => {
  const dir = fs.mkdtempSync("/tmp/muse-json-");
  const file = path.join(dir, "x.json");
  fs.writeFileSync(file, `${JSON.stringify({ n: 1 })}\n`);
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999_999_999, at: new Date(Date.now() - 60_000).toISOString() }));
  const value = updateJson(file, {}, (current) => ({ ...current, n: current.n + 1 }));
  assert.equal(value.n, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).n, 2);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("concurrent touch/listAccounts/pickAccount on one registry have zero crashes", { timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync("/tmp/muse-json-home-");
  const workerFile = path.join(home, "account-worker.mjs");
  fs.writeFileSync(workerFile, ACCOUNT_WORKER);
  const accountId = withHome(home, () => {
    const a = addAccount("a");
    setStatus(a.id, "signed_in");
    for (let k = 0; k < 6; k++) addAccount(`pad${k}`);
    return a.id;
  });
  const runs = Array.from({ length: 8 }, () => spawnWorker(workerFile, [root, accountId, "80"], { MUSE_BRIDGE_HOME: home }));
  const out = await Promise.all(runs);
  const bad = out.filter((r) => r.code !== 0);
  assert.equal(bad.length, 0, bad[0]?.err.trim().slice(0, 300));
  JSON.parse(fs.readFileSync(path.join(home, "accounts.json"), "utf8"));
  const leftovers = fs.readdirSync(home).filter((name) => name.endsWith(".tmp") || name.endsWith(".json.lock"));
  assert.deepEqual(leftovers, []);
});

test("two processes saving different muse-acp sessions both end up in sessions.json", { timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync("/tmp/muse-json-sessions-");
  const workerFile = path.join(home, "session-worker.mjs");
  fs.writeFileSync(workerFile, SESSION_WORKER);
  const runs = ["p1", "p2"].map((prefix) => spawnWorker(workerFile, [root, prefix, "50"], { MUSE_BRIDGE_HOME: home }));
  const out = await Promise.all(runs);
  const bad = out.filter((r) => r.code !== 0);
  assert.equal(bad.length, 0, bad[0]?.err.trim().slice(0, 300));
  const store = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"));
  for (const prefix of ["p1", "p2"]) {
    for (let i = 0; i < 50; i++) {
      assert.ok(store[`${prefix}-${i}`], `sessions.json lost ${prefix}-${i}`);
    }
  }
  assert.equal(fs.existsSync(path.join(home, "sessions.json.lock")), false);
});

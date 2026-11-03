import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addAccount } from "../bridge/accounts.mjs";
import { saveCookies } from "../bridge/cookies.mjs";
import { syncAcrossHosts } from "../bridge/hub-sync.mjs";
import { PLUGIN_VERSION } from "../version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "musebridge.mjs");
const cookie = { name: "sid", value: "slot-sync", domain: ".muse.ai", path: "/" };

function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-slots-sync-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

function runCli(args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, ...env }, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      },
    );
    child.stdin.end(input ?? "");
  });
}

test("export of an account without an explicit maxParallel has no maxParallel key", async () => {
  await withHome(async (home) => {
    addAccount("Main");
    saveCookies("main", [cookie]);
    const r = await runCli(["accounts", "export", "main", "--json"], { env: { MUSE_BRIDGE_HOME: home } });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(Object.hasOwn(parsed, "maxParallel"), false);
    assert.equal(parsed.id, "main");
    assert.deepEqual(parsed.cookies, [cookie]);
  });
});

test("syncAcrossHosts passes maxParallel from exportAccount to importAccount", async () => {
  const calls = [];
  const call = async (method, input, { hostId }) => {
    calls.push({ method, hostId, input });
    if (method === "exportAccount") {
      return { id: input.id, label: "Main", cookies: [cookie], maxParallel: 7 };
    }
    if (method === "importAccount") return { ok: true };
    throw new Error(`unexpected ${method}`);
  };
  const hosts = [
    { hostId: "h1", connected: true, runtime: true },
    { hostId: "h2", connected: true, runtime: true },
  ];
  const res = await syncAcrossHosts({ sourceHostId: "h1", accountId: "main", hosts, call });
  const imported = calls.filter((c) => c.method === "importAccount");
  assert.equal(imported.length, 1);
  assert.equal(imported[0].hostId, "h2");
  assert.equal(imported[0].input.maxParallel, 7);
  assert.equal(imported[0].input.id, "main");
  assert.equal(res[0].ok, true);
});

test("version 0.3.8 in package.json, package-lock.json and version.ts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, "0.3.8");
  assert.equal(lock.version, "0.3.8");
  assert.equal(lock.packages[""].version, "0.3.8");
  assert.equal(PLUGIN_VERSION, "0.3.8");
});

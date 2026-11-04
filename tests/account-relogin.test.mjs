import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PLUGIN_VERSION } from "../version.ts";
import { reloginSummary } from "../i18n.ts";

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "musebridge.mjs");

function runCli(args, env = {}) {
  return execFileP(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).then(
    (r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );
}

test("accounts login nope with empty home exits 2 and names the unknown account", async () => {
  const home = fs.mkdtempSync("/tmp/muse-relogin-");
  const r = await runCli(["accounts", "login", "nope"], { MUSE_BRIDGE_HOME: home });
  assert.doesNotMatch(r.stderr, /Usage: musebridge accounts list\|add/);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown account: nope/);
});

test("musebridge --help lists accounts login <id>", async () => {
  const home = fs.mkdtempSync("/tmp/muse-relogin-help-");
  const r = await runCli(["--help"], { MUSE_BRIDGE_HOME: home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /accounts login <id>/);
});

test("reloginSummary all-ok counts only ok rows", () => {
  const hosts = [
    { hostId: "h1", name: "MacBook", connected: true, status: null, error: null },
    { hostId: "h2", name: "Mini", connected: true, status: null, error: null },
  ];
  const synced = [
    { accountId: "work", hostId: "h1", ok: true, error: null },
    { accountId: "work", hostId: "h2", ok: true, error: null },
  ];
  assert.deepEqual(reloginSummary(synced, hosts, "ru"), {
    kind: "ok",
    text: "Вход выполнен, скопирован на 2 машин",
  });
});

test("reloginSummary one failed row names the machine and error", () => {
  const hosts = [
    { hostId: "h1", name: "MacBook", connected: true, status: null, error: null },
    { hostId: "h2", name: "MAC Mini", connected: true, status: null, error: null },
  ];
  const synced = [
    { accountId: "work", hostId: "h1", ok: true, error: null },
    { accountId: "work", hostId: "h2", ok: false, error: "ssh failed" },
  ];
  assert.deepEqual(reloginSummary(synced, hosts, "ru"), {
    kind: "err",
    text: "Вход выполнен, но не скопирован на: MAC Mini (ssh failed)",
  });
});

test("reloginSummary no other hosts is an ok summary with count 0", () => {
  assert.deepEqual(reloginSummary([], [], "ru"), {
    kind: "ok",
    text: "Вход выполнен, скопирован на 0 машин",
  });
});

test("version is 0.3.17", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(PLUGIN_VERSION, "0.3.17");
  assert.equal(pkg.version, "0.3.17");
});

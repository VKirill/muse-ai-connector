import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addAccount } from "../bridge/accounts.mjs";
import { saveCookies } from "../bridge/cookies.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "musebridge.mjs");

const SECRET = "SECRET-VALUE-9";
const cookie = { name: "sid", value: SECRET, domain: ".muse.ai", path: "/" };

function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-export-");
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

test("accounts export <id> --json prints the saved cookies with id and label", async () => {
  await withHome(async (home) => {
    addAccount("Main");
    saveCookies("main", [cookie]);
    const r = await runCli(["accounts", "export", "main", "--json"], { env: { MUSE_BRIDGE_HOME: home } });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.id, "main");
    assert.equal(parsed.label, "Main");
    assert.deepEqual(parsed.cookies, [cookie]);
  });
});

test("accounts export without --json refuses and never prints cookie values", async () => {
  await withHome(async (home) => {
    addAccount("Main");
    saveCookies("main", [cookie]);
    const r = await runCli(["accounts", "export", "main"], { env: { MUSE_BRIDGE_HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Usage: musebridge accounts export/);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  });
});

test("accounts export of an unknown account fails without cookie values", async () => {
  await withHome(async (home) => {
    const r = await runCli(["accounts", "export", "ghost", "--json"], { env: { MUSE_BRIDGE_HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown account/);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  });
});

test("export piped into accounts import in a second home gives 0600 cookies.json and signed_in", async () => {
  const home1 = fs.mkdtempSync("/tmp/muse-export-src-");
  const home2 = fs.mkdtempSync("/tmp/muse-export-dst-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = home1;
  try {
    addAccount("Main");
    saveCookies("main", [cookie]);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
  const exported = await runCli(["accounts", "export", "main", "--json"], { env: { MUSE_BRIDGE_HOME: home1 } });
  assert.equal(exported.code, 0, exported.stderr);

  const imported = await runCli(["accounts", "import"], { input: exported.stdout, env: { MUSE_BRIDGE_HOME: home2 } });
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stdout, /imported 1 cookies for main/);

  const file = path.join(home2, "accounts", "main", "cookies.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [cookie]);

  const listed = await runCli(["accounts", "list", "--json"], { env: { MUSE_BRIDGE_HOME: home2 } });
  assert.equal(listed.code, 0, listed.stderr);
  const entry = JSON.parse(listed.stdout).find((a) => a.id === "main");
  assert.equal(entry.status, "signed_in");
  assert.equal(entry.label, "Main");
});

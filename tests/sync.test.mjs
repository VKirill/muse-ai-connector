import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addAccount, setStatus } from "../bridge/accounts.mjs";
import { saveCookies } from "../bridge/cookies.mjs";
import {
  addTarget,
  listTargets,
  removeTarget,
  syncAccount,
  syncAll,
  syncIfTargets,
  syncTargetsPath,
} from "../bridge/sync.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "musebridge.mjs");

async function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-sync-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

const SECRET = "SECRET-VALUE-1";
const cookie = { name: "sid", value: SECRET, domain: ".muse.ai", path: "/" };

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

test("targets add dedupes and stores sync.json with mode 0600, remove drops one", () =>
  withHome(() => {
    addTarget("ovh-main");
    addTarget("ovh-main");
    addTarget("mini");
    assert.deepEqual(listTargets(), [{ name: "ovh-main" }, { name: "mini" }]);
    assert.equal(fs.statSync(syncTargetsPath()).mode & 0o777, 0o600);
    removeTarget("ovh-main");
    assert.deepEqual(listTargets(), [{ name: "mini" }]);
  }));

test("syncAccount sends cookies on stdin to ssh -o BatchMode=yes, never in argv", () =>
  withHome(async () => {
    const account = addAccount("Work");
    setStatus(account.id, "signed_in");
    saveCookies(account.id, [cookie]);
    addTarget("fakehost");
    const calls = [];
    const results = await syncAccount(account.id, {
      run: async (cmd, args, input) => {
        calls.push({ cmd, args, input });
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "fakehost");
    assert.equal(results[0].ok, true);
    assert.equal(calls.length, 1);
    const { cmd, args, input } = calls[0];
    assert.equal(cmd, "ssh");
    const argv = args.join(" ");
    assert.match(argv, /-o BatchMode=yes/);
    assert.match(argv, /fakehost/);
    assert.match(argv, /musebridge accounts import '?work'?/);
    assert.match(argv, /--label '?Work'?/);
    assert.ok(!argv.includes(SECRET));
    assert.deepEqual(JSON.parse(input), [cookie]);
  }));

test("one failing target does not stop the next", () =>
  withHome(async () => {
    const account = addAccount("Work");
    setStatus(account.id, "signed_in");
    saveCookies(account.id, [cookie]);
    addTarget("bad");
    addTarget("good");
    const seen = [];
    const results = await syncAccount(account.id, {
      run: async (cmd, args) => {
        const host = args[args.length - 2];
        seen.push(host);
        if (host === "bad") throw new Error("ssh: connect failed");
      },
    });
    assert.deepEqual(seen, ["bad", "good"]);
    assert.deepEqual(
      results.map((r) => [r.name, r.ok]),
      [
        ["bad", false],
        ["good", true],
      ],
    );
    assert.match(results[0].error, /connect failed/);
  }));

test("syncIfTargets is a no-op without targets and pushes signed-in cookies with them", () =>
  withHome(async () => {
    const account = addAccount("Work");
    setStatus(account.id, "signed_in");
    saveCookies(account.id, [cookie]);
    const calls = [];
    const run = async (cmd, args, input) => {
      calls.push({ args, input });
    };
    assert.deepEqual(await syncIfTargets(account.id, { run }), []);
    addTarget("fakehost");
    const results = await syncIfTargets(account.id, { run });
    assert.equal(results.length, 1);
    assert.equal(results[0].account, account.id);
    assert.equal(results[0].ok, true);
    assert.equal(calls.length, 1);
  }));

test("syncAll skips accounts that are not signed in", () =>
  withHome(async () => {
    const signed = addAccount("Signed");
    const out = addAccount("Out");
    setStatus(signed.id, "signed_in");
    setStatus(out.id, "signed_out");
    saveCookies(signed.id, [cookie]);
    saveCookies(out.id, [cookie]);
    addTarget("fakehost");
    const seen = [];
    const results = await syncAll({
      run: async (cmd, args) => {
        seen.push(args.join(" "));
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].account, signed.id);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /accounts import '?signed'?/);
  }));

test("accounts import reads cookies from stdin, writes mode 0600, registers signed_in", () =>
  withHome(async (home) => {
    const res = await runCli(["accounts", "import", "acc-b", "--label", "Acc B"], {
      input: JSON.stringify([cookie]),
      env: { MUSE_BRIDGE_HOME: home },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, "imported 1 cookies for acc-b\n");
    assert.ok(!res.stdout.includes(SECRET));
    assert.ok(!res.stderr.includes(SECRET));
    const file = path.join(home, "accounts", "acc-b", "cookies.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [cookie]);
    const registry = JSON.parse(fs.readFileSync(path.join(home, "accounts.json"), "utf8"));
    const entry = registry.accounts.find((a) => a.id === "acc-b");
    assert.equal(entry.label, "Acc B");
    assert.equal(entry.status, "signed_in");
  }));

test("accounts import rejects junk on stdin", () =>
  withHome(async (home) => {
    const res = await runCli(["accounts", "import", "acc-b"], {
      input: "not json",
      env: { MUSE_BRIDGE_HOME: home },
    });
    assert.equal(res.code, 1);
    assert.ok(!fs.existsSync(path.join(home, "accounts", "acc-b", "cookies.json")));
  }));

test("a successful accounts refresh pushes the cookies to the configured target", () =>
  withHome(async (home) => {
    addTarget("fakehost");
    const bin = fs.mkdtempSync("/tmp/muse-sync-bin-");
    const log = path.join(bin, "ssh.log");
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/bash\necho "$@" >> "${log}"\ncat > "${log}.stdin"\n`);
    fs.chmodSync(path.join(bin, "ssh"), 0o755);
    const { cmdAccountsRefresh } = await import("../bin/musebridge.mjs");
    const session = {
      isSignedIn: async () => true,
      exportCookies: async () => [cookie],
      close: async () => {},
    };
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await cmdAccountsRefresh(["acc1"], { openSession: async () => session });
    } finally {
      process.env.PATH = prevPath;
    }
    const argv = fs.readFileSync(log, "utf8");
    assert.match(argv, /-o BatchMode=yes/);
    assert.match(argv, /fakehost/);
    assert.match(argv, /musebridge accounts import '?acc1'?/);
    assert.ok(!argv.includes(SECRET));
    assert.deepEqual(JSON.parse(fs.readFileSync(`${log}.stdin`, "utf8")), [cookie]);
    const saved = JSON.parse(fs.readFileSync(path.join(home, "accounts", "acc1", "cookies.json"), "utf8"));
    assert.deepEqual(saved, [cookie]);
  }));

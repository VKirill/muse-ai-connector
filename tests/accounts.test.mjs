import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  acquire,
  addAccount,
  isLocked,
  listAccounts,
  pickAccount,
  removeAccount,
  setMaxParallel,
  setStatus,
  touch,
} from "../bridge/accounts.mjs";

const execFileP = promisify(execFile);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "musebridge.mjs");

function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-acc-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

test("addAccount and listAccounts register a profile with status unknown", () => {
  withHome(() => {
    const account = addAccount("Work");
    assert.equal(account.id, "work");
    assert.equal(account.label, "Work");
    assert.equal(account.status, "unknown");
    assert.equal(fs.existsSync(account.profileDir), true);
    const listed = listAccounts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "work");
  });
});

test("equal labels get unique ids with -2 suffix", () => {
  withHome(() => {
    assert.equal(addAccount("Personal").id, "personal");
    assert.equal(addAccount("Personal").id, "personal-2");
    assert.deepEqual(
      listAccounts().map((a) => a.id),
      ["personal", "personal-2"],
    );
  });
});

test("removeAccount with purge deletes the profile directory", () => {
  withHome(() => {
    const account = addAccount("Temp");
    const dir = account.profileDir;
    fs.writeFileSync(path.join(dir, "marker"), "x");
    removeAccount(account.id, { purge: true });
    assert.equal(listAccounts().length, 0);
    assert.equal(fs.existsSync(dir), false);
  });
});

test("removeAccount without purge keeps the profile directory", () => {
  withHome(() => {
    const account = addAccount("Keep");
    const dir = account.profileDir;
    removeAccount(account.id, { purge: false });
    assert.equal(listAccounts().length, 0);
    assert.equal(fs.existsSync(dir), true);
  });
});

test("migrates an existing profiles/default into account default", () => {
  withHome((home) => {
    const defaultProfile = path.join(home, "profiles", "default");
    fs.mkdirSync(defaultProfile, { recursive: true });
    const listed = listAccounts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "default");
    assert.equal(listed[0].label, "default");
    assert.equal(listed[0].status, "unknown");
  });
});

test("pickAccount returns the signed-in unlocked account with the oldest lastUsedAt", () => {
  withHome(() => {
    const older = addAccount("Alpha");
    const newer = addAccount("Beta");
    setStatus(older.id, "signed_in");
    setStatus(newer.id, "signed_in");
    touch(newer.id);
    const picked = pickAccount();
    assert.equal(picked.id, older.id);
    touch(older.id);
    assert.equal(pickAccount().id, newer.id);
  });
});

test("pickAccount throws no_free_account when all signed-in accounts are locked", () => {
  withHome(() => {
    const a = addAccount("A");
    const b = addAccount("B");
    setMaxParallel(a.id, 1);
    setMaxParallel(b.id, 1);
    setStatus(a.id, "signed_in");
    setStatus(b.id, "signed_in");
    const releaseA = acquire(a.id, { owner: "test" });
    const releaseB = acquire(b.id, { owner: "test" });
    try {
      assert.throws(() => pickAccount(), (err) => err.code === "no_free_account");
    } finally {
      releaseA();
      releaseB();
    }
  });
});

test("pickAccount throws no_signed_in_account when none is signed in", () => {
  withHome(() => {
    const a = addAccount("Solo");
    setStatus(a.id, "signed_out");
    assert.throws(() => pickAccount(), (err) => err.code === "no_signed_in_account");
  });
});

test("acquire replaces a lock whose pid is dead", () => {
  withHome((home) => {
    const account = addAccount("Deadlock");
    setMaxParallel(account.id, 1);
    setStatus(account.id, "signed_in");
    const file = path.join(home, "locks", `${account.id}.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ pid: 999_999_999, owner: "ghost", at: new Date().toISOString() })}\n`);
    assert.equal(isLocked(account.id), false);
    const release = acquire(account.id, { owner: "alive" });
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(stored.pid, process.pid);
      assert.equal(stored.owner, "alive");
      assert.equal(isLocked(account.id), true);
    } finally {
      release();
    }
    assert.equal(isLocked(account.id), false);
  });
});

test("musebridge accounts list --json with an empty home prints an array and exits 0", async () => {
  const dir = fs.mkdtempSync("/tmp/muse-acc-");
  const { stdout, stderr } = await execFileP(process.execPath, [cli, "accounts", "list", "--json"], {
    encoding: "utf8",
    env: { ...process.env, MUSE_BRIDGE_HOME: dir },
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), []);
});

test("musebridge accounts list --json includes locked false for a free account", async () => {
  const dir = fs.mkdtempSync("/tmp/muse-acc-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    addAccount("Work");
    const { stdout, stderr } = await execFileP(process.execPath, [cli, "accounts", "list", "--json"], {
      encoding: "utf8",
      env: { ...process.env, MUSE_BRIDGE_HOME: dir },
    });
    assert.equal(stderr, "");
    const listed = JSON.parse(stdout);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].locked, false);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
});

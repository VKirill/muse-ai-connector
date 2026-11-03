import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  acquire,
  addAccount,
  busySlots,
  isLocked,
  listAccounts,
  maxParallelOf,
  pickAccount,
  removeAccount,
  setMaxParallel,
  setStatus,
} from "../bridge/accounts.mjs";

function withHome(fn, { maxParallelEnv } = {}) {
  const dir = fs.mkdtempSync("/tmp/muse-slots-");
  const prevHome = process.env.MUSE_BRIDGE_HOME;
  const prevMax = process.env.MUSE_MAX_PARALLEL;
  process.env.MUSE_BRIDGE_HOME = dir;
  if (maxParallelEnv === undefined) delete process.env.MUSE_MAX_PARALLEL;
  else process.env.MUSE_MAX_PARALLEL = String(maxParallelEnv);
  try {
    return fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prevHome;
    if (prevMax === undefined) delete process.env.MUSE_MAX_PARALLEL;
    else process.env.MUSE_MAX_PARALLEL = prevMax;
  }
}

test("with no maxParallel and no MUSE_MAX_PARALLEL one account takes one prompt", () => {
  withHome(() => {
    const account = addAccount("Solo");
    const release = acquire(account.id, { owner: "first" });
    assert.throws(() => acquire(account.id, { owner: "second" }), (err) => err.code === "account_locked");
    release();
    const again = acquire(account.id, { owner: "third" });
    again();
  });
});

test("MUSE_MAX_PARALLEL=3 allows three slots, refuses the fourth, release frees one", () => {
  withHome(
    () => {
      const account = addAccount("Work");
      assert.equal(maxParallelOf(account.id), 3);
      const releases = [0, 1, 2].map((n) => acquire(account.id, { owner: `slot-${n}` }));
      assert.equal(busySlots(account.id), 3);
      assert.equal(isLocked(account.id), true);
      assert.throws(() => acquire(account.id, { owner: "overflow" }), (err) => err.code === "account_locked");
      releases[0]();
      assert.equal(busySlots(account.id), 2);
      assert.equal(isLocked(account.id), false);
      const reacquired = acquire(account.id, { owner: "reacquired" });
      assert.equal(busySlots(account.id), 3);
      for (const release of releases.slice(1)) release();
      reacquired();
      assert.equal(busySlots(account.id), 0);
    },
    { maxParallelEnv: 3 },
  );
});

test("extra slots use <id>.<n>.lock files and each release removes only its own", () => {
  withHome(
    (home) => {
      const account = addAccount("Files");
      const first = acquire(account.id, { owner: "a" });
      const second = acquire(account.id, { owner: "b" });
      const locks = path.join(home, "locks");
      assert.equal(fs.existsSync(path.join(locks, `${account.id}.lock`)), true);
      assert.equal(fs.existsSync(path.join(locks, `${account.id}.1.lock`)), true);
      first();
      assert.equal(fs.existsSync(path.join(locks, `${account.id}.lock`)), false);
      assert.equal(fs.existsSync(path.join(locks, `${account.id}.1.lock`)), true);
      second();
    },
    { maxParallelEnv: 2 },
  );
});

test("a dead process's slot is reclaimed", () => {
  withHome(
    (home) => {
      const account = addAccount("Ghost");
      const locks = path.join(home, "locks");
      fs.mkdirSync(locks, { recursive: true });
      const dead = `${JSON.stringify({ pid: 999_999_999, owner: "ghost", at: new Date().toISOString() })}\n`;
      fs.writeFileSync(path.join(locks, `${account.id}.lock`), dead);
      fs.writeFileSync(path.join(locks, `${account.id}.1.lock`), dead);
      assert.equal(busySlots(account.id), 0);
      const releases = [acquire(account.id, { owner: "a" }), acquire(account.id, { owner: "b" })];
      assert.equal(busySlots(account.id), 2);
      for (const release of releases) release();
    },
    { maxParallelEnv: 2 },
  );
});

test("account maxParallel beats MUSE_MAX_PARALLEL", () => {
  withHome(
    () => {
      const account = addAccount("Pinned");
      setMaxParallel(account.id, 2);
      assert.equal(listAccounts()[0].maxParallel, 2);
      const releases = [acquire(account.id), acquire(account.id)];
      assert.throws(() => acquire(account.id), (err) => err.code === "account_locked");
      for (const release of releases) release();
    },
    { maxParallelEnv: 5 },
  );
});

test("setMaxParallel rejects values outside 1..50", () => {
  withHome(() => {
    const account = addAccount("Bounds");
    assert.throws(() => setMaxParallel(account.id, 0), (err) => err.code === "invalid_max_parallel");
    assert.throws(() => setMaxParallel(account.id, 51), (err) => err.code === "invalid_max_parallel");
    assert.throws(() => setMaxParallel(account.id, "many"), (err) => err.code === "invalid_max_parallel");
    assert.equal(setMaxParallel(account.id, 50).maxParallel, 50);
  });
});

test("pickAccount prefers the signed-in account with the fewest busy slots", () => {
  withHome(
    () => {
      const a = addAccount("Alpha");
      const b = addAccount("Beta");
      setStatus(a.id, "signed_in");
      setStatus(b.id, "signed_in");
      const held = acquire(a.id, { owner: "busy" });
      try {
        assert.equal(pickAccount().id, b.id);
        const heldB = acquire(b.id, { owner: "busy-b" });
        try {
          assert.equal(pickAccount().id, a.id);
        } finally {
          heldB();
        }
      } finally {
        held();
      }
    },
    { maxParallelEnv: 2 },
  );
});

test("removeAccount clears every slot lock file", () => {
  withHome(
    (home) => {
      const account = addAccount("Gone");
      const releases = [acquire(account.id), acquire(account.id)];
      const locks = path.join(home, "locks");
      assert.equal(fs.readdirSync(locks).length, 2);
      for (const release of releases) release();
      acquire(account.id);
      acquire(account.id);
      removeAccount(account.id);
      assert.equal(fs.readdirSync(locks).length, 0);
    },
    { maxParallelEnv: 2 },
  );
});

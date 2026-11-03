import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectMergedUsage } from "../server.ts";
import { PLUGIN_VERSION } from "../version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const account = {
  id: "main",
  label: "Main",
  status: "signed_in",
  locked: false,
  lastUsedAt: "",
  lastCheckedAt: "",
};

function hostEntry(hostId, extra = {}) {
  return {
    hostId,
    name: hostId,
    connected: true,
    error: null,
    status: {
      platform: "darwin",
      chromeFound: true,
      chromePath: null,
      bridgeFound: true,
      bridgeVersion: "0.3.9",
      agentFound: true,
      runtime: { installed: true, version: "0.3.9", path: null, dev: null, installing: false, error: null },
      accounts: [account],
      problems: [],
      ...extra.status,
    },
    ...extra,
  };
}

test("server usage merges an account on two hosts and reads usage once", async () => {
  const hosts = [hostEntry("h1"), hostEntry("h2")];
  let calls = 0;
  const seen = [];
  const rows = await collectMergedUsage(hosts, async (hostId, id) => {
    calls += 1;
    seen.push({ hostId, id });
    return {
      accounts: [
        {
          id: "main",
          usage: { plan: "Muse Free", percentUsed: 28, extraTokensLeftLabel: "1B left" },
          error: null,
        },
      ],
    };
  });
  assert.equal(calls, 1);
  assert.deepEqual(seen, [{ hostId: "h1", id: "main" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "main");
  assert.equal(rows[0].label, "Main");
  assert.deepEqual(rows[0].hosts, ["h1", "h2"]);
  assert.equal(rows[0].usage.plan, "Muse Free");
  assert.equal(rows[0].error, null);
});

test("an account whose usage fails carries error and usage null", async () => {
  const hosts = [hostEntry("h1")];
  const rows = await collectMergedUsage(hosts, async () => ({
    accounts: [{ id: "main", usage: null, error: { code: "auth_failed", message: "Muse API unauthorized" } }],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage, null);
  assert.equal(rows[0].error.code, "auth_failed");
  assert.equal(rows[0].error.message, "Muse API unauthorized");
  assert.deepEqual(rows[0].hosts, ["h1"]);
});

test("package.json, package-lock.json and version.ts carry the same version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.equal(lock.version, PLUGIN_VERSION);
  assert.equal(lock.packages[""].version, PLUGIN_VERSION);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
});

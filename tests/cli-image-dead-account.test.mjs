import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "bin", "musebridge.mjs");
const fixture = path.join(here, "fixtures", "history-image.json");

// "main" was used longest ago, so pickAccount offers it first.
function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-cli-dead-");
  const account = (id, lastUsedAt) => {
    const profileDir = path.join(home, "profiles", id);
    fs.mkdirSync(profileDir, { recursive: true });
    return { id, label: id, profileDir, status: "signed_in", createdAt: lastUsedAt, lastUsedAt, lastCheckedAt: lastUsedAt };
  };
  const accounts = [account("main", "2026-01-01T00:00:00.000Z"), account("spare", "2026-01-02T00:00:00.000Z")];
  fs.writeFileSync(path.join(home, "accounts.json"), `${JSON.stringify({ version: 1, accounts })}\n`);
  return home;
}

const run = (home, args, dead) =>
  execFileP(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_FAKE_HISTORY: fixture, MUSE_BRIDGE_FAKE_DEAD: dead },
  });

const statusOf = (home, id) =>
  JSON.parse(fs.readFileSync(path.join(home, "accounts.json"), "utf8")).accounts.find((a) => a.id === id).status;

test("musebridge image without --account skips a dead account and draws on the next one", async () => {
  const home = seedHome();
  const out = fs.mkdtempSync("/tmp/muse-cli-dead-out-");
  const { stdout, stderr } = await run(home, ["image", "--json", "--out", out, "a red fox"], "main");
  assert.equal(JSON.parse(stdout).images.length, 1);
  assert.match(stderr, /Muse account main unusable .*switching to spare/);
  assert.equal(statusOf(home, "main"), "signed_out");
  assert.equal(statusOf(home, "spare"), "signed_in");
});

test("musebridge image --account main stays on main and fails when main is dead", async () => {
  const home = seedHome();
  const out = fs.mkdtempSync("/tmp/muse-cli-dead-out-");
  await assert.rejects(run(home, ["image", "--account", "main", "--json", "--out", out, "a red fox"], "main"), /Muse bootstrap failed \(400\)/);
});

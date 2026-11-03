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

function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-attach-cli-");
  const profile = path.join(home, "profiles", "work");
  fs.mkdirSync(profile, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(home, "accounts.json"),
    `${JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "work",
          label: "Work",
          profileDir: profile,
          status: "signed_in",
          createdAt: at,
          lastUsedAt: at,
          lastCheckedAt: at,
        },
      ],
    })}\n`,
  );
  return home;
}

test("musebridge send --attach records image and file attachments", async () => {
  const home = seedHome();
  const dir = fs.mkdtempSync("/tmp/muse-attach-cli-files-");
  const png = path.join(dir, "a.png");
  const pdf = path.join(dir, "b.pdf");
  fs.writeFileSync(png, Buffer.from("PNG"));
  fs.writeFileSync(pdf, Buffer.from("%PDF"));
  const sent = path.join(home, "sent.jsonl");
  await execFileP(process.execPath, [cli, "send", "--attach", png, "--attach", pdf, "hi"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MUSE_BRIDGE_FAKE: "1",
      MUSE_BRIDGE_HOME: home,
      MUSE_BRIDGE_FAKE_SENT: sent,
    },
  });
  const rec = JSON.parse(fs.readFileSync(sent, "utf8").trim().split("\n")[0]);
  assert.equal(rec.text, "hi");
  assert.deepEqual(rec.attachments, [
    { type: "image", mime_type: "image/png", filename: "a.png", bytes: 3 },
    { type: "file", mime_type: "application/pdf", filename: "b.pdf", bytes: 4 },
  ]);
});

test("musebridge image --attach records the photo", async () => {
  const home = seedHome();
  const dir = fs.mkdtempSync("/tmp/muse-attach-cli-img-");
  const jpg = path.join(dir, "me.jpg");
  fs.writeFileSync(jpg, Buffer.from("JPEG"));
  const sent = path.join(home, "sent.jsonl");
  const out = fs.mkdtempSync("/tmp/muse-attach-cli-out-");
  await execFileP(process.execPath, [cli, "image", "--json", "--out", out, "--attach", jpg, "кот"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MUSE_BRIDGE_FAKE: "1",
      MUSE_BRIDGE_HOME: home,
      MUSE_BRIDGE_FAKE_SENT: sent,
      MUSE_BRIDGE_FAKE_HISTORY: fixture,
    },
  });
  const rec = JSON.parse(fs.readFileSync(sent, "utf8").trim().split("\n")[0]);
  assert.equal(rec.text, "Create image. кот");
  assert.deepEqual(rec.attachments, [{ type: "image", mime_type: "image/jpeg", filename: "me.jpg", bytes: 4 }]);
});

test("musebridge send --attach of a file over 10 MB exits with a clear message", async () => {
  const home = seedHome();
  const dir = fs.mkdtempSync("/tmp/muse-attach-cli-big-");
  const big = path.join(dir, "huge.bin");
  const fd = fs.openSync(big, "w");
  fs.ftruncateSync(fd, 10 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  let err;
  try {
    await execFileP(process.execPath, [cli, "send", "--attach", big, "hi"], {
      encoding: "utf8",
      env: { ...process.env, MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home },
    });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 1);
  assert.match(err.stderr, /10 MB/);
});

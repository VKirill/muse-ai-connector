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
  const home = fs.mkdtempSync("/tmp/muse-cli-image-");
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

test("musebridge image --format 16:9 --json sends the prefixed prompt, writes bytes, prints JSON", async () => {
  const home = seedHome();
  const out = fs.mkdtempSync("/tmp/muse-cli-image-out-");
  const sent = path.join(home, "sent.jsonl");
  const media = path.join(home, "pic.webp");
  fs.writeFileSync(media, Buffer.from("WEBPFAKE"));
  const { stdout, stderr } = await execFileP(
    process.execPath,
    [cli, "image", "--format", "16:9", "--json", "--out", out, "a red fox"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MUSE_BRIDGE_HOME: home,
        MUSE_BRIDGE_FAKE: "1",
        MUSE_BRIDGE_FAKE_HISTORY: fixture,
        MUSE_BRIDGE_FAKE_MEDIA: media,
        MUSE_BRIDGE_FAKE_SENT: sent,
      },
    },
  );
  assert.equal(stderr, "");
  const sentLine = JSON.parse(fs.readFileSync(sent, "utf8").trim().split("\n")[0]);
  assert.equal(sentLine.text, "Create image format: 16:9. a red fox");
  const payload = JSON.parse(stdout);
  assert.equal(payload.chatId, "fake-image-chat");
  assert.equal(payload.text, "Here it is.");
  assert.equal(payload.images.length, 1);
  const img = payload.images[0];
  assert.equal(img.width, 2048);
  assert.equal(img.height, 1152);
  assert.equal(img.mime, "image/webp");
  assert.equal(img.label, "Small red fox sitting in snow at sunrise");
  assert.equal(fs.readFileSync(img.path).toString(), "WEBPFAKE");
  assert.equal(path.dirname(img.path), out);
});

test("musebridge image exits non-zero when the reply has no picture", async () => {
  const home = seedHome();
  const out = fs.mkdtempSync("/tmp/muse-cli-image-empty-");
  const emptyHist = path.join(home, "empty-history.json");
  fs.writeFileSync(emptyHist, JSON.stringify({ ok: true, result: { chat_events: [] } }));
  const err = await execFileP(process.execPath, [cli, "image", "--json", "--out", out, "a red fox"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MUSE_BRIDGE_HOME: home,
      MUSE_BRIDGE_FAKE: "1",
      MUSE_BRIDGE_FAKE_HISTORY: emptyHist,
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.notEqual(err.code, 0);
  assert.match(String(err.stderr), /Muse answered without a picture/);
});

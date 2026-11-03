import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "muse-acp.mjs");

function startAgent(env) {
  const child = spawn(process.execPath, [agentPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let id = 0;
  const pending = new Map();
  const write = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "session/update") return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    }
  });
  return {
    request(method, params) {
      const i = ++id;
      return new Promise((resolve, reject) => {
        pending.set(i, { resolve, reject });
        write({ id: i, method, params });
      });
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-attach-acp-");
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

test("initialize reports promptCapabilities.image true", async () => {
  const home = seedHome();
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home });
  try {
    const init = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);
  } finally {
    agent.close();
  }
});

test("ACP image and pdf go as Muse attachments; markdown is inlined", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-attach-acp-ws-");
  const pdf = path.join(ws, "doc.pdf");
  const md = path.join(ws, "notes.md");
  fs.writeFileSync(pdf, Buffer.from("%PDF-1.4\n"));
  fs.writeFileSync(md, "# Notes\nhello\n");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sent = path.join(home, "sent.jsonl");
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: ws });
    await agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [
        { type: "text", text: "смотри" },
        { type: "image", mimeType: "image/png", data: pngBytes.toString("base64"), name: "photo.png" },
        { type: "resource_link", uri: pathToFileURL(pdf).href, name: "doc.pdf", mimeType: "application/pdf" },
        { type: "resource_link", uri: pathToFileURL(md).href, name: "notes.md" },
      ],
    });
    const rec = JSON.parse(fs.readFileSync(sent, "utf8").trim().split("\n")[0]);
    assert.deepEqual(rec.attachments, [
      { type: "image", mime_type: "image/png", filename: "photo.png", bytes: pngBytes.length },
      { type: "file", mime_type: "application/pdf", filename: "doc.pdf", bytes: Buffer.byteLength("%PDF-1.4\n") },
    ]);
    assert.match(rec.text, /\[Attached file: notes.md\]/);
    assert.match(rec.text, /# Notes\nhello/);
    assert.equal(rec.text.includes("%PDF-1.4"), false);
  } finally {
    agent.close();
  }
});

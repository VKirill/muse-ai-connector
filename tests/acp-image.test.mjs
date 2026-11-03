import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "muse-acp.mjs");

function startAgent(env) {
  const child = spawn(process.execPath, [agentPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let id = 0;
  const pending = new Map();
  const updates = [];
  const write = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "session/update") {
      updates.push(msg.params.update);
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    }
  });
  return {
    updates,
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
  const home = fs.mkdtempSync("/tmp/muse-acp-image-");
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

const prompt = (agent, sessionId, text) =>
  agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

test("muse-image sends a prefixed prompt without the tools intro and returns an image block", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-acp-image-ws-");
  const sent = path.join(home, "sent.jsonl");
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: ws });
    assert.equal(created.models.currentModelId, "muse-spark");
    assert.ok(created.models.availableModels.some((m) => m.modelId === "muse-image"));
    await agent.request("session/set_model", { sessionId: created.sessionId, modelId: "muse-image" });
    const result = await prompt(agent, created.sessionId, "9:16 кот");
    assert.equal(result.stopReason, "end_turn");
    const sentLines = fs.readFileSync(sent, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 1);
    assert.equal(sentLines[0], "Create image format: 9:16. кот");
    assert.equal(sentLines[0].includes("muse-tool"), false);
    const image = agent.updates.find((u) => u.content?.type === "image") || { content: {} };
    assert.equal(image.content.mimeType, undefined);
    assert.equal(image.content.data, undefined);
    const texts = agent.updates.filter((u) => u.content?.type === "text").map((u) => u.content.text).join("");
    assert.match(texts, /!\[Fake image\]\(muse-images\/fake\.webp\)/);
    assert.equal(fs.readFileSync(path.join(ws, "muse-images", "fake.webp")).toString(), "WEBPFAKE");
  } finally {
    agent.close();
  }
});

test("muse-spark still sends the tools intro on the first message", async () => {
  const home = seedHome();
  const sent = path.join(home, "sent.jsonl");
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    await prompt(agent, created.sessionId, "hello");
    const sentLines = fs.readFileSync(sent, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
    assert.match(sentLines[0], /muse-tool/);
    assert.match(sentLines[0], /hello/);
  } finally {
    agent.close();
  }
});

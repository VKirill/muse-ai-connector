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

function chunkText(updates) {
  return updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
}

function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-acp-");
  const profile = path.join(home, "profiles", "work");
  fs.mkdirSync(profile, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(home, "accounts.json"),
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  );
  return home;
}

const prompt = (agent, sessionId, text) =>
  agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

test("fake initialize, session/new, session/prompt streams PONG and ends the turn", async () => {
  const home = seedHome();
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    assert.equal(created.models.currentModelId, "muse-spark");
    assert.ok(created.models.availableModels.some((m) => m.modelId === "muse-spark"));
    const result = await prompt(agent, created.sessionId, "Reply with PONG");
    assert.equal(chunkText(agent.updates), "PONG");
    assert.deepEqual(result, { stopReason: "end_turn" });
  } finally {
    agent.close();
  }
});

test("session/new advertises muse-spark and session/set_model accepts it", async () => {
  const home = seedHome();
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    assert.deepEqual(created.models, {
      currentModelId: "muse-spark",
      availableModels: [
        { modelId: "muse-spark", name: "Muse Spark" },
        { modelId: "muse-image", name: "Muse Image" },
      ],
    });
    const set = await agent.request("session/set_model", { sessionId: created.sessionId, modelId: "muse-spark" });
    assert.deepEqual(set, {});
    const setImage = await agent.request("session/set_model", { sessionId: created.sessionId, modelId: "muse-image" });
    assert.deepEqual(setImage, {});
    await assert.rejects(
      () => agent.request("session/set_model", { sessionId: created.sessionId, modelId: "unknown" }),
      (err) => err.code === -32602,
    );
  } finally {
    agent.close();
  }
});

test("a second prompt in the same session reuses accountId and Muse chat id from sessions.json", async () => {
  const home = seedHome();
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home });
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    assert.equal(created.models.currentModelId, "muse-spark");
    assert.ok(created.models.availableModels.some((m) => m.modelId === "muse-spark"));
    await prompt(agent, created.sessionId, "first");
    const first = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"))[created.sessionId];
    assert.equal(first.accountId, "work");
    assert.equal(typeof first.museChatId, "string");
    assert.ok(first.museChatId);
    agent.updates.length = 0;
    const secondResult = await prompt(agent, created.sessionId, "second");
    assert.equal(secondResult.stopReason, "end_turn");
    assert.equal(chunkText(agent.updates), "PONG");
    const second = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"))[created.sessionId];
    assert.equal(second.accountId, first.accountId);
    assert.equal(second.museChatId, first.museChatId);
  } finally {
    agent.close();
  }
});

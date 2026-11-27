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
  const child = spawn(process.execPath, [agentPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let id = 0;
  const pending = new Map();
  const updates = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "session/update") updates.push(msg.params.update);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  return {
    updates,
    request(method, params) {
      const i = ++id;
      return new Promise((resolve, reject) => {
        pending.set(i, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
      });
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

// "main" was used longest ago, so pickAccount offers it first.
function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-acp-dead-");
  const account = (id, lastUsedAt) => {
    const profileDir = path.join(home, "profiles", id);
    fs.mkdirSync(profileDir, { recursive: true });
    return { id, label: id, profileDir, status: "signed_in", createdAt: lastUsedAt, lastUsedAt, lastCheckedAt: lastUsedAt };
  };
  const accounts = [account("main", "2026-01-01T00:00:00.000Z"), account("spare", "2026-01-02T00:00:00.000Z")];
  fs.writeFileSync(path.join(home, "accounts.json"), `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
  return home;
}

const statusOf = (home, id) =>
  JSON.parse(fs.readFileSync(path.join(home, "accounts.json"), "utf8")).accounts.find((a) => a.id === id).status;

test("a dead account is taken out of rotation and the same turn runs on the next signed-in account", async () => {
  const home = seedHome();
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify(["answered\n[[done]]"]));
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_DEAD: "main" });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.request("session/new", { cwd: "/tmp" });
    const result = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    assert.equal(result.stopReason, "end_turn");
    const text = agent.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
    assert.match(text, /answered/);
    assert.equal(statusOf(home, "main"), "signed_out");
    const store = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"));
    assert.equal(store[sessionId].accountId, "spare");
  } finally {
    agent.close();
  }
});

test("when every account is dead the turn ends with a signed-out error and sends nothing", async () => {
  const home = seedHome();
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_DEAD: "main,spare" });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.request("session/new", { cwd: "/tmp" });
    const result = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    assert.equal(result.stopReason, "end_turn");
    const text = agent.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
    assert.match(text, /NonRetriableError: muse signed out/);
    assert.equal(statusOf(home, "main"), "signed_out");
    assert.equal(statusOf(home, "spare"), "signed_out");
  } finally {
    agent.close();
  }
});

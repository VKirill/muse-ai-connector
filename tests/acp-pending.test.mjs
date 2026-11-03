import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { waitForPendingReply } from "../bridge/acp-pending.mjs";

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
    notify(method, params) {
      write({ method, params });
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
  const home = fs.mkdtempSync("/tmp/muse-acp-pending-");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const prompt = (agent, sessionId, text) =>
  agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

function savedSession(home, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"))[sessionId];
}

test("waitForPendingReply waits through missing and streaming states to the final text", async () => {
  let calls = 0;
  const user = { id: "u1", role: "user", content: "Reply ALPHA", streaming: false };
  const history = async () => {
    calls++;
    if (calls === 1) return { messages: [user] };
    if (calls === 2) return { messages: [user, { id: "a1", role: "assistant", content: "AL", streaming: true }] };
    return { messages: [user, { id: "a1", role: "assistant", content: "ALPHA", streaming: false }] };
  };
  assert.equal(await waitForPendingReply(history, "chat-1", { timeoutMs: 5000, pollMs: 20 }), "ALPHA");
});

test("waitForPendingReply returns '' on timeout", async () => {
  const user = { id: "u1", role: "user", content: "x", streaming: false };
  assert.equal(await waitForPendingReply(async () => ({ messages: [user] }), "chat-1", { timeoutMs: 150, pollMs: 20 }), "");
});

test("the next turn waits for the interrupted reply and streams it before its own", async () => {
  const home = seedHome();
  const agent = startAgent({
    MUSE_BRIDGE_FAKE: "1",
    MUSE_BRIDGE_HOME: home,
    MUSE_BRIDGE_FAKE_DELAY_MS: "200",
    MUSE_BRIDGE_FAKE_REPLY_LAG_MS: "800",
    MUSE_PENDING_WAIT_MS: "10000",
  });
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    const sessionId = created.sessionId;

    const first = prompt(agent, sessionId, "one");
    let chatId = null;
    for (let i = 0; i < 100 && !chatId; i++) {
      await sleep(20);
      chatId = savedSession(home, sessionId)?.museChatId ?? null;
    }
    assert.ok(chatId, "museChatId was not persisted while the first turn was in flight");
    agent.notify("session/cancel", { sessionId });
    assert.deepEqual(await first, { stopReason: "cancelled" });

    agent.updates.length = 0;
    const second = await prompt(agent, sessionId, "two");
    assert.equal(second.stopReason, "end_turn");
    assert.equal(chunkText(agent.updates), "PONG\n\nPONG");
    assert.equal(savedSession(home, sessionId).museChatId, chatId);
  } finally {
    agent.close();
  }
});

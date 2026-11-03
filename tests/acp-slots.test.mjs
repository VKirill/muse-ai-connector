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
  const write = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
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
  const home = fs.mkdtempSync("/tmp/muse-acp-slots-");
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

test("two sessions of one account run two prompts in parallel within the slot budget", async () => {
  const home = seedHome();
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify(["ok\n[[done]]", "ok\n[[done]]"]));
  const agent = startAgent({
    MUSE_BRIDGE_FAKE: "1",
    MUSE_BRIDGE_HOME: home,
    MUSE_MAX_PARALLEL: "2",
    MUSE_BRIDGE_FAKE_DELAY_MS: "1500",
    MUSE_BRIDGE_FAKE_SCRIPT: script,
  });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const first = await agent.request("session/new", { cwd: "/tmp" });
    const second = await agent.request("session/new", { cwd: "/tmp" });
    const startedAt = Date.now();
    const [r1, r2] = await Promise.all([
      agent.request("session/prompt", { sessionId: first.sessionId, prompt: [{ type: "text", text: "one" }] }),
      agent.request("session/prompt", { sessionId: second.sessionId, prompt: [{ type: "text", text: "two" }] }),
    ]);
    const elapsed = Date.now() - startedAt;
    assert.equal(r1.stopReason, "end_turn");
    assert.equal(r2.stopReason, "end_turn");
    assert.ok(elapsed < 2800, `two 1500 ms fake replies ran in ${elapsed} ms, expected parallel slots`);
    const store = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"));
    assert.equal(store[first.sessionId].accountId, "work");
    assert.equal(store[second.sessionId].accountId, "work");
    assert.notEqual(store[first.sessionId].museChatId, store[second.sessionId].museChatId);
  } finally {
    agent.close();
  }
});

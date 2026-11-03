import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.MUSE_BRIDGE_HOME ??= fs.mkdtempSync("/tmp/muse-native-import-");

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

function chunkText(updates, kind = "agent_message_chunk") {
  return updates
    .filter((u) => u.sessionUpdate === kind)
    .map((u) => u.content.text)
    .join("");
}

function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-native-test-");
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

function sentTexts(file) {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).text);
}

test("buildIntro: muse-tool is a text block, native tools run on the cloud VM", async () => {
  const { buildIntro } = await import("../bridge/acp-tools.mjs");
  const intro = buildIntro("/tmp/ws", []);
  assert.match(intro, /not one of your tools/i);
  assert.match(intro, /cloud VM/i);
  assert.match(intro, /write_file/);
});

test("empty native-tool messages are waited through; the late reply ends the turn, no nudge", async () => {
  const home = seedHome();
  const sent = path.join(home, "sent.jsonl");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify([["", "", "answer [[done]]"]]));
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent, MUSE_BRIDGE_FAKE_SCRIPT: script });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    const result = await agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "search the web" }],
    });
    assert.deepEqual(result, { stopReason: "end_turn" });
    assert.equal(chunkText(agent.updates), "answer");
    assert.equal(sentTexts(sent).length, 1);
  } finally {
    agent.close();
  }
});

test("idle timeout after only empty replies ends the turn with a continue hint", async () => {
  const home = seedHome();
  const sent = path.join(home, "sent.jsonl");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify([["", ""]]));
  const agent = startAgent({
    MUSE_BRIDGE_FAKE: "1",
    MUSE_BRIDGE_HOME: home,
    MUSE_BRIDGE_FAKE_SENT: sent,
    MUSE_BRIDGE_FAKE_SCRIPT: script,
    MUSE_REPLY_TIMEOUT_SEC: "1",
  });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    const result = await agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "search the web" }],
    });
    assert.deepEqual(result, { stopReason: "end_turn" });
    assert.match(chunkText(agent.updates), /Muse is still working on its side; ask it to continue/);
    assert.equal(sentTexts(sent).length, 1);
  } finally {
    agent.close();
  }
});

test("a non-empty reply without a muse-tool block still draws the nudge", async () => {
  const home = seedHome();
  const sent = path.join(home, "sent.jsonl");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify(["just thinking", "done now [[done]]"]));
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent, MUSE_BRIDGE_FAKE_SCRIPT: script });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    const result = await agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "fix it" }],
    });
    assert.deepEqual(result, { stopReason: "end_turn" });
    assert.equal(chunkText(agent.updates), "done now");
    const texts = sentTexts(sent);
    assert.equal(texts.length, 2);
    assert.match(texts[1], /muse-tool block/);
    assert.match(texts[1], /cloud VM/);
  } finally {
    agent.close();
  }
});

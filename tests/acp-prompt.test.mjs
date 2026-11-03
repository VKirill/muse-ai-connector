import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promptText } from "../bridge/acp-prompt.mjs";

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
  const home = fs.mkdtempSync("/tmp/muse-acp-prompt-");
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

test("promptText strips system_instructions and system-reminder blocks, even across blocks", () => {
  const big = `<system_instructions>\n${"rule ".repeat(40000)}\n</system_instructions>`;
  assert.equal(promptText([{ type: "text", text: big + "работаешь?" }]), "работаешь?");
  assert.equal(
    promptText([
      { type: "text", text: "<system_instructions>one</system_instructions>" },
      { type: "text", text: "<system-reminder>x</system-reminder>\nHello" },
    ]),
    "Hello",
  );
  assert.equal(promptText([{ type: "text", text: "a <system-reminder>r</system-reminder> b" }]), "a  b");
});

test("promptText keeps plain text and other tags untouched", () => {
  assert.equal(promptText([{ type: "text", text: "plain <b>text</b> stays" }]), "plain <b>text</b> stays");
  assert.equal(promptText("just text"), "just text");
  assert.equal(promptText(null), "");
});

test("a prompt of only BB system text is answered with a note and Muse is not touched", async () => {
  const home = seedHome();
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home });
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    const result = await agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [
        { type: "text", text: "<system_instructions>rules</system_instructions>" },
        { type: "text", text: " <system-reminder>x</system-reminder> " },
      ],
    });
    assert.deepEqual(result, { stopReason: "end_turn" });
    assert.match(chunkText(agent.updates), /Nothing to send to Muse: the message held only BB system instructions\./);
    const saved = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"))[created.sessionId];
    assert.equal(saved.museChatId, null);
  } finally {
    agent.close();
  }
});

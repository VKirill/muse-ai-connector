import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractBbContext, promptText } from "../bridge/acp-prompt.mjs";

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

const bbBlock = (body) => `<system_instructions>\n${body}\n</system_instructions>\n`;

test("extractBbContext keeps project rules, owner rules and language; drops manuals and noise", () => {
  const big = "x".repeat(50000);
  const sys =
    bbBlock(
      [
        "You are working inside bb, an agentic IDE.",
        "## Language",
        "Chat with the human in plain Russian. Every file you write is English.",
        'The following instructions come from the BB plugin "image-studio" for its tool "image_studio_gui":',
        `IMAGE-MANUAL ${big}`,
        "Contents of /p/AGENTS.md (project instructions, checked into the codebase):",
        "# Section rules",
        "PROJECT-RULE-7: put temp files in tmp/.",
        "Contents of /home/u/.bb/CLAUDE.md (user's private global instructions for all projects):",
        "GLOBAL-RULE-1: sign commits.",
        'The following dynamic instructions come from the BB plugin "lane-pilot":',
        "Rules the owner taught in this project (they came from his corrections):",
        "- OWNER-RULE-3: never force-push.",
        'The following instructions come from the BB plugin "memory":',
        `MEMORY-INDEX ${big}`,
        "Available bb skills:",
        `- skill-one ${big}`,
      ].join("\n"),
    ) + "<system-reminder>REMINDER-NOISE</system-reminder>\n";
  const prompt = [{ type: "text", text: `${sys}fix the bug` }];
  const ctx = extractBbContext(prompt);
  for (const want of ["PROJECT-RULE-7", "OWNER-RULE-3", "GLOBAL-RULE-1", "plain Russian"]) {
    assert.ok(ctx.includes(want), `kept context lacks ${want}`);
  }
  for (const drop of ["IMAGE-MANUAL", "MEMORY-INDEX", "REMINDER-NOISE", "skill-one", "You are working inside bb"]) {
    assert.ok(!ctx.includes(drop), `kept context still has ${drop}`);
  }
  assert.ok(ctx.length <= 16000);
  assert.equal(promptText(prompt), "fix the bug");
});

test("extractBbContext orders project rules, owner rules, language and truncates at 16000 chars", () => {
  const sys = bbBlock(
    [
      "## Language",
      `LANG ${"l".repeat(40000)}`,
      'The following instructions come from the BB plugin "p":',
      "manual",
      "Contents of /p/AGENTS.md (project instructions, checked into the codebase):",
      "PROJECT-RULE-1",
      "Rules the owner taught in this project:",
      "- OWNER-RULE-1",
    ].join("\n"),
  );
  const ctx = extractBbContext([{ type: "text", text: sys }]);
  assert.ok(ctx.length <= 16000);
  assert.ok(ctx.indexOf("PROJECT-RULE-1") < ctx.indexOf("OWNER-RULE-1"));
  assert.ok(ctx.indexOf("OWNER-RULE-1") < ctx.indexOf("LANG"));
  assert.match(ctx, /…\(truncated\)$/);
});

test("extractBbContext returns an empty string without a system_instructions block", () => {
  assert.equal(extractBbContext([{ type: "text", text: "just text" }]), "");
  assert.equal(extractBbContext("plain"), "");
  assert.equal(extractBbContext([{ type: "text", text: "<system-reminder>x</system-reminder>" }]), "");
});

test("first Muse message carries kept BB rules after the intro; repeats only when they change", async () => {
  const home = seedHome();
  const sent = path.join(home, "sent.jsonl");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify(["ok\n[[done]]", "ok\n[[done]]", "ok\n[[done]]"]));
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent, MUSE_BRIDGE_FAKE_SCRIPT: script });
  const sys = (rule) =>
    `<system_instructions>\nContents of /p/AGENTS.md (project instructions, checked into the codebase):\n${rule}\n` +
    'The following instructions come from the BB plugin "memory":\nMEMORY-INDEX noise\n</system_instructions>\n';
  const sentTexts = () =>
    fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const created = await agent.request("session/new", { cwd: "/tmp" });
    const run = (text) => agent.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text }] });
    await run(`${sys("PROJECT-RULE-7: stay in tmp/")}first task`);
    await run(`${sys("PROJECT-RULE-7: stay in tmp/")}second task`);
    await run(`${sys("PROJECT-RULE-9: new rule")}third task`);
    const texts = sentTexts();
    assert.equal(texts.length, 3);
    assert.ok(texts[0].indexOf("You are Muse") < texts[0].indexOf("PROJECT-RULE-7"), "rules come after the intro");
    assert.match(texts[0], /Project and owner rules \(from BB\):/);
    assert.ok(!texts[0].includes("MEMORY-INDEX"));
    assert.ok(texts[0].includes("first task"));
    assert.ok(!texts[1].includes("PROJECT-RULE-7"));
    assert.ok(!texts[1].includes("Project and owner rules"));
    assert.ok(texts[1].includes("second task"));
    assert.ok(texts[2].includes("PROJECT-RULE-9"));
    assert.ok(texts[2].includes("third task"));
  } finally {
    agent.close();
  }
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

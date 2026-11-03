import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildIntro, parseToolCall, resolveSessionPath, runTool, stripDoneMarker } from "../bridge/acp-tools.mjs";

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
  const fsRequests = [];
  const write = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "session/update") {
      updates.push(msg.params.update);
      return;
    }
    if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
      fsRequests.push(msg);
      const result =
        msg.method === "fs/read_text_file"
          ? { content: fs.existsSync(msg.params.path) ? fs.readFileSync(msg.params.path, "utf8") : "" }
          : {};
      write({ id: msg.id, result });
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
    fsRequests,
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

function chunkText(updates, kind = "agent_message_chunk") {
  return updates
    .filter((u) => u.sessionUpdate === kind)
    .map((u) => u.content.text)
    .join("");
}

function seedHome() {
  const home = fs.mkdtempSync("/tmp/muse-acp-tools-");
  const profile = path.join(home, "profiles", "work");
  fs.mkdirSync(profile, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(home, "accounts.json"),
    `${JSON.stringify(
      {
        version: 1,
        accounts: [
          { id: "work", label: "Work", profileDir: profile, status: "signed_in", createdAt: at, lastUsedAt: at, lastCheckedAt: at },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return home;
}

const prompt = (agent, sessionId, text) => agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
const block = (o) => `\`\`\`muse-tool\n${JSON.stringify(o)}\n\`\`\``;

function newSession(home, ws, env = {}) {
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, ...env });
  return agent;
}

test("parseToolCall: no block, one block, last block wins", () => {
  assert.equal(parseToolCall("just a reply").kind, "none");
  const one = parseToolCall(`thinking\n${block({ tool: "read_file", args: { path: "a.txt" } })}`);
  assert.equal(one.kind, "call");
  assert.equal(one.name, "read_file");
  assert.deepEqual(one.args, { path: "a.txt" });
  assert.equal(one.thought, "thinking");
  const two = parseToolCall(`${block({ tool: "read_file", args: { path: "a" } })}\nmiddle\n${block({ tool: "bash", args: { command: "ls" } })}`);
  assert.equal(two.kind, "call");
  assert.equal(two.name, "bash");
  assert.equal(two.thought.includes("read_file"), true);
});

test("buildIntro: the workspace is on the user's machine, reached only via muse-tool", () => {
  const intro = buildIntro("/w/proj", []);
  assert.match(intro, /not on your own (computer|machine)/i);
  assert.match(intro, /never use your own (shell|tools)/i);
  assert.match(intro, /first step.{0,80}list_dir/i);
  assert.ok(intro.length <= 8000);
});

test("parseToolCall: bad JSON is an error, not a crash", () => {
  const bad = parseToolCall("pre\n```muse-tool\n{not json}\n```");
  assert.equal(bad.kind, "error");
  assert.match(bad.error, /invalid muse-tool JSON/);
  assert.equal(bad.thought, "pre");
});

test("path guard: ../outside and absolute paths outside cwd are refused", async () => {
  const cwd = fs.mkdtempSync("/tmp/muse-ws-");
  assert.throws(() => resolveSessionPath(cwd, "../x"), /outside workspace/);
  assert.throws(() => resolveSessionPath(cwd, "/etc/passwd"), /outside workspace/);
  const ctx = { cwd, sessionId: "s", fsRead: false, fsWrite: false, clientRequest: async () => ({}) };
  const res = await runTool("read_file", { path: "../outside" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /outside workspace/);
});

test("edit_file: zero or two matches fails, exactly one applies", async () => {
  const cwd = fs.mkdtempSync("/tmp/muse-ws-");
  fs.writeFileSync(path.join(cwd, "f.txt"), "dup dup");
  const ctx = { cwd, sessionId: "s", fsRead: false, fsWrite: false, clientRequest: async () => ({}) };
  assert.equal((await runTool("edit_file", { path: "f.txt", old: "nope", new: "x" }, ctx)).ok, false);
  const dup = await runTool("edit_file", { path: "f.txt", old: "dup", new: "x" }, ctx);
  assert.equal(dup.ok, false);
  assert.match(dup.output, /2 times/);
  assert.equal((await runTool("edit_file", { path: "f.txt", old: "dup dup", new: "once" }, ctx)).ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, "f.txt"), "utf8"), "once");
});

test("tool loop: write_file then bash run in the session cwd, final reply streams clean", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(
    script,
    JSON.stringify([
      `I will write the file.\n${block({ tool: "write_file", args: { path: "hello.txt", content: "hi from muse\n" } })}`,
      block({ tool: "bash", args: { command: "cat hello.txt" } }),
      "All done: hi from muse\n[[done]]",
    ]),
  );
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "write hello.txt");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(fs.readFileSync(path.join(ws, "hello.txt"), "utf8"), "hi from muse\n");
    const toolCalls = agent.updates.filter((u) => u.sessionUpdate === "tool_call");
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].status, "in_progress");
    assert.equal(toolCalls[0].kind, "edit");
    assert.equal(toolCalls[1].kind, "execute");
    assert.ok(agent.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
    assert.equal(chunkText(agent.updates), "All done: hi from muse");
    assert.equal(chunkText(agent.updates, "agent_thought_chunk"), "I will write the file.");
    const sentLines = fs.readFileSync(sent, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 3);
    assert.match(sentLines[0], /muse-tool/);
    assert.match(sentLines[1], /^TOOL RESULT write_file \(ok\):/);
    assert.match(sentLines[2], /^TOOL RESULT bash \(ok\):\nexit 0\nhi from muse/);
  } finally {
    agent.close();
  }
});

test("bad JSON block goes back to Muse as TOOL RESULT (error)", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(script, JSON.stringify(["```muse-tool\n{bad json}\n```", "sorry\n[[done]]"]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "go");
    assert.equal(result.stopReason, "end_turn");
    assert.ok(agent.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed"));
    const sentLines = fs.readFileSync(sent, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
    assert.match(sentLines[1], /^TOOL RESULT muse-tool \(error\):\ninvalid muse-tool JSON/);
    assert.equal(chunkText(agent.updates), "sorry");
  } finally {
    agent.close();
  }
});

test("client that announced fs.writeTextFile receives fs/write_text_file instead of a local write", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify([block({ tool: "write_file", args: { path: "via-bb.txt", content: "through client\n" } }), "done\n[[done]]"]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    await prompt(agent, created.sessionId, "write a file");
    assert.equal(agent.fsRequests.length, 1);
    assert.equal(agent.fsRequests[0].method, "fs/write_text_file");
    assert.equal(agent.fsRequests[0].params.path, path.join(ws, "via-bb.txt"));
    assert.equal(agent.fsRequests[0].params.content, "through client\n");
    assert.equal(agent.fsRequests[0].params.sessionId, created.sessionId);
    assert.equal(fs.existsSync(path.join(ws, "via-bb.txt")), false);
  } finally {
    agent.close();
  }
});

test("the loop stops at MUSE_MAX_TOOL_ROUNDS with a message", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify([block({ tool: "list_dir", args: {} }), block({ tool: "list_dir", args: {} }), block({ tool: "list_dir", args: {} })]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_MAX_TOOL_ROUNDS: "2" });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "loop forever");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(agent.updates.filter((u) => u.sessionUpdate === "tool_call").length, 2);
    assert.match(chunkText(agent.updates), /tool round limit/);
  } finally {
    agent.close();
  }
});

test("a block-less reply gets one nudge; the second block-less reply ends the turn", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(script, JSON.stringify(["Читаю math.js.", "final words without a marker"]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "go");
    assert.equal(result.stopReason, "end_turn");
    const sentLines = fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 2);
    assert.match(sentLines[1], /no \[\[done\]\] line/);
    assert.equal(chunkText(agent.updates), "final words without a marker");
    assert.equal(chunkText(agent.updates, "agent_thought_chunk"), "Читаю math.js.");
  } finally {
    agent.close();
  }
});

test("a nudge leads to a tool call, then [[done]] ends the turn and is stripped", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(
    script,
    JSON.stringify([
      "Читаю math.js.",
      `Writing the file.\n${block({ tool: "write_file", args: { path: "hello.txt", content: "hi from muse\n" } })}`,
      "All done: hi from muse\n[[done]]",
    ]),
  );
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "write hello.txt");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(fs.readFileSync(path.join(ws, "hello.txt"), "utf8"), "hi from muse\n");
    const sentLines = fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 3);
    assert.match(sentLines[1], /no \[\[done\]\] line/);
    assert.match(sentLines[2], /^TOOL RESULT write_file \(ok\):/);
    assert.equal(chunkText(agent.updates), "All done: hi from muse");
    assert.equal(chunkText(agent.updates, "agent_thought_chunk"), "Читаю math.js.Writing the file.");
  } finally {
    agent.close();
  }
});

test("'**[[done]]**' on the last line is accepted and stripped", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(script, JSON.stringify(["all good\n**[[done]]**"]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "go");
    assert.equal(result.stopReason, "end_turn");
    const sentLines = fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 1);
    assert.equal(chunkText(agent.updates), "all good");
  } finally {
    agent.close();
  }
});

test("stripDoneMarker: inline at the end of the last line counts, mid-text does not", () => {
  assert.equal(stripDoneMarker("All done: hi from muse [[done]]"), "All done: hi from muse");
  assert.equal(stripDoneMarker("all good\n**[[done]]**"), "all good");
  assert.equal(stripDoneMarker("final\n[[done]]"), "final");
  assert.equal(stripDoneMarker("done now [[done]] more"), null);
  assert.equal(stripDoneMarker("a [[done]] b"), null);
  assert.equal(stripDoneMarker("plain text"), null);
});

test("a trailing inline [[done]] ends the turn and is stripped before reaching BB", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(script, JSON.stringify(["All done: hi from muse [[done]]"]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "go");
    assert.equal(result.stopReason, "end_turn");
    const sentLines = fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 1);
    assert.equal(chunkText(agent.updates), "All done: hi from muse");
  } finally {
    agent.close();
  }
});

test("a [[done]] in mid-text is not a marker and gets the nudge", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(script, JSON.stringify(["working on it [[done]] moving on", "real end\n[[done]]"]));
  const agent = newSession(home, ws, { MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await prompt(agent, created.sessionId, "go");
    assert.equal(result.stopReason, "end_turn");
    const sentLines = fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    assert.equal(sentLines.length, 2);
    assert.match(sentLines[1], /no \[\[done\]\] line/);
    assert.equal(chunkText(agent.updates), "real end");
    assert.equal(chunkText(agent.updates, "agent_thought_chunk"), "working on it [[done]] moving on");
  } finally {
    agent.close();
  }
});

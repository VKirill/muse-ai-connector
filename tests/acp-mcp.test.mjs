import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "muse-acp.mjs");
const fakeMcp = path.join(here, "fixtures", "fake-mcp.mjs");

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
  const home = fs.mkdtempSync("/tmp/muse-acp-mcp-");
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
            profileDir: path.join(home, "profiles", "work"),
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

const block = (o) => `\`\`\`muse-tool\n${JSON.stringify(o)}\n\`\`\``;

function sentTexts(home) {
  return fs
    .readFileSync(path.join(home, "sent.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).text ?? "");
}

async function runToolLoop(env, mcpServers, toolName) {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify([block({ tool: toolName, args: { text: "zz" } }), "done\n[[done]]"]));
  const sent = path.join(home, "sent.jsonl");
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent, ...env });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers });
    const result = await agent.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
    return { result, agent, sent: sentTexts(home) };
  } finally {
    agent.close();
  }
}

test("stdio MCP server: mcp__fake__echo round-trips through the tool loop", async () => {
  const { result, agent, sent } = await runToolLoop(
    {},
    [{ name: "fake", command: process.execPath, args: [fakeMcp], env: [{ name: "MCP_FAKE_ENV", value: "s3cret" }] }],
    "mcp__fake__echo",
  );
  assert.equal(result.stopReason, "end_turn");
  assert.ok(agent.updates.some((u) => u.sessionUpdate === "tool_call" && u.title.startsWith("mcp__fake__echo")));
  assert.ok(agent.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
  assert.match(sent[0], /mcp__fake__echo/);
  assert.match(sent[1], /^TOOL RESULT 1\/1 mcp__fake__echo \(ok\):\necho:zz/);
  assert.ok(!sent.some((t) => t.includes("s3cret")), "env secret must not reach Muse");
});

test("http MCP server answers a tools/call over JSON-RPC POST", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const json = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "initialize") return json({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hfake", version: "1" } });
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === "tools/list") return json({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
      if (msg.method === "tools/call") return json({ content: [{ type: "text", text: `echo:${msg.params.arguments.text}` }] });
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const { result, sent } = await runToolLoop({}, [{ type: "http", name: "hfake", url, headers: [{ name: "x-test", value: "1" }] }], "mcp__hfake__echo");
    assert.equal(result.stopReason, "end_turn");
    assert.match(sent[1], /^TOOL RESULT 1\/1 mcp__hfake__echo \(ok\):\necho:zz/);
  } finally {
    server.close();
  }
});

test("a server whose command does not exist is skipped while the other works", async () => {
  const { result, agent, sent } = await runToolLoop(
    {},
    [
      { name: "broken", command: "/nonexistent-mcp-bin-xyz", args: [] },
      { name: "fake", command: process.execPath, args: [fakeMcp] },
    ],
    "mcp__fake__echo",
  );
  assert.equal(result.stopReason, "end_turn");
  assert.match(sent[1], /^TOOL RESULT 1\/1 mcp__fake__echo \(ok\):\necho:zz/);
  const toolCalls = agent.updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.title);
  assert.deepEqual(toolCalls.map((t) => t.split(" ")[0]), ["mcp__fake__echo"]);
});

test("tool_schema returns the MCP tool's input schema", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify([block({ tool: "tool_schema", args: { name: "mcp__fake__echo" } }), "done\n[[done]]"]));
  const sent = path.join(home, "sent.jsonl");
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SCRIPT: script, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [{ name: "fake", command: process.execPath, args: [fakeMcp] }] });
    await agent.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
    assert.match(sentTexts(home)[1], /"text".*"type": "string"/s);
  } finally {
    agent.close();
  }
});

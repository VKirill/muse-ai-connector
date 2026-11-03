import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "muse-acp.mjs");
const cli = path.join(here, "..", "bin", "musebridge.mjs");
const fixture = path.join(here, "fixtures", "history-image.json");

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
    if (msg.method === "session/update") return;
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
  const home = fs.mkdtempSync("/tmp/muse-img-dialog-");
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

test("muse-image prefixes only the first turn and a later format token", async () => {
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-img-dialog-ws-");
  const sent = path.join(home, "sent.jsonl");
  const agent = startAgent({ MUSE_BRIDGE_FAKE: "1", MUSE_BRIDGE_HOME: home, MUSE_BRIDGE_FAKE_SENT: sent });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request("session/new", { cwd: ws });
    await agent.request("session/set_model", { sessionId: created.sessionId, modelId: "muse-image" });
    for (const t of ["лиса в лесу", "сделай светлее", "16:9 теперь горизонтально"]) {
      await agent.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: t }] });
    }
    const lines = fs.readFileSync(sent, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
    assert.deepEqual(lines, [
      "Create image. лиса в лесу",
      "сделай светлее",
      "Create image format: 16:9. теперь горизонтально",
    ]);
  } finally {
    agent.close();
  }
});

test("musebridge image --chat sends the prompt as typed unless --format is set", async () => {
  const cases = [
    [["--chat", "abc-chat", "сделай светлее"], "сделай светлее"],
    [["--chat", "abc-chat", "--format", "9:16", "кот"], "Create image format: 9:16. кот"],
    [["кот"], "Create image. кот"],
  ];
  for (const [args, want] of cases) {
    const home = seedHome();
    const sent = path.join(home, "sent.jsonl");
    const out = fs.mkdtempSync("/tmp/muse-img-dialog-out-");
    await execFileP(process.execPath, [cli, "image", "--json", "--out", out, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        MUSE_BRIDGE_FAKE: "1",
        MUSE_BRIDGE_HOME: home,
        MUSE_BRIDGE_FAKE_SENT: sent,
        MUSE_BRIDGE_FAKE_HISTORY: fixture,
      },
    });
    const got = JSON.parse(fs.readFileSync(sent, "utf8").trim().split("\n")[0]).text;
    assert.equal(got, want, args.join(" "));
  }
});

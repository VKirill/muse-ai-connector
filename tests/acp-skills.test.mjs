import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listSkills, readSkill, skillDirs } from "../bridge/acp-skills.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "muse-acp.mjs");

function withSkillDirs(dirs, fn) {
  const prev = process.env.MUSE_SKILL_DIRS;
  process.env.MUSE_SKILL_DIRS = dirs;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MUSE_SKILL_DIRS;
    else process.env.MUSE_SKILL_DIRS = prev;
  }
}

function seedSkills() {
  const dir = fs.mkdtempSync("/tmp/muse-skills-");
  fs.mkdirSync(path.join(dir, "zebra-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "zebra-skill", "SKILL.md"),
    "---\nname: zebra-skill\ndescription: Paint zebra stripes on things\n---\n\nSTRIPE-RULE-42: always black first.\n",
  );
  fs.mkdirSync(path.join(dir, "lion-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lion-skill", "SKILL.md"), "---\nname: lion-skill\ndescription: Roar at gazelles\n---\n\nRoar twice.\n");
  return dir;
}

test("skillDirs: MUSE_SKILL_DIRS wins; defaults cover cwd, home, and bundled skills", () => {
  withSkillDirs("/tmp/a:/tmp/b", () => {
    assert.deepEqual(skillDirs("/work"), ["/tmp/a", "/tmp/b"]);
    assert.deepEqual(skillDirs("/work").length, 2);
  });
  withSkillDirs("", () => {
    const defaults = skillDirs("/work");
    assert.ok(defaults.includes(path.join(here, "..", "skills")));
  });
});

test("bundled muse-connector skill is declared in package.json and portable for clean BB installs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  assert.deepEqual(pkg.bb?.skills, ["skills"]);
  const skillFile = path.join(here, "..", "skills", "muse-connector", "SKILL.md");
  const refFile = path.join(here, "..", "skills", "muse-connector", "REFERENCE.md");
  assert.ok(fs.existsSync(skillFile), "skills/muse-connector/SKILL.md must exist");
  assert.ok(fs.existsSync(refFile), "skills/muse-connector/REFERENCE.md must exist");
  const skillText = fs.readFileSync(skillFile, "utf8");
  const refText = fs.readFileSync(refFile, "utf8");
  assert.match(skillText, /^---\r?\nname:\s*muse-connector\r?\ndescription:/);
  assert.match(skillText, /accounts auto-login --batch -/);
  assert.ok(!skillText.includes("/Users/"), "SKILL.md must not contain local /Users/ paths");
  assert.ok(!refText.includes("/Users/"), "REFERENCE.md must not contain local /Users/ paths");

  const emptyDir = fs.mkdtempSync("/tmp/muse-bundled-only-");
  try {
    withSkillDirs(`${emptyDir}:${path.join(here, "..", "skills")}`, () => {
      assert.match(listSkills("/anywhere", "muse-connector"), /muse-connector —/);
      assert.match(readSkill("/anywhere", "muse-connector"), /accounts auto-login/);
    });
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("listSkills scans front matter and filters by query, capped at 30", () => {
  const dir = seedSkills();
  withSkillDirs(dir, () => {
    const all = listSkills("/anywhere", "");
    assert.match(all, /zebra-skill — Paint zebra stripes on things/);
    assert.match(all, /lion-skill — Roar at gazelles/);
    const zebra = listSkills("/anywhere", "zebra");
    assert.match(zebra, /zebra-skill/);
    assert.ok(!zebra.includes("lion-skill"));
  });
});

test("readSkill returns the SKILL.md text by name", () => {
  const dir = seedSkills();
  withSkillDirs(dir, () => {
    assert.match(readSkill("/anywhere", "zebra-skill"), /STRIPE-RULE-42/);
    assert.equal(readSkill("/anywhere", "missing"), null);
  });
});

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
  const home = fs.mkdtempSync("/tmp/muse-acp-skills-");
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

test("list_skills and read_skill run through the tool loop", async () => {
  const dir = seedSkills();
  const home = seedHome();
  const ws = fs.mkdtempSync("/tmp/muse-ws-");
  const block = (o) => `\`\`\`muse-tool\n${JSON.stringify(o)}\n\`\`\``;
  const script = path.join(home, "script.json");
  const sent = path.join(home, "sent.jsonl");
  fs.writeFileSync(
    script,
    JSON.stringify([block({ tool: "list_skills", args: { query: "zebra" } }), block({ tool: "read_skill", args: { name: "zebra-skill" } }), "done"]),
  );
  const agent = startAgent({
    MUSE_BRIDGE_FAKE: "1",
    MUSE_BRIDGE_HOME: home,
    MUSE_BRIDGE_FAKE_SCRIPT: script,
    MUSE_BRIDGE_FAKE_SENT: sent,
    MUSE_SKILL_DIRS: dir,
  });
  try {
    await agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
    const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const result = await agent.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
    assert.equal(result.stopReason, "end_turn");
    const texts = fs
      .readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    assert.match(texts[1], /^TOOL RESULT 1\/1 list_skills \(ok\):\nzebra-skill — Paint zebra stripes on things/);
    assert.match(texts[2], /STRIPE-RULE-42: always black first/);
  } finally {
    agent.close();
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runTool } from "../bridge/acp-tools.mjs";
import { CACHE_MS } from "../bridge/bb-skills.mjs";

const ID = `skill_${"a".repeat(64)}`;

function fakeBb() {
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "list") return JSON.stringify({ skills: [{ id: ID, name: "gist-content-logic", description: "GIST page briefs" }] });
    if (args[1] === "show" && args[4] === "SKILL.md") return JSON.stringify({ content: "---\nname: gist-content-logic\n---\nGIST-RULE-7", revision: "r1" });
    if (args[1] === "show" && args[4] === "references/original.md") return JSON.stringify({ content: "# GIST Content Logic v4.3", revision: "r1" });
    throw new Error("HTTP 404");
  };
  return { calls, exec };
}

async function withEmptySkillDirs(fn) {
  const home = fs.mkdtempSync("/tmp/muse-bbskills-");
  const prev = { dirs: process.env.MUSE_SKILL_DIRS, home: process.env.MUSE_BRIDGE_HOME };
  process.env.MUSE_SKILL_DIRS = fs.mkdtempSync("/tmp/muse-noskills-");
  process.env.MUSE_BRIDGE_HOME = home;
  try {
    return await fn();
  } finally {
    for (const [key, value] of [["MUSE_SKILL_DIRS", prev.dirs], ["MUSE_BRIDGE_HOME", prev.home]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a BB skill missing on disk is listed and read through bb, then served from the cache", () =>
  withEmptySkillDirs(async () => {
    const bb = fakeBb();
    const ctx = { cwd: "/tmp", bbSkills: { exec: bb.exec } };
    assert.match((await runTool("list_skills", { query: "gist" }, ctx)).output, /^gist-content-logic — GIST page briefs/);
    const read = await runTool("read_skill", { name: "gist-content-logic" }, ctx);
    assert.equal(read.ok, true);
    assert.match(read.output, /GIST-RULE-7/);
    const ref = await runTool("read_skill", { name: "gist-content-logic", path: "references/original.md" }, ctx);
    assert.match(ref.output, /GIST Content Logic v4\.3/);
    await runTool("read_skill", { name: "gist-content-logic" }, ctx);
    assert.deepEqual(bb.calls, [
      "skill list --json",
      `skill show ${ID} --path SKILL.md --json`,
      `skill show ${ID} --path references/original.md --json`,
    ]);
    const stale = await runTool("read_skill", { name: "gist-content-logic" }, { cwd: "/tmp", bbSkills: { exec: bb.exec, now: Date.now() + CACHE_MS + 1 } });
    assert.match(stale.output, /GIST-RULE-7/);
    assert.equal(bb.calls.length, 5, "a stale cache asks bb again");
  }));

test("unknown skills, escaping paths and an unreachable bb stay a clean not-found", () =>
  withEmptySkillDirs(async () => {
    const bb = fakeBb();
    const ctx = { cwd: "/tmp", bbSkills: { exec: bb.exec } };
    assert.match((await runTool("read_skill", { name: "nope" }, ctx)).output, /skill not found: nope/);
    assert.match((await runTool("read_skill", { name: "gist-content-logic", path: "../../etc/passwd" }, ctx)).output, /skill not found/);
    const down = { cwd: "/tmp", bbSkills: { exec: async () => { throw new Error("fetch failed"); } } };
    fs.rmSync(`${process.env.MUSE_BRIDGE_HOME}/cache`, { recursive: true, force: true });
    assert.equal((await runTool("list_skills", {}, down)).output.includes("gist-content-logic"), false);
  }));

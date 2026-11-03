import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SKILLS = 30;
const SKILL_TEXT_CAP = 20 * 1024;

export function skillDirs(cwd) {
  const env = process.env.MUSE_SKILL_DIRS;
  if (env && env.trim()) {
    return env
      .split(":")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => path.resolve(cwd, d));
  }
  return [
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".bb", "skills"),
  ];
}

function parseSkill(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  let name = null;
  let description = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name" && name === null) name = value;
    else if (kv[1] === "description" && !description) description = value;
  }
  return { name, description, text };
}

function scanSkills(cwd) {
  const seen = new Set();
  const out = [];
  for (const dir of skillDirs(cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const file = path.join(dir, e.name, "SKILL.md");
      const skill = parseSkill(file);
      if (!skill) continue;
      const name = skill.name || e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: skill.description, file, text: skill.text });
    }
  }
  return out;
}

/** list_skills: up to 30 "name — description" rows matching an optional query. */
export function listSkills(cwd, query) {
  const q = String(query ?? "").trim().toLowerCase();
  const all = scanSkills(cwd);
  const filtered = q ? all.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q)) : all;
  const rows = filtered.slice(0, MAX_SKILLS).map((s) => `${s.name} — ${s.description}`.replace(/\s+—\s*$/, ""));
  if (!rows.length) return "no skills found";
  const more = filtered.length > MAX_SKILLS ? `\n…and ${filtered.length - MAX_SKILLS} more` : "";
  return rows.join("\n") + more;
}

/** read_skill: full SKILL.md text by front-matter name (or directory name). */
export function readSkill(cwd, name) {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;
  const skill = scanSkills(cwd).find((s) => s.name === wanted);
  if (!skill) return null;
  return skill.text.length > SKILL_TEXT_CAP ? `${skill.text.slice(0, SKILL_TEXT_CAP)}\n…[truncated]` : skill.text;
}

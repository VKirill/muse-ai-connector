import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bridgeHome } from "./paths.mjs";

/**
 * BB keeps its skills on the hub (no SKILL.md files on the machine since the 2026-11 cleanup), and
 * Claude/Codex get them from BB natively. muse-acp asks `bb skill list|show` instead. Both calls take
 * up to a couple of minutes on a busy hub, so answers are cached on disk for CACHE_MS.
 */
export const CACHE_MS = 6 * 60 * 60_000;
const BB_TIMEOUT_MS = 180_000;

function runBb(args) {
  return new Promise((resolve, reject) => {
    execFile("bb", args, { timeout: BB_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

function cacheDir() {
  return path.join(bridgeHome(), "cache", "bb-skills");
}

function fresh(file, now) {
  try {
    return now - fs.statSync(file).mtimeMs < CACHE_MS;
  } catch {
    return false;
  }
}

function writeCache(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** `[{id, name, description}]` of BB's skills, or [] when bb is unreachable. */
export async function bbSkillIndex({ exec = runBb, now = Date.now() } = {}) {
  const file = path.join(cacheDir(), "index.json");
  if (fresh(file, now)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* rebuilt below */
    }
  }
  try {
    const parsed = JSON.parse(await exec(["skill", "list", "--json"]));
    const rows = (parsed.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description ?? "" }));
    writeCache(file, JSON.stringify(rows));
    return rows;
  } catch {
    return [];
  }
}

/** Text of `relPath` (default SKILL.md) of BB skill `name`, or null when BB has no such skill or file. */
export async function readBbSkill(name, relPath = "SKILL.md", deps = {}) {
  const rel = String(relPath || "SKILL.md");
  if (rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) return null;
  const skill = (await bbSkillIndex(deps)).find((s) => s.name === name);
  if (!skill) return null;
  const file = path.join(cacheDir(), skill.id, rel);
  if (fresh(file, deps.now ?? Date.now())) return fs.readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(await (deps.exec ?? runBb)(["skill", "show", skill.id, "--path", rel, "--json"]));
    if (typeof parsed.content !== "string") return null;
    writeCache(file, parsed.content);
    return parsed.content;
  } catch {
    return null;
  }
}

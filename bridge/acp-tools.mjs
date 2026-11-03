import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { listSkills, readSkill } from "./acp-skills.mjs";

const execFileP = promisify(execFile);

export const OUTPUT_CAP = 8 * 1024;
export const MESSAGE_CAP = 24 * 1024;
export const MAX_TOOL_CALLS = 8;
const OUTPUT_HEAD = 6 * 1024;
const OUTPUT_TAIL = 2 * 1024;
const GLOB_MAX_LINES = 500;
const GREP_MAX_MATCHES = 200;
const GREP_MAX_FILES = 5000;
const GREP_MAX_FILE_BYTES = 512 * 1024;
const BASH_DEFAULT_TIMEOUT_SEC = 120;
const BASH_MAX_TIMEOUT_SEC = 600;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const TOOL_OPEN_RE = /```muse-tool[ \t]*\r?\n?/g;
const TOOL_BLOCK_RE = /```muse-tool[ \t]*\r?\n?([\s\S]*?)```/g;
const TRAILING_FENCE_RE = /^\s*```[ \t]*\r?\n?/;
const INTRO_BUDGET = 7000;

const LOCAL_TOOL_SCHEMAS = {
  read_file: {
    description: "Read a file in the workspace. offset = first line (1-based), limit = line count.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  write_file: {
    description: "Write a whole file in the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  edit_file: {
    description: "Replace one exact, unique occurrence of 'old' with 'new' in a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["path", "old", "new"],
    },
  },
  list_dir: {
    description: "List a directory in the workspace (default: workspace root).",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  grep: {
    description: "Regex search in the workspace; prints file:line:match.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  glob: {
    description: "List files matching a glob pattern (e.g. src/**/*.ts); skips .git and node_modules.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  apply_patch: {
    description: "Apply a unified diff relative to the workspace root (git apply, or patch -p1 outside a git repo).",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
    },
  },
  bash: {
    description: "Run /bin/bash -lc in the workspace (default timeout 120s, max 600s).",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, timeout_sec: { type: "integer" } },
      required: ["command"],
    },
  },
  tool_schema: {
    description: "Return the description and input schema of any tool (local or mcp__<server>__<tool>).",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  list_skills: {
    description: "List skills installed on this machine; optional query filters name and description.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  read_skill: {
    description: "Read a skill's SKILL.md instructions by name (from list_skills).",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
};

function toolError(message) {
  const err = new Error(message);
  err.code = "tool_error";
  return err;
}

export function cap(text, limit = OUTPUT_CAP) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  const tail = Math.min(OUTPUT_TAIL, Math.floor(limit / 4));
  let head = limit - tail;
  for (;;) {
    const marker = `\n… ${s.length - head - tail} bytes cut …\n`;
    const next = Math.max(0, limit - tail - marker.length);
    if (next === head) return s.slice(0, head) + marker + s.slice(-tail);
    head = next;
  }
}

function lastMatch(re, text) {
  re.lastIndex = 0;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match;
  return last;
}

function finishToolPayload(parsed, thought) {
  const name = typeof parsed?.tool === "string" ? parsed.tool : "";
  const args = parsed && typeof parsed.args === "object" && parsed.args !== null ? parsed.args : {};
  if (!name) return { kind: "error", name: "muse-tool", error: "muse-tool block has no tool name", args, thought };
  return { kind: "call", name, args, thought };
}

function scanJsonValue(s) {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  if (i >= s.length || (s[i] !== "{" && s[i] !== "[")) {
    return { json: s.trim(), rest: "", inString: false, closers: "" };
  }
  const start = i;
  const stack = [];
  let inString = false;
  let escape = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      stack.push("}");
      continue;
    }
    if (c === "[") {
      stack.push("]");
      continue;
    }
    if (c === "}" || c === "]") {
      if (stack[stack.length - 1] === c) stack.pop();
      if (stack.length === 0) {
        return { json: s.slice(start, i + 1), rest: s.slice(i + 1), inString: false, closers: "" };
      }
    }
  }
  if (inString) return { json: "", rest: "", inString: true, closers: "" };
  return { json: s.slice(start), rest: "", inString: false, closers: stack.reverse().join("") };
}

function parseFromOpener(text) {
  const last = lastMatch(TOOL_OPEN_RE, text);
  if (!last) return { kind: "none", text };
  const before = text.slice(0, last.index);
  const scanned = scanJsonValue(text.slice(last.index + last[0].length));
  if (scanned.inString) {
    return {
      kind: "error",
      name: "muse-tool",
      error: "muse-tool block was cut off inside a string",
      args: {},
      thought: before.trim(),
    };
  }
  const thought = (before + scanned.rest.replace(TRAILING_FENCE_RE, "")).trim();
  try {
    return finishToolPayload(JSON.parse(scanned.json + scanned.closers), thought);
  } catch (err) {
    return { kind: "error", name: "muse-tool", error: `invalid muse-tool JSON: ${err.message}`, args: {}, thought };
  }
}

/**
 * Finds the LAST ```muse-tool fenced block in a Muse reply.
 * A closed fence wins when its JSON parses; otherwise the last opener is scanned
 * so a missing fence or final brace still yields a tool call.
 * Returns {kind:"none", text} | {kind:"call", name, args, thought} | {kind:"error", name, error, thought}.
 * `thought` is the reply text outside that block (streams to BB as agent_thought_chunk).
 */
export function parseToolCall(reply) {
  const text = String(reply ?? "");
  const last = lastMatch(TOOL_BLOCK_RE, text);
  if (last) {
    const thought = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
    try {
      return finishToolPayload(JSON.parse(last[1].trim()), thought);
    } catch {
      // ``` inside a JSON string makes the fence regex close too early.
    }
  }
  return parseFromOpener(text);
}

/**
 * Finds ALL ```muse-tool blocks in a Muse reply, in order. Each opener is scanned
 * as a JSON value (fences are ignored), so a block cut off mid-JSON or one whose
 * closing fence sits inside a string still resolves; a truly cut block becomes an
 * error entry and the remaining blocks still parse. At most MAX_TOOL_CALLS calls
 * are returned; `dropped` counts the rest.
 * Returns {kind:"none", text} | {kind:"calls", calls, thought, dropped} where each
 * call is {kind:"call", name, args} | {kind:"error", name, error}.
 */
export function parseToolCalls(reply) {
  const text = String(reply ?? "");
  const openers = [];
  TOOL_OPEN_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_OPEN_RE.exec(text)) !== null) {
    openers.push({ index: match.index, end: match.index + match[0].length });
  }
  if (!openers.length) return { kind: "none", text };
  const calls = [];
  const thoughtParts = [text.slice(0, openers[0].index)];
  let dropped = 0;
  for (let i = 0; i < openers.length; i++) {
    const segEnd = i + 1 < openers.length ? openers[i + 1].index : text.length;
    const scanned = scanJsonValue(text.slice(openers[i].end, segEnd));
    let entry;
    if (scanned.inString) {
      entry = { kind: "error", name: "muse-tool", error: "muse-tool block was cut off inside a string", args: {} };
    } else {
      try {
        entry = finishToolPayload(JSON.parse(scanned.json + scanned.closers), "");
      } catch (err) {
        entry = { kind: "error", name: "muse-tool", error: `invalid muse-tool JSON: ${err.message}`, args: {} };
      }
    }
    if (calls.length < MAX_TOOL_CALLS) calls.push(entry);
    else dropped += 1;
    thoughtParts.push(scanned.rest.replace(TRAILING_FENCE_RE, ""));
  }
  return { kind: "calls", calls, thought: thoughtParts.join("").trim(), dropped };
}

const DONE_TAIL_RE = /([ \t]*\*{0,2}\[\[done\]\]\*{0,2})+[ \t]*$/i;

/**
 * The final-answer marker: if the reply ends with a [[done]] marker — on its own
 * line or at the end of the last line — returns the text with the marker
 * stripped; otherwise null. A [[done]] earlier in the text is not a marker.
 */
export function stripDoneMarker(reply) {
  const trimmed = String(reply ?? "").replace(/\s+$/, "");
  if (!DONE_TAIL_RE.test(trimmed)) return null;
  return trimmed.replace(DONE_TAIL_RE, "").replace(/\s+$/, "");
}

export function resultMessage(name, ok, output, index = 1, total = 1) {
  return `TOOL RESULT ${index}/${total} ${name} (${ok ? "ok" : "error"}):\n${output}`;
}

export function toolKind(name) {
  switch (name) {
    case "read_file":
      return "read";
    case "write_file":
    case "edit_file":
    case "apply_patch":
      return "edit";
    case "list_dir":
    case "grep":
    case "glob":
      return "search";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

export function toolTitle(name, args) {
  const hint = args?.path ?? args?.command ?? args?.pattern ?? "";
  const title = hint ? `${name} ${hint}` : name;
  return title.length > 100 ? `${title.slice(0, 97)}…` : title;
}

/** Resolves a tool path inside the session cwd; throws when it escapes. */
export function resolveSessionPath(cwd, p) {
  if (typeof p !== "string" || !p.trim()) throw toolError("path must be a non-empty string");
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw toolError(`path outside workspace: ${p}`);
  return abs;
}

export function buildIntro(cwd, mcpToolNames = []) {
  const header = `You are Muse, an agent working inside a BB chat. Your workspace is:
${cwd}

That workspace is on the user's machine, not on your own computer. Reach it only through
muse-tool blocks; never use your own shell or tools for it — they would look at a
different machine. Your first step is list_dir on the workspace root, then read the
files the task needs.

muse-tool is not one of your tools. It is a fenced text block you write at the end of
your reply; the BB bridge on the user's machine runs it and answers in the next message.
Your own tools (muse.read, muse.write, muse.exec, your shell) work on your cloud VM, not
in the user's workspace; files the user asked for must be written with a muse-tool
write_file block. For the web use your native browser.* tools as usual, then bring the
result into the workspace with muse-tool.

You cannot call functions directly. To use tools, END your reply with up to 8 fenced blocks:

\`\`\`muse-tool
{"tool":"<name>","args":{...}}
\`\`\`

Put independent reads and searches in one reply; send edits once you know what to change.
The bridge runs the blocks in order and sends you one next message in this chat, one
section per call:
TOOL RESULT <n>/<total> <name> (ok|error):
<output>

Then continue. When you have finished and this is your final answer to the user, end it
with a line containing only [[done]]. A reply with neither a muse-tool block nor [[done]]
is treated as unfinished.
Text before the block is shown to the user as your thought — keep it short.

Tools (paths are relative to the workspace; absolute paths inside it also work):
- read_file {path, offset?, limit?} — read a file (offset = first line, 1-based; limit = line count)
- write_file {path, content} — write a whole file
- edit_file {path, old, new} — replace one exact, unique occurrence of 'old' with 'new'
- list_dir {path?} — list a directory (default: workspace root)
- grep {pattern, path?} — regex search, prints file:line:match
- glob {pattern, path?} — files matching a glob like src/**/*.ts (skips .git, node_modules)
- apply_patch {patch} — apply a unified diff to workspace files
- bash {command, timeout_sec?} — run /bin/bash -lc in the workspace (default 120s, max 600s)
- tool_schema {name} — input schema of any tool (use it before calling an mcp__ tool)
- list_skills {query?} — find skills installed on this machine; read_skill {name} reads one

Rules: paths outside the workspace are refused; edit_file fails when 'old' matches zero or
several times; outputs are capped at ~8 KB per call and ~24 KB per message — read or grep
narrower when a result is truncated.
Reply in the language the user writes in, unless the project rules below say otherwise.
Before changing files, read AGENTS.md or CLAUDE.md in the workspace when present and follow them.
`;
  const names = (mcpToolNames ?? []).filter((n) => typeof n === "string" && n);
  if (!names.length) return header;
  const footer = `\nMCP tools attached to this session:\n`;
  const keep = [];
  let length = header.length + footer.length;
  for (const name of names) {
    const add = name.length + (keep.length ? 2 : 0);
    const marker = `, …and ${names.length - keep.length - 1} more\n`;
    if (length + add + marker.length > INTRO_BUDGET) break;
    keep.push(name);
    length += add;
  }
  const rest = names.length - keep.length;
  return `${header}${footer}${keep.join(", ")}${rest ? `, …and ${rest} more` : ""}\n`;
}

/**
 * Runs one local tool. ctx: {cwd, sessionId, fsRead, fsWrite, clientRequest(method, params)}.
 * fsRead/fsWrite route file reads/writes through the ACP client's fs/* requests.
 * Returns {ok: true, output} | {ok: false, output}.
 */
export async function runTool(name, args, ctx) {
  try {
    switch (name) {
      case "read_file":
        return { ok: true, output: await toolRead(args, ctx) };
      case "write_file":
        return { ok: true, output: await toolWrite(args, ctx) };
      case "edit_file":
        return { ok: true, output: await toolEdit(args, ctx) };
      case "list_dir":
        return { ok: true, output: toolList(args, ctx) };
      case "grep":
        return { ok: true, output: toolGrep(args, ctx) };
      case "glob":
        return { ok: true, output: toolGlob(args, ctx) };
      case "apply_patch":
        return { ok: true, output: await toolApplyPatch(args, ctx) };
      case "bash":
        return { ok: true, output: await toolBash(args, ctx) };
      case "tool_schema":
        return { ok: true, output: toolSchema(args, ctx) };
      case "list_skills":
        return { ok: true, output: cap(listSkills(ctx.cwd, args?.query)) };
      case "read_skill": {
        const text = readSkill(ctx.cwd, args?.name);
        if (text === null) throw toolError(`read_skill: skill not found: ${args?.name}`);
        return { ok: true, output: cap(text) };
      }
      default:
        if (typeof name === "string" && name.startsWith("mcp__") && ctx.callMcp) return ctx.callMcp(name, args);
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: cap(err?.message || String(err)) };
  }
}

function toolSchema(args, ctx) {
  const name = String(args?.name ?? "");
  if (!name) throw toolError("tool_schema: 'name' must be a non-empty string");
  const local = LOCAL_TOOL_SCHEMAS[name];
  const info = local ? { name, ...local } : ctx.describeMcp?.(name);
  if (!info) throw toolError(`tool_schema: unknown tool: ${name}`);
  return JSON.stringify(info, null, 2);
}

function lineRange(args) {
  const line = Math.max(1, Math.floor(Number(args?.offset ?? args?.line) || 1));
  const limit = Math.max(0, Math.floor(Number(args?.limit) || 0));
  return { line, limit };
}

async function readLocal(abs, { line, limit }) {
  const content = await fs.promises.readFile(abs, "utf8");
  const lines = content.split("\n");
  const slice = limit > 0 ? lines.slice(line - 1, line - 1 + limit) : lines.slice(line - 1);
  return cap(slice.join("\n"));
}

async function toolRead(args, ctx) {
  const abs = resolveSessionPath(ctx.cwd, args?.path);
  const { line, limit } = lineRange(args);
  if (ctx.fsRead) {
    const res = await ctx.clientRequest("fs/read_text_file", {
      sessionId: ctx.sessionId,
      path: abs,
      ...(line > 1 ? { line } : {}),
      ...(limit > 0 ? { limit } : {}),
    });
    return cap(res?.content ?? "");
  }
  return readLocal(abs, { line, limit });
}

async function writeLocal(abs, content) {
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content);
}

async function toolWrite(args, ctx) {
  const abs = resolveSessionPath(ctx.cwd, args?.path);
  const content = String(args?.content ?? "");
  if (ctx.fsWrite) {
    await ctx.clientRequest("fs/write_text_file", { sessionId: ctx.sessionId, path: abs, content });
  } else {
    await writeLocal(abs, content);
  }
  return `wrote ${Buffer.byteLength(content)} bytes to ${args.path}`;
}

async function toolEdit(args, ctx) {
  const abs = resolveSessionPath(ctx.cwd, args?.path);
  const oldText = String(args?.old ?? "");
  const newText = String(args?.new ?? "");
  if (!oldText) throw toolError("edit_file: 'old' must be a non-empty string");
  let content;
  if (ctx.fsRead) {
    const res = await ctx.clientRequest("fs/read_text_file", { sessionId: ctx.sessionId, path: abs });
    content = String(res?.content ?? "");
  } else {
    content = await fs.promises.readFile(abs, "utf8");
  }
  const count = content.split(oldText).length - 1;
  if (count === 0) throw toolError("edit_file: 'old' text not found");
  if (count > 1) throw toolError(`edit_file: 'old' text matches ${count} times, expected exactly 1`);
  const next = content.replace(oldText, newText);
  if (ctx.fsWrite) {
    await ctx.clientRequest("fs/write_text_file", { sessionId: ctx.sessionId, path: abs, content: next });
  } else {
    await fs.promises.writeFile(abs, next);
  }
  return `edited ${args.path}`;
}

function toolList(args, ctx) {
  const abs = resolveSessionPath(ctx.cwd, args?.path ?? ".");
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  return cap(entries.join("\n"));
}

function toolGrep(args, ctx) {
  const pattern = args?.pattern;
  if (typeof pattern !== "string" || !pattern) throw toolError("grep: 'pattern' must be a non-empty string");
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw toolError(`grep: bad pattern: ${err.message}`);
  }
  const abs = resolveSessionPath(ctx.cwd, args?.path ?? ".");
  const root = path.resolve(ctx.cwd);
  const matches = [];
  let files = 0;
  let truncated = false;
  const grepFile = (file) => {
    files++;
    let lines;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) return;
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      return;
    }
    const rel = path.relative(root, file) || file;
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= GREP_MAX_MATCHES) {
        truncated = true;
        return;
      }
      if (re.test(lines[i])) matches.push(`${rel}:${i + 1}:${lines[i]}`);
    }
  };
  const walk = (dir) => {
    if (files >= GREP_MAX_FILES || truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= GREP_MAX_FILES || truncated) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else {
        grepFile(p);
      }
    }
  };
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw toolError(`grep: no such path: ${args?.path ?? "."}`);
  if (stat.isDirectory()) walk(abs);
  else grepFile(abs);
  const suffix = truncated ? `\n…[stopped at ${GREP_MAX_MATCHES} matches]` : "";
  return cap(matches.length ? matches.join("\n") + suffix : "no matches");
}

const GLOB_RE_ESCAPE = /[.+^${}()|[\]\\]/g;

function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close < 0) {
        re += "\\{";
      } else {
        re += `(?:${pattern
          .slice(i + 1, close)
          .split(",")
          .map((alt) => alt.replace(GLOB_RE_ESCAPE, "\\$&"))
          .join("|")})`;
        i = close;
      }
    } else {
      re += c.replace(GLOB_RE_ESCAPE, "\\$&");
    }
  }
  return new RegExp(`${re}$`);
}

function toolGlob(args, ctx) {
  const pattern = args?.pattern;
  if (typeof pattern !== "string" || !pattern) throw toolError("glob: 'pattern' must be a non-empty string");
  const abs = resolveSessionPath(ctx.cwd, args?.path ?? ".");
  const root = path.resolve(ctx.cwd);
  let re;
  try {
    re = globToRegExp(pattern);
  } catch (err) {
    throw toolError(`glob: bad pattern: ${err.message}`);
  }
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw toolError(`glob: no such path: ${args?.path ?? "."}`);
  const matches = [];
  const walk = (dir) => {
    if (matches.length >= GLOB_MAX_LINES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (matches.length >= GLOB_MAX_LINES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else {
        const rel = path.relative(root, p).split(path.sep).join("/");
        if (re.test(rel)) matches.push(rel);
      }
    }
  };
  if (stat.isDirectory()) walk(abs);
  else if (re.test(path.relative(root, abs).split(path.sep).join("/"))) matches.push(path.relative(root, abs));
  matches.sort();
  const suffix = matches.length >= GLOB_MAX_LINES ? `\n…[stopped at ${GLOB_MAX_LINES} files]` : "";
  return cap(matches.length ? matches.join("\n") + suffix : "no matches");
}

const PATCH_PATH_RE = /^\+\+\+\s+(?:b\/)?(\S+)/gm;

async function toolApplyPatch(args, ctx) {
  const patch = String(args?.patch ?? "");
  if (!patch.trim()) throw toolError("apply_patch: 'patch' must be a non-empty string");
  const targets = [];
  PATCH_PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATCH_PATH_RE.exec(patch)) !== null) {
    if (m[1] !== "/dev/null") targets.push(m[1]);
  }
  for (const target of targets) resolveSessionPath(ctx.cwd, target);
  const tmp = path.join(os.tmpdir(), `muse-patch-${process.pid}-${Date.now()}.diff`);
  await fs.promises.writeFile(tmp, patch);
  try {
    let isRepo = false;
    try {
      const probe = await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
      isRepo = probe.stdout.trim() === "true";
    } catch {
      isRepo = false;
    }
    if (isRepo) {
      await execFileP("git", ["apply", "--whitespace=nowarn", tmp], { cwd: ctx.cwd });
    } else {
      await execFileP("patch", ["-p1", "--forward", "-i", tmp], { cwd: ctx.cwd });
    }
  } catch (err) {
    const out = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim();
    throw toolError(`apply_patch failed: ${out || err?.message || err}`);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
  return `applied patch to:\n${targets.join("\n")}`;
}

async function toolBash(args, ctx) {
  const command = String(args?.command ?? "");
  if (!command.trim()) throw toolError("bash: 'command' must be a non-empty string");
  const timeoutSec = Math.min(BASH_MAX_TIMEOUT_SEC, Math.max(1, Number(args?.timeout_sec) || BASH_DEFAULT_TIMEOUT_SEC));
  try {
    const res = await execFileP("/bin/bash", ["-lc", command], {
      cwd: ctx.cwd,
      timeout: timeoutSec * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return cap(`exit 0\n${res.stdout}${res.stderr}`.trimEnd());
  } catch (err) {
    const out = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trimEnd();
    if (err?.killed) throw toolError(`bash: killed after ${timeoutSec}s\n${cap(out)}`.trimEnd());
    return cap(`exit ${err?.code ?? "?"}\n${out}`.trimEnd());
  }
}

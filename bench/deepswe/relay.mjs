#!/usr/bin/env node
// relay.mjs — Mac-side relay between the Muse chat and the DeepSWE bench queue.
//
// The Pier agent on ovh-main drops queue/<session>.json when a task container
// is ready for Muse. This relay sends the task to Muse (through musebridge),
// keeps the chat going until the reply ends with DONE, then writes
// queue/<session>.done for the agent to collect.
//
// Usage: node bench/deepswe/relay.mjs [--once]
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const CONTINUE_PROMPT = "Continue autonomously until the task is committed, then reply DONE.";

const BENCH_TARGET = {
  host: process.env.MUSE_BENCH_TARGET_HOST ?? "100.73.123.79",
  port: Number(process.env.MUSE_BENCH_TARGET_PORT ?? "2222"),
  user: process.env.MUSE_BENCH_TARGET_USER ?? "muse",
};

export function buildPrompt({ host, port, user, instruction }) {
  return [
    "You are solving a software engineering task inside a remote sandbox.",
    "",
    `Connect with SSH: ssh -p ${port} ${user}@${host}`,
    "You land in /app, which holds the task repository. There is no internet access inside the sandbox; use only what is installed on that machine.",
    "",
    "Task:",
    instruction,
    "",
    "Rules:",
    "- Work autonomously until the task is solved; do not ask questions.",
    "- Run the tests or checks you need inside the sandbox.",
    '- Commit all your work with git (git add -A && git commit -m "what you did").',
    "- Do not read the git history for answers.",
    "- Reply with a short summary of what you did, ending with the word DONE.",
  ].join("\n");
}

export function isDone(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1].replace(/^[#>*_`\s]+|[#>*_`.,!?:;\s]+$/g, "");
  return /\bDONE\b/.test(last);
}

export async function relayOnce({ listQueue, send, writeDone, maxContinues = 8, log = () => {}, target = BENCH_TARGET }) {
  const results = [];
  for (const item of await listQueue()) {
    let reply = await send({ text: buildPrompt({ ...target, instruction: item.instruction }) });
    let turns = 1;
    while (!isDone(reply.text) && turns <= maxContinues) {
      reply = await send({ chatId: reply.chatId, text: CONTINUE_PROMPT });
      turns += 1;
    }
    const status = isDone(reply.text) ? "done" : "gave_up";
    await writeDone(item.session, { status, summary: reply.text });
    const result = { session: item.session, chatId: reply.chatId, turns, status };
    log(result);
    results.push(result);
  }
  return results;
}

// --- CLI wiring: real queue over `ssh ovh-main`, real chats via musebridge ---

const SSH_HOST = process.env.MUSE_BENCH_SSH ?? "ovh-main";
const QUEUE_DIR = process.env.MUSE_BENCH_QUEUE ?? "/srv/muse-bench/queue";
const MUSEBRIDGE = path.join(here, "..", "..", "bin", "musebridge.mjs");

async function ssh(command) {
  const { stdout } = await execFileP("ssh", [SSH_HOST, command], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function listQueue() {
  const names = await ssh(
    "cd '" + QUEUE_DIR + "' && for f in *.json; do [ -e \"$f\" ] || continue; " +
      "[ -e \"${f%.json}.done\" ] || printf '%s\\n' \"${f%.json}\"; done",
  );
  const items = [];
  for (const session of names.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const parsed = JSON.parse(await ssh("cat '" + QUEUE_DIR + "/" + session + ".json'"));
    items.push({ ...parsed, session: parsed.session ?? session });
  }
  return items;
}

async function writeDone(session, result) {
  if (!/^[A-Za-z0-9_.-]+$/.test(session)) throw new Error(`bad session name: ${session}`);
  const payload = Buffer.from(`${JSON.stringify(result)}\n`).toString("base64");
  await ssh("printf %s '" + payload + "' | base64 -d > '" + QUEUE_DIR + "/" + session + ".done'");
}

export function replyTimeoutSec() {
  const value = Number(process.env.MUSE_RELAY_REPLY_TIMEOUT_SEC ?? "5400");
  return Number.isFinite(value) && value >= 1 ? value : 5400;
}

export function sendArgs({ chatId, text }) {
  const args = [MUSEBRIDGE, "send", "--json", "--timeout", String(replyTimeoutSec())];
  if (chatId) args.push("--chat", chatId);
  args.push(text);
  return args;
}

async function send({ chatId, text }) {
  const args = sendArgs({ chatId, text });
  const { stdout } = await execFileP(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function log(entry) {
  const dir = path.join(here, "runs", new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "relay.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  console.log(JSON.stringify(entry));
}

async function main() {
  const once = process.argv.includes("--once");
  const pollSec = Number(process.env.MUSE_RELAY_POLL_SEC ?? "30");
  for (;;) {
    await relayOnce({ listQueue, send, writeDone, log, target: BENCH_TARGET });
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, pollSec * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

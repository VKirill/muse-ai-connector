#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { acquire, listAccounts, pickAccount, setStatus, touch } from "../bridge/accounts.mjs";
import { bridgeHome } from "../bridge/paths.mjs";

const FAKE = process.env.MUSE_BRIDGE_FAKE === "1";
const LOCK_WAIT_MS = 5 * 60_000;
const HEADLESS = process.env.MUSE_HEADLESS !== "0" && process.env.MUSE_HEADLESS !== "false";
const REPLY_TIMEOUT_MS = Math.max(1, Number(process.env.MUSE_REPLY_TIMEOUT_SEC || 180)) * 1000;

/** @type {Map<string, { id: string, accountId: string | null, museChatId: string | null, cancelled: boolean }>} */
const sessions = new Map();

function sessionsPath() {
  return path.join(bridgeHome(), "sessions.json");
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(sessionsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSession(session) {
  fs.mkdirSync(bridgeHome(), { recursive: true });
  const store = loadStore();
  store[session.id] = { accountId: session.accountId, museChatId: session.museChatId };
  fs.writeFileSync(sessionsPath(), `${JSON.stringify(store, null, 2)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId, upd) {
  send({ method: "session/update", params: { sessionId, update: upd } });
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptText(prompt) {
  if (!Array.isArray(prompt)) return String(prompt ?? "");
  return prompt
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
}

function errorMessage(err) {
  const code = err?.code;
  if (code === "no_free_account") return "All Muse accounts are busy. Try again in a moment.";
  if (code === "no_signed_in_account") return "No signed-in Muse account. Open BB Settings → Plugins → Muse and sign in.";
  if (code === "reply_timeout") return "Muse did not finish a reply in time.";
  return String(err?.message || err);
}

function signedOutMessage(accountId) {
  const account = listAccounts().find((a) => a.id === accountId);
  const label = account?.label ?? accountId;
  return `Muse account ${label} is signed out: open BB Settings → Plugins → Muse and sign in again`;
}

async function openFakeSession() {
  return {
    isSignedIn: async () => true,
    async send({ chatId, onDelta, isCancelled }) {
      onDelta?.("PO");
      if (isCancelled?.()) throw codedError("cancelled", "cancelled");
      onDelta?.("NG");
      return { chatId: chatId ?? "fake-muse-chat", messageId: "assistant-msg-fake", text: "PONG" };
    },
    close: async () => {},
  };
}

async function openRealSession(opts) {
  const { openSession } = await import("../bridge/session.mjs");
  return openSession(opts);
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) return session;
  const saved = loadStore()[sessionId];
  if (!saved) throw codedError(-32602, `unknown session: ${sessionId}`);
  const restored = { id: sessionId, accountId: saved.accountId ?? null, museChatId: saved.museChatId ?? null, cancelled: false };
  sessions.set(sessionId, restored);
  return restored;
}

async function waitForLock(accountId, session) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (session.cancelled) throw codedError("cancelled", "cancelled");
    try {
      return acquire(accountId, { owner: `muse-acp:${session.id}` });
    } catch (err) {
      if (err.code !== "account_locked") throw err;
      await sleep(200);
    }
  }
  throw codedError("no_free_account", "All Muse accounts are busy");
}

async function runPrompt(session, params) {
  session.cancelled = false;
  const text = promptText(params.prompt).trim();
  try {
    if (!session.accountId) {
      const picked = pickAccount();
      session.accountId = picked.id;
      saveSession(session);
    }
    const release = await waitForLock(session.accountId, session);
    try {
      if (session.cancelled) return { stopReason: "cancelled" };
      touch(session.accountId);
      const driver = FAKE ? await openFakeSession({ accountId: session.accountId, headless: HEADLESS }) : await openRealSession({ accountId: session.accountId, headless: HEADLESS });
      try {
        const signedIn = await driver.isSignedIn();
        if (!signedIn) {
          setStatus(session.accountId, "signed_out");
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: signedOutMessage(session.accountId) } });
          return { stopReason: "end_turn" };
        }
        setStatus(session.accountId, "signed_in");
        const result = await driver.send({
          chatId: session.museChatId || undefined,
          text,
          timeoutMs: REPLY_TIMEOUT_MS,
          isCancelled: () => session.cancelled,
          onDelta: (suffix) => {
            if (!suffix) return;
            update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: suffix } });
          },
        });
        session.museChatId = result.chatId;
        saveSession(session);
        if (session.cancelled) return { stopReason: "cancelled" };
        return { stopReason: "end_turn" };
      } finally {
        await driver.close();
      }
    } finally {
      release();
    }
  } catch (err) {
    if (err?.code === "cancelled" || session.cancelled) return { stopReason: "cancelled" };
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: errorMessage(err) } });
    return { stopReason: "end_turn" };
  }
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: "muse-acp" },
        authMethods: [],
      };
    case "session/new": {
      const session = { id: `muse-${randomUUID()}`, accountId: null, museChatId: null, cancelled: false };
      sessions.set(session.id, session);
      saveSession(session);
      return { sessionId: session.id };
    }
    case "session/prompt":
      return runPrompt(getSession(params.sessionId), params);
    case "session/close":
      sessions.delete(params.sessionId);
      return {};
    default:
      throw codedError(-32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "session/cancel") {
    const session = sessions.get(msg.params?.sessionId);
    if (session) session.cancelled = true;
    return;
  }
  if (msg.method === undefined || msg.id === undefined) return;
  handle(msg.method, msg.params || {}).then(
    (result) => send({ id: msg.id, result: result ?? {} }),
    (err) => send({ id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message || err) } }),
  );
});

#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { acquire, listAccounts, pickAccount, setStatus, touch } from "../bridge/accounts.mjs";
import { waitForPendingReply } from "../bridge/acp-pending.mjs";
import { promptText } from "../bridge/acp-prompt.mjs";
import { bridgeHome } from "../bridge/paths.mjs";

const FAKE = process.env.MUSE_BRIDGE_FAKE === "1";
const FAKE_DELAY_MS = Math.max(0, Number(process.env.MUSE_BRIDGE_FAKE_DELAY_MS || 0));
const FAKE_REPLY_LAG_MS = Math.max(0, Number(process.env.MUSE_BRIDGE_FAKE_REPLY_LAG_MS || 0));
const LOCK_WAIT_MS = 5 * 60_000;
const HEADLESS = process.env.MUSE_HEADLESS !== "0" && process.env.MUSE_HEADLESS !== "false";
const REPLY_TIMEOUT_MS = Math.max(1, Number(process.env.MUSE_REPLY_TIMEOUT_SEC || 180)) * 1000;
const PENDING_WAIT_MS = Math.max(0, Number(process.env.MUSE_PENDING_WAIT_MS || 30_000));
const MUSE_MODEL_ID = "muse-spark";
const MUSE_MODEL_NAME = "Muse Spark";

/** @type {Map<string, { id: string, accountId: string | null, museChatId: string | null, cancelled: boolean, pendingReply: { chatId: string, deliveredPrefix: string } | null }>} */
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

const fakeChats = new Map();
let fakeSeq = 0;

function landFakeReply(messages, reply) {
  if (FAKE_REPLY_LAG_MS <= 0) {
    messages.push(reply);
    return;
  }
  const partial = { id: reply.id, role: "assistant", content: "PO", streaming: true };
  setTimeout(() => messages.push(partial), Math.floor(FAKE_REPLY_LAG_MS / 2)).unref();
  setTimeout(() => {
    const i = messages.indexOf(partial);
    if (i >= 0) messages.splice(i, 1);
    messages.push(reply);
  }, FAKE_REPLY_LAG_MS).unref();
}

async function openFakeSession() {
  return {
    isSignedIn: async () => true,
    async history(chatId) {
      return { chatId, revision: null, hasMore: false, messages: fakeChats.get(chatId) ?? [] };
    },
    async send({ chatId, text, onDelta, onChatId, isCancelled }) {
      const id = chatId ?? `fake-muse-chat-${++fakeSeq}`;
      let messages = fakeChats.get(id);
      if (!messages) fakeChats.set(id, (messages = []));
      onChatId?.(id);
      messages.push({ id: `fake-user-${++fakeSeq}`, role: "user", content: text, streaming: false });
      await sleep(FAKE_DELAY_MS);
      const reply = { id: `fake-assistant-${++fakeSeq}`, role: "assistant", content: "PONG", streaming: false };
      if (isCancelled?.()) {
        landFakeReply(messages, reply);
        throw codedError("cancelled", "cancelled");
      }
      messages.push(reply);
      onDelta?.("PO");
      onDelta?.("NG");
      return { chatId: id, messageId: reply.id, text: "PONG" };
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
  const restored = { id: sessionId, accountId: saved.accountId ?? null, museChatId: saved.museChatId ?? null, cancelled: false, pendingReply: null };
  sessions.set(sessionId, restored);
  return restored;
}

function modelsBlock() {
  return {
    currentModelId: MUSE_MODEL_ID,
    availableModels: [{ modelId: MUSE_MODEL_ID, name: MUSE_MODEL_NAME }],
  };
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

async function streamPendingReply(session, driver, pending) {
  if (!pending.chatId || typeof driver.history !== "function") return;
  try {
    const full = await waitForPendingReply(driver.history, pending.chatId, { timeoutMs: PENDING_WAIT_MS, pollMs: 500 });
    const rest = full.startsWith(pending.deliveredPrefix) ? full.slice(pending.deliveredPrefix.length) : full;
    if (!rest) return;
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${rest}\n\n` } });
  } catch {
    // A failed history read must not block the new prompt.
  }
}

async function runPrompt(session, params) {
  session.cancelled = false;
  const text = promptText(params.prompt);
  if (!text) {
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing to send to Muse: the message held only BB system instructions." } });
    return { stopReason: "end_turn" };
  }
  let sendStarted = false;
  let streamed = "";
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
        if (session.pendingReply) {
          const pending = session.pendingReply;
          session.pendingReply = null;
          await streamPendingReply(session, driver, pending);
        }
        sendStarted = true;
        const result = await driver.send({
          chatId: session.museChatId || undefined,
          text,
          timeoutMs: REPLY_TIMEOUT_MS,
          isCancelled: () => session.cancelled,
          onChatId: (id) => {
            session.museChatId = id;
            saveSession(session);
          },
          onDelta: (suffix) => {
            if (!suffix) return;
            streamed += suffix;
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
    if (err?.code === "cancelled" || session.cancelled) {
      if (sendStarted && session.museChatId) {
        session.pendingReply = { chatId: session.museChatId, deliveredPrefix: streamed };
      }
      return { stopReason: "cancelled" };
    }
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
      const session = { id: `muse-${randomUUID()}`, accountId: null, museChatId: null, cancelled: false, pendingReply: null };
      sessions.set(session.id, session);
      saveSession(session);
      return { sessionId: session.id, models: modelsBlock() };
    }
    case "session/set_model": {
      getSession(params.sessionId);
      if (params.modelId !== MUSE_MODEL_ID) throw codedError(-32602, `unknown model: ${params.modelId}`);
      return {};
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

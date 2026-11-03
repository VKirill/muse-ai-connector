#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { acquire, listAccounts, pickAccount, setStatus, touch } from "../bridge/accounts.mjs";
import { waitForAssistantMessage, waitForPendingReply } from "../bridge/acp-pending.mjs";
import { collectPrompt, extractBbContext } from "../bridge/acp-prompt.mjs";
import { buildMcpIndex, callMcpTool, describeMcpTool, startMcpServers } from "../bridge/acp-mcp.mjs";
import { buildIntro, cap, MAX_TOOL_CALLS, MESSAGE_CAP, OUTPUT_CAP, parseToolCalls, resultMessage, runTool, stripDoneMarker, toolKind, toolTitle } from "../bridge/acp-tools.mjs";
import { readJson, updateJson } from "../bridge/json-file.mjs";
import { bridgeHome } from "../bridge/paths.mjs";
import { extractImages, imagePrompt, parseLeadingFormat, saveImages } from "../bridge/images.mjs";
import { createMuseClient, resolveTransport } from "../bridge/protocol/api.mjs";

const FAKE = process.env.MUSE_BRIDGE_FAKE === "1";
const FAKE_DELAY_MS = Math.max(0, Number(process.env.MUSE_BRIDGE_FAKE_DELAY_MS || 0));
const FAKE_REPLY_LAG_MS = Math.max(0, Number(process.env.MUSE_BRIDGE_FAKE_REPLY_LAG_MS || 0));
const LOCK_WAIT_MS = 5 * 60_000;
const HEADLESS = process.env.MUSE_HEADLESS !== "0" && process.env.MUSE_HEADLESS !== "false";
const REPLY_TIMEOUT_MS = Math.max(1, Number(process.env.MUSE_REPLY_TIMEOUT_SEC || 180)) * 1000;
const PENDING_WAIT_MS = Math.max(0, Number(process.env.MUSE_PENDING_WAIT_MS || 30_000));
const MAX_TOOL_ROUNDS = Math.max(1, Number(process.env.MUSE_MAX_TOOL_ROUNDS || 60));
const MAX_BLOCKLESS_REPLIES = 3;
const NUDGE_MESSAGE =
  "Your last reply had no ```muse-tool block. muse-tool is not one of your tools — it is a fenced text block you write at the end of your reply; the BB bridge on the user's machine runs it and answers in the next message. Your own tools (muse.exec, muse.read, …) run on your cloud VM, which cannot see this workspace — nothing happened, and web results from your browser.* tools reach the user only through a muse-tool write_file block. To act, end your reply with ```muse-tool blocks (up to 8). If you are finished, repeat your final answer ending with [[done]].";
const BLOCKLESS_STOP_MESSAGE = "RetriableError: [muse_no_tool] Muse stopped without using a tool";
const RETRY_DELAYS_MS = (process.env.MUSE_RETRY_DELAYS_MS ?? "10000,30000,60000")
  .split(",")
  .map((v) => Math.max(0, Number(v) || 0));

function isAuthError(err) {
  return err?.code === "auth_failed" || err?.code === "missing_cookies" || err?.code === "no_signed_in_account" || err?.status === 401 || err?.status === 403;
}

function shortCause(err) {
  let m = String(err?.message || err);
  if (/Unexpected token|not valid JSON/i.test(m)) m = `non-JSON response from Muse${err?.status ? ` (HTTP ${err.status})` : ""}`;
  else if (err?.status) m = `HTTP ${err.status}: ${m}`;
  return m.slice(0, 150);
}

/** Retries driver.send on transport/service faults (5xx, non-JSON, socket, timeout). */
async function sendWithRetry(session, driver, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await driver.send(params);
    } catch (err) {
      if (err?.code === "cancelled" || isAuthError(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
      if (session.cancelled) throw codedError("cancelled", "cancelled");
    }
  }
}
const EMPTY_REPLY_POLL_MS = 3_000;
const WORKING_THOUGHT_MESSAGE = "Muse is working with its own tools…";
const STILL_WORKING_MESSAGE = "Muse is still working on its side; ask it to continue";
const CLIENT_REQUEST_TIMEOUT_MS = 60_000;
const DUMP_PROMPT_FILE = process.env.MUSE_ACP_DUMP_PROMPT || "";
const MUSE_MODEL_ID = "muse-spark";
const MUSE_IMAGE_MODEL_ID = "muse-image";
const AVAILABLE_MODELS = [
  { modelId: MUSE_MODEL_ID, name: "Muse Spark" },
  { modelId: MUSE_IMAGE_MODEL_ID, name: "Muse Image" },
];

let clientCapabilities = {};
let toolCallSeq = 0;

/** @type {Map<string, { id: string, accountId: string | null, museChatId: string | null, cwd: string, modelId: string, cancelled: boolean, pendingReply: { chatId: string, deliveredPrefix: string } | null }>} */
const sessions = new Map();

/** @type {Map<string|number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
const clientPending = new Map();
let clientReqSeq = 0;

function clientRequest(method, params) {
  const id = `muse-acp-${++clientReqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (clientPending.delete(id)) reject(codedError("client_request_timeout", `${method}: no response from the client`));
    }, CLIENT_REQUEST_TIMEOUT_MS);
    timer.unref();
    clientPending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    send({ id, method, params });
  });
}

function sessionsPath() {
  return path.join(bridgeHome(), "sessions.json");
}

export function loadStore() {
  return readJson(sessionsPath(), {});
}

export function saveSession(session) {
  updateJson(sessionsPath(), {}, (store) => {
    const next = store && typeof store === "object" ? store : {};
    next[session.id] = {
      accountId: session.accountId,
      museChatId: session.museChatId,
      cwd: session.cwd,
      modelId: session.modelId ?? MUSE_MODEL_ID,
    };
    return next;
  });
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

const fakeChats = new Map();
let fakeSeq = 0;
let fakeScript = null;
let fakeScriptIdx = 0;

function fakeNextReply() {
  if (fakeScript === null) {
    fakeScript = [];
    const file = process.env.MUSE_BRIDGE_FAKE_SCRIPT;
    if (file) {
      try {
        const arr = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(arr)) fakeScript = arr.map((v) => (Array.isArray(v) ? v.map(String) : String(v)));
      } catch (err) {
        process.stderr.write(`MUSE_BRIDGE_FAKE_SCRIPT unreadable: ${err?.message || err}\n`);
      }
    }
  }
  const reply = fakeScript[fakeScriptIdx];
  if (reply !== undefined) {
    fakeScriptIdx++;
    return reply;
  }
  return "PONG\n[[done]]";
}

function dumpSent(text) {
  if (!DUMP_PROMPT_FILE) return;
  const bytes = Buffer.byteLength(text);
  process.stderr.write(`sent ${bytes} bytes\n`);
  try {
    fs.appendFileSync(DUMP_PROMPT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), bytes, text })}\n`);
  } catch {
    /* best effort */
  }
}

function fakeLogSent(text, attachments) {
  const file = process.env.MUSE_BRIDGE_FAKE_SENT;
  if (!file) return;
  const rec = { text };
  if (attachments?.length) {
    rec.attachments = attachments.map((a) => ({
      type: a.type,
      mime_type: a.mime_type,
      filename: a.filename,
      bytes: Buffer.from(a.data_base64 ?? "", "base64").length,
    }));
  }
  try {
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  } catch {
    /* best effort */
  }
}

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
    async send({ chatId, text, attachments, onDelta, onChatId, isCancelled }) {
      const id = chatId ?? `fake-muse-chat-${++fakeSeq}`;
      let messages = fakeChats.get(id);
      if (!messages) fakeChats.set(id, (messages = []));
      onChatId?.(id);
      messages.push({ id: `fake-user-${++fakeSeq}`, role: "user", content: text, streaming: false });
      fakeLogSent(text, attachments);
      await sleep(FAKE_DELAY_MS);
      const turn = fakeNextReply();
      const parts = Array.isArray(turn) ? turn : [turn];
      const replyText = parts[0] ?? "";
      if (replyText.startsWith("@@error ")) {
        const err = new Error(replyText.slice(8));
        err.code = "service_error";
        throw err;
      }
      const reply = { id: `fake-assistant-${++fakeSeq}`, role: "assistant", content: replyText, streaming: false };
      if (isCancelled?.()) {
        landFakeReply(messages, reply);
        throw codedError("cancelled", "cancelled");
      }
      messages.push(reply);
      parts.slice(1).forEach((content, i) => {
        setTimeout(() => {
          messages.push({ id: `fake-assistant-${++fakeSeq}`, role: "assistant", content, streaming: false });
        }, 200 * (i + 1)).unref();
      });
      onDelta?.(replyText);
      const mediaPath = "workspace/imagine_media/fake.webp";
      const history = {
        result: {
          chat_events: [
            { event_name: "message.user", seq: 1, display_text: text, payload: { content: text } },
            { event_name: "message.assistant", seq: 2, display_text: replyText, payload: { content: replyText } },
            {
              event_name: "delta.presentation",
              seq: 3,
              display_text: "Fake image",
              payload: {
                kind: "image",
                image_path: mediaPath,
                data: {
                  images: [
                    {
                      path: `sandbox://${mediaPath}`,
                      mime: "image/webp",
                      width: 64,
                      height: 36,
                      label: "Fake image",
                      byte_len: 8,
                    },
                  ],
                },
              },
            },
          ],
        },
      };
      return { chatId: id, messageId: reply.id, text: replyText, chatEventSeq: 0, history };
    },
    async fetchMedia() {
      return Buffer.from("WEBPFAKE");
    },
    close: async () => {},
  };
}

const apiClients = new Map();

async function openRealSession(opts) {
  const { openSession } = await import("../bridge/session.mjs");
  return openSession(opts);
}

async function openRealDriver(accountId) {
  const transport = resolveTransport({ env: process.env });
  if (transport === "browser") {
    return { driver: await openRealSession({ accountId, headless: HEADLESS }), ephemeral: true };
  }
  const cached = apiClients.get(accountId);
  if (cached) return { driver: cached, ephemeral: false };
  try {
    const client = await createMuseClient({ accountId });
    apiClients.set(accountId, client);
    return { driver: client, ephemeral: false };
  } catch (err) {
    if (err?.code !== "missing_cookies" && err?.code !== "auth_failed") throw err;
    process.stderr.write("API transport unavailable; falling back to browser\n");
    if (err.code === "auth_failed") {
      try {
        setStatus(accountId, "signed_out");
      } catch {
        /* unregistered */
      }
    }
    return { driver: await openRealSession({ accountId, headless: HEADLESS }), ephemeral: true };
  }
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) return session;
  const saved = loadStore()[sessionId];
  if (!saved) throw codedError(-32602, `unknown session: ${sessionId}`);
  const restored = {
    id: sessionId,
    accountId: saved.accountId ?? null,
    museChatId: saved.museChatId ?? null,
    cwd: saved.cwd ?? process.cwd(),
    modelId: saved.modelId ?? MUSE_MODEL_ID,
    cancelled: false,
    pendingReply: null,
    mcp: [],
  };
  sessions.set(sessionId, restored);
  return restored;
}

function modelsBlock(session) {
  return {
    currentModelId: session?.modelId ?? MUSE_MODEL_ID,
    availableModels: AVAILABLE_MODELS,
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
    const cleaned = rest.replace(/```muse-tool[ \t]*\r?\n?[\s\S]*?```/g, "");
    const visible = (stripDoneMarker(cleaned) ?? cleaned).trim();
    if (!visible) return;
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${visible}\n\n` } });
  } catch {
    // A failed history read must not block the new prompt.
  }
}

async function runImageTurn(session, driver, text, attachments) {
  const parsed = parseLeadingFormat(text);
  const toSend =
    !session.museChatId || parsed.format ? imagePrompt(parsed.text, parsed.format || undefined) : text;
  dumpSent(toSend);
  const result = await sendWithRetry(session, driver, {
    chatId: session.museChatId || undefined,
    text: toSend,
    attachments,
    timeoutMs: REPLY_TIMEOUT_MS,
    isCancelled: () => session.cancelled,
    onChatId: (id) => {
      session.museChatId = id;
      saveSession(session);
    },
  });
  session.museChatId = result.chatId;
  saveSession(session);
  if (session.cancelled) return { stopReason: "cancelled" };
  const hist =
    result.history ?? (typeof driver.historyRaw === "function" ? await driver.historyRaw(result.chatId) : null);
  const images = hist ? extractImages(hist, { sinceSeq: result.chatEventSeq ?? 0 }) : [];
  const dir = path.join(session.cwd || process.cwd(), "muse-images");
  let saved = [];
  if (images.length) {
    if (typeof driver.fetchMedia !== "function") {
      update(session.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Image mode needs the API transport." },
      });
      return { stopReason: "end_turn" };
    }
    saved = await saveImages(driver, images, dir);
  }
  if (result.text) {
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.text } });
  }
  for (const file of saved) {
    const rel = path.relative(session.cwd || process.cwd(), file.path) || file.path;
    const alt = String(file.label || path.basename(rel)).replace(/]/g, "");
    update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `\n![${alt}](${rel})` },
    });
  }
  if (!saved.length && !result.text) {
    update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Muse answered without a picture" },
    });
  }
  return { stopReason: "end_turn" };
}

async function runPrompt(session, params) {
  session.cancelled = false;
  const collected = collectPrompt(params.prompt);
  const text = collected.text;
  const attachments = collected.attachments;
  const bbContext = extractBbContext(params.prompt);
  if (!text && !attachments.length) {
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing to send to Muse: the message held only BB system instructions." } });
    return { stopReason: "end_turn" };
  }
  let sendInFlight = false;
  let streamed = "";
  try {
    if (!session.accountId) {
      try {
        session.accountId = pickAccount().id;
      } catch (err) {
        if (!(FAKE && err?.code === "no_signed_in_account")) throw err;
        session.accountId = "fake";
      }
      saveSession(session);
    }
    const release = await waitForLock(session.accountId, session);
    try {
      if (session.cancelled) return { stopReason: "cancelled" };
      if (listAccounts().some((a) => a.id === session.accountId)) touch(session.accountId);
      const opened = FAKE
        ? { driver: await openFakeSession({ accountId: session.accountId, headless: HEADLESS }), ephemeral: true }
        : await openRealDriver(session.accountId);
      const driver = opened.driver;
      try {
        const knownAccount = listAccounts().some((a) => a.id === session.accountId);
        const signedIn = await driver.isSignedIn();
        if (!signedIn) {
          if (knownAccount) setStatus(session.accountId, "signed_out");
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `NonRetriableError: muse signed out: ${session.accountId}` } });
          return { stopReason: "end_turn" };
        }
        if (knownAccount) setStatus(session.accountId, "signed_in");
        if (session.pendingReply) {
          const pending = session.pendingReply;
          session.pendingReply = null;
          await streamPendingReply(session, driver, pending);
        }
        if (session.modelId === MUSE_IMAGE_MODEL_ID) {
          return await runImageTurn(session, driver, text, attachments);
        }
        const fsCaps = clientCapabilities?.fs ?? {};
        const mcpIndex = buildMcpIndex(session.mcp);
        const ctx = {
          cwd: session.cwd || process.cwd(),
          sessionId: session.id,
          fsRead: !!fsCaps.readTextFile,
          fsWrite: !!fsCaps.writeTextFile,
          clientRequest,
          callMcp: (name, args) => callMcpTool(mcpIndex, name, args),
          describeMcp: (name) => describeMcpTool(mcpIndex, name),
        };
        const contextSection =
          bbContext && bbContext !== session.lastBbContext ? `Project and owner rules (from BB):\n${bbContext}\n\n` : "";
        let toSend = session.museChatId
          ? `${contextSection}${text}`
          : `${buildIntro(ctx.cwd, [...mcpIndex.keys()])}\n\n${contextSection}${text}`;
        session.lastBbContext = bbContext;
        let rounds = 0;
        let blockless = 0;
        for (;;) {
          if (session.cancelled) return { stopReason: "cancelled" };
          sendInFlight = true;
          dumpSent(toSend);
          const result = await sendWithRetry(session, driver, {
            chatId: session.museChatId || undefined,
            text: toSend,
            attachments: rounds === 0 ? attachments : undefined,
            timeoutMs: REPLY_TIMEOUT_MS,
            isCancelled: () => session.cancelled,
            onChatId: (id) => {
              session.museChatId = id;
              saveSession(session);
            },
          });
          sendInFlight = false;
          session.museChatId = result.chatId;
          saveSession(session);
          let replyText = String(result.text ?? "");
          if (!replyText.trim() && typeof driver.history === "function") {
            update(session.id, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: WORKING_THOUGHT_MESSAGE },
            });
            replyText = await waitForAssistantMessage(driver.history, result.chatId, {
              timeoutMs: REPLY_TIMEOUT_MS,
              pollMs: EMPTY_REPLY_POLL_MS,
              isCancelled: () => session.cancelled,
            });
            if (session.cancelled) return { stopReason: "cancelled" };
            if (!replyText.trim()) {
              update(session.id, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: STILL_WORKING_MESSAGE },
              });
              return { stopReason: "end_turn" };
            }
          }
          const parsed = parseToolCalls(replyText);
          if (parsed.kind === "none") {
            const done = stripDoneMarker(parsed.text);
            if (done === null) {
              blockless += 1;
              if (blockless <= MAX_BLOCKLESS_REPLIES) {
                update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: parsed.text } });
                rounds += 1;
                if (rounds >= MAX_TOOL_ROUNDS) {
                  update(session.id, {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Stopped: Muse hit the tool round limit (MUSE_MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS}).` },
                  });
                  return { stopReason: "end_turn" };
                }
                toSend = NUDGE_MESSAGE;
                continue;
              }
              update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: parsed.text } });
              update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: BLOCKLESS_STOP_MESSAGE } });
              return { stopReason: "end_turn" };
            }
            streamed += done;
            update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: done } });
            return { stopReason: "end_turn" };
          }
          blockless = 0;
          const thought = stripDoneMarker(parsed.thought) ?? parsed.thought;
          if (thought) {
            update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought } });
          }
          const sections = [];
          for (const call of parsed.calls) {
            const toolCallId = `muse-tool-${++toolCallSeq}`;
            update(session.id, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: toolTitle(call.name, call.args),
              kind: toolKind(call.name),
              status: "in_progress",
              rawInput: call.args,
            });
            const res = call.kind === "call" ? await runTool(call.name, call.args, ctx) : { ok: false, output: call.error };
            update(session.id, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: res.ok ? "completed" : "failed",
              content: [{ type: "content", content: { type: "text", text: res.output.slice(0, OUTPUT_CAP) } }],
            });
            sections.push(resultMessage(call.name, res.ok, res.output, sections.length + 1, parsed.calls.length));
            if (session.cancelled) return { stopReason: "cancelled" };
          }
          if (parsed.dropped) {
            sections.push(`${parsed.dropped} more muse-tool block(s) were dropped: at most ${MAX_TOOL_CALLS} run per reply.`);
          }
          rounds += 1;
          if (rounds >= MAX_TOOL_ROUNDS) {
            update(session.id, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Stopped: Muse hit the tool round limit (MUSE_MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS}).` },
            });
            return { stopReason: "end_turn" };
          }
          toSend = cap(sections.join("\n\n"), MESSAGE_CAP);
        }
      } finally {
        if (opened.ephemeral) await driver.close();
      }
    } finally {
      release();
    }
  } catch (err) {
    if (err?.code === "auth_failed" && session.accountId) {
      try {
        setStatus(session.accountId, "signed_out");
      } catch {
        /* unregistered */
      }
    }
    if (err?.code === "cancelled" || session.cancelled) {
      if (sendInFlight && session.museChatId) {
        session.pendingReply = { chatId: session.museChatId, deliveredPrefix: streamed };
      }
      return { stopReason: "cancelled" };
    }
    const faultText = isAuthError(err)
      ? `NonRetriableError: muse signed out: ${session.accountId}`
      : `RetriableError: [muse_unavailable] ${shortCause(err)}`;
    update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: faultText } });
    return { stopReason: "end_turn" };
  }
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      clientCapabilities = params?.clientCapabilities ?? {};
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
        },
        agentInfo: { name: "muse-acp" },
        authMethods: [],
      };
    case "session/new": {
      const session = {
        id: `muse-${randomUUID()}`,
        accountId: null,
        museChatId: null,
        cwd: typeof params?.cwd === "string" && params.cwd ? params.cwd : process.cwd(),
        modelId: MUSE_MODEL_ID,
        cancelled: false,
        pendingReply: null,
        mcp: [],
      };
      sessions.set(session.id, session);
      saveSession(session);
      session.mcp = await startMcpServers(params?.mcpServers);
      return { sessionId: session.id, models: modelsBlock(session) };
    }
    case "session/set_model": {
      const session = getSession(params.sessionId);
      if (params.modelId !== MUSE_MODEL_ID && params.modelId !== MUSE_IMAGE_MODEL_ID) {
        throw codedError(-32602, `unknown model: ${params.modelId}`);
      }
      session.modelId = params.modelId;
      saveSession(session);
      return {};
    }
    case "session/prompt":
      return runPrompt(getSession(params.sessionId), params);
    case "session/close": {
      const session = sessions.get(params.sessionId);
      sessions.delete(params.sessionId);
      for (const c of session?.mcp ?? []) c.close?.();
      return {};
    }
    default:
      throw codedError(-32601, `method not found: ${method}`);
  }
}

function closeAllMcp() {
  for (const session of sessions.values()) {
    for (const c of session.mcp ?? []) c.close?.();
  }
}
process.on("exit", closeAllMcp);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    closeAllMcp();
    process.exit(0);
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) {
    const p = msg.id !== undefined ? clientPending.get(msg.id) : undefined;
    if (p) {
      clientPending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result ?? {});
    }
    return;
  }
  if (msg.method === "session/cancel") {
    const session = sessions.get(msg.params?.sessionId);
    if (session) session.cancelled = true;
    return;
  }
  if (msg.id === undefined) return;
  handle(msg.method, msg.params || {}).then(
    (result) => send({ id: msg.id, result: result ?? {} }),
    (err) => send({ id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message || err) } }),
  );
});

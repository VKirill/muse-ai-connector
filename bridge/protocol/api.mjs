import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setStatus } from "../accounts.mjs";
import { loadCookies, nodeIdPath } from "../cookies.mjs";
import { connectGateway } from "./gateway.mjs";

const CAPABILITIES = [
  "hotel_results",
  "chat_cancel",
  "delta_stream",
  "custom_reactions",
  "custom_reactions_facebook_thumbs_up_v1",
];

const SUBSCRIBE_CAPABILITIES = [...CAPABILITIES, "voice_reply_captions", "voice_user_live_transcript"];

function replyTimeoutError() {
  const err = new Error("Timed out waiting for Muse reply");
  err.code = "reply_timeout";
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function loadOrCreateNodeId(accountId) {
  const file = nodeIdPath(accountId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.node_id) return parsed.node_id;
  } catch {
    /* create */
  }
  const nodeId = randomUUID();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, `${JSON.stringify({ node_id: nodeId })}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return nodeId;
}

/**
 * @param {{ text: string, sessionId: string, nodeId: string, timezone?: string, attachments?: object[] }} opts
 */
export function chatStreamBody({ text, sessionId, nodeId, timezone, attachments } = {}) {
  const base = {
    node_id: nodeId,
    capabilities: CAPABILITIES,
    session_id: sessionId,
    timezone: timezone ?? "UTC",
    metadata: { thread_is_dictation_used: false },
  };
  if (Array.isArray(attachments) && attachments.length) {
    return { ...base, items: [...attachments, { type: "text", text }] };
  }
  return { ...base, message: text };
}

/**
 * @param {{ flag?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveTransport({ flag, env } = {}) {
  const value = flag || env?.MUSE_TRANSPORT;
  return value === "browser" ? "browser" : "api";
}

function eventName(event) {
  return String(event?.event ?? event?.event_name ?? event?.type ?? "");
}

function eventPayload(event) {
  return event?.payload && typeof event.payload === "object" ? event.payload : event ?? {};
}

function extractDelta(event) {
  const name = eventName(event);
  const payload = eventPayload(event);
  if (!/delta/i.test(name) && payload.delta == null) return null;
  const text = payload.delta ?? payload.text ?? payload.content ?? payload.display_text;
  return typeof text === "string" && text.length ? text : null;
}

function historyMessages(chatId, payload) {
  const events = payload?.result?.chat_events ?? payload?.chat_events ?? [];
  const messages = [];
  for (const event of events) {
    const name = String(event.event_name ?? event.event ?? "");
    const role = name.includes("user") ? "user" : name.includes("message") || name.includes("assistant") ? "assistant" : null;
    if (!role) continue;
    messages.push({
      id: event.message_id ?? event.id,
      role,
      content: event.display_text ?? event.payload?.content ?? event.payload?.text ?? "",
      streaming: false,
      createdAt: event.occurred_at_ms ? new Date(event.occurred_at_ms).toISOString() : null,
      model: null,
    });
  }
  for (const message of payload?.result?.messages ?? payload?.messages ?? []) {
    if (!message?.role) continue;
    messages.push({
      id: message.message_id ?? message.id,
      role: message.role,
      content: message.display_text ?? message.content ?? message.text ?? "",
      streaming: false,
      createdAt: message.occurred_at_ms ? new Date(message.occurred_at_ms).toISOString() : null,
      model: message.model ?? null,
    });
  }
  return { chatId, revision: null, hasMore: false, messages };
}

function maxEventSeq(payload) {
  let max = 0;
  for (const event of payload?.result?.chat_events ?? payload?.chat_events ?? []) {
    const seq = Number(event?.seq ?? event?.chat_event_seq ?? event?.payload?.chat_event_seq ?? 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

function mediaRequestPath(mediaPath) {
  const clean = String(mediaPath ?? "").replace(/^sandbox:\/\//, "").replace(/^\/+/, "");
  return `/media/raw/${clean}`;
}

function mapSessions(payload) {
  const sessions = payload?.result?.sessions ?? payload?.sessions ?? [];
  return sessions
    .map((s) => ({
      id: s.session_id ?? s.id,
      title: s.title,
      snippet: s.snippet,
      updatedAt: s.updated_at_ms ?? s.updated_at,
      createdAt: s.created_at_ms ?? s.created_at,
      archived: s.archived,
      pinned: s.pinned,
      status: s.status,
    }))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

async function registerNode(gateway, nodeId) {
  await gateway.request({
    method: "POST",
    path: "/api/nodes/register",
    body: {
      node_id: nodeId,
      display_name: `BB (${process.platform})`,
      platform: process.platform === "darwin" ? "macos" : process.platform,
      commands_v2: { ping: { description: "Connection liveness check" } },
    },
  });
}

/**
 * @param {{ accountId: string, gateway?: object, connect?: typeof connectGateway }} opts
 */
export async function createMuseClient({ accountId, gateway, connect = connectGateway } = {}) {
  const cookies = loadCookies(accountId);
  const nodeId = loadOrCreateNodeId(accountId);
  const gw = gateway ?? (await connect({ cookies, accountId }));
  await registerNode(gw, nodeId);

  async function isSignedIn() {
    try {
      const res = await gw.request({ method: "POST", path: "/api/ping", body: { presence: "active" } });
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      if (err?.code === "auth_failed") return false;
      throw err;
    }
  }

  async function listChats() {
    const res = await gw.request({ method: "GET", path: "/api/session/list?include_peer_sidechats=true" });
    return mapSessions(await res.json());
  }

  async function historyRaw(chatId) {
    const res = await gw.request({
      method: "GET",
      path: `/chat/history?limit=40&transcript_mode=messages&session_id=${encodeURIComponent(chatId)}`,
    });
    return res.json();
  }

  async function history(chatId) {
    return historyMessages(chatId, await historyRaw(chatId));
  }

  async function fetchMedia(mediaPath) {
    const res = await gw.request({ method: "GET", path: mediaRequestPath(mediaPath) });
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`Muse media fetch failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.bytes();
  }

  async function send({ chatId, text, attachments, onDelta, onChatId, timeoutMs = 180_000, isCancelled } = {}) {
    const sessionId = chatId ?? randomUUID();
    let startSeq = 0;
    if (chatId) {
      try {
        startSeq = maxEventSeq(await historyRaw(chatId));
      } catch {
        startSeq = 0;
      }
    }
    onChatId?.(sessionId);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const opened = await gw.request({
      method: "POST",
      path: "/chat/stream",
      body: chatStreamBody({ text, sessionId, nodeId, timezone, attachments }),
    });
    const openedJson = (await opened.json()) ?? {};
    const resolvedChatId = openedJson.session_id ?? sessionId;
    onChatId?.(resolvedChatId);

    let sawTaskDone = false;
    let sawAgentIdle = false;
    let lastStreamSeq = 0;
    let lastChatEventSeq = 0;
    const seenDeltaSeqs = new Set();
    let finishedEarly;
    const early = new Promise((resolve) => {
      finishedEarly = resolve;
    });
    const deadline = Date.now() + timeoutMs;
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(replyTimeoutError()), timeoutMs);
      timer.unref?.();
    });
    let backoff = 1_000;

    function maybeFinish() {
      if (sawTaskDone && sawAgentIdle) finishedEarly();
    }

    function onSubEvent(event) {
      if (isCancelled?.()) return;
      const streamSeq = event?.seq ?? event?.stream_seq ?? event?.payload?.stream_seq;
      if (Number.isFinite(streamSeq) && streamSeq > lastStreamSeq) lastStreamSeq = streamSeq;
      const chatSeq = event?.chat_event_seq ?? event?.payload?.chat_event_seq;
      if (Number.isFinite(chatSeq) && chatSeq > lastChatEventSeq) lastChatEventSeq = chatSeq;
      const name = eventName(event);
      const payload = eventPayload(event);
      if (name === "task.status") {
        if (payload.status && payload.status !== "running") sawTaskDone = true;
        maybeFinish();
      }
      if (name === "agent.status") {
        if (payload.activity_code !== "working") sawAgentIdle = true;
        maybeFinish();
      }
      const delta = extractDelta(event);
      if (!delta) return;
      if (Number.isFinite(streamSeq)) {
        if (seenDeltaSeqs.has(streamSeq)) return;
        seenDeltaSeqs.add(streamSeq);
      }
      onDelta?.(delta);
    }

    function subscribe() {
      return gw.stream(
        {
          method: "POST",
          path: "/chat/subscribe",
          body: {
            after_stream_seq: lastStreamSeq,
            after_chat_event_seq: lastChatEventSeq,
            capabilities: SUBSCRIBE_CAPABILITIES,
            session_id: resolvedChatId,
          },
        },
        onSubEvent,
      );
    }

    async function resubscribe() {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw replyTimeoutError();
        try {
          const next = await Promise.race([subscribe(), timeout]);
          next.finished?.catch(() => {});
          return next;
        } catch (err) {
          if (err?.code === "auth_failed" || err?.code === "reply_timeout") throw err;
        }
        await sleep(Math.min(backoff, deadline - Date.now()));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }

    let sub = await resubscribe();
    try {
      for (;;) {
        if (isCancelled?.()) {
          const err = new Error("cancelled");
          err.code = "cancelled";
          throw err;
        }
        const outcome = await Promise.race([
          early.then(() => "done"),
          sub.finished.then(() => "ended", (err) => err),
          timeout.catch((err) => err),
        ]);
        if (outcome === "done") break;
        if (outcome?.code === "reply_timeout" || outcome?.code === "auth_failed") throw outcome;
        sub.stop?.();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw replyTimeoutError();
        await sleep(Math.min(backoff, remaining));
        backoff = Math.min(backoff * 2, 30_000);
        sub = await resubscribe();
      }
    } finally {
      sub?.stop?.();
    }

    if (isCancelled?.()) {
      const err = new Error("cancelled");
      err.code = "cancelled";
      throw err;
    }

    const raw = await historyRaw(resolvedChatId);
    const parsed = historyMessages(resolvedChatId, raw);
    let assistant = null;
    for (let i = parsed.messages.length - 1; i >= 0; i--) {
      if (parsed.messages[i].role === "assistant") {
        assistant = parsed.messages[i];
        break;
      }
    }
    return {
      chatId: resolvedChatId,
      messageId: assistant?.id ?? openedJson.message_id ?? null,
      text: assistant?.content ?? "",
      chatEventSeq: startSeq,
      history: raw,
    };
  }

  async function close() {
    await gw.close?.();
  }

  return { isSignedIn, listChats, history, historyRaw, fetchMedia, send, close };
}

function shouldFallback(err) {
  return err?.code === "missing_cookies" || err?.code === "auth_failed" || err?.status === 401 || err?.status === 403;
}

/**
 * @param {{
 *   accountId: string,
 *   transport?: string,
 *   env?: NodeJS.ProcessEnv,
 *   drivers?: { createMuseClient?: Function, openSession?: Function },
 * }} opts
 */
export async function openTransport({ accountId, transport, env = process.env, drivers = {} } = {}) {
  const resolved = resolveTransport({ flag: transport, env });
  const openBrowser =
    drivers.openSession ??
    (async (opts) => {
      const { openSession } = await import("../session.mjs");
      return openSession(opts);
    });
  const openApi = drivers.createMuseClient ?? createMuseClient;
  if (resolved === "browser") {
    return openBrowser({ accountId });
  }
  try {
    return await openApi({ accountId });
  } catch (err) {
    if (!shouldFallback(err)) throw err;
    process.stderr.write("API transport unavailable; falling back to browser\n");
    if (err?.code === "auth_failed" || err?.status === 401 || err?.status === 403) {
      try {
        setStatus(accountId, "signed_out");
      } catch {
        /* unregistered */
      }
    }
    return openBrowser({ accountId });
  }
}

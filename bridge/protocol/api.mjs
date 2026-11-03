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
 * @param {{ text: string, sessionId: string, nodeId: string, timezone?: string }} opts
 */
export function chatStreamBody({ text, sessionId, nodeId, timezone }) {
  return {
    message: text,
    node_id: nodeId,
    capabilities: CAPABILITIES,
    session_id: sessionId,
    timezone: timezone ?? "UTC",
    metadata: { thread_is_dictation_used: false },
  };
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
  return { chatId, revision: null, hasMore: false, messages };
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

  async function history(chatId) {
    const res = await gw.request({
      method: "GET",
      path: `/chat/history?limit=40&transcript_mode=messages&session_id=${encodeURIComponent(chatId)}`,
    });
    return historyMessages(chatId, await res.json());
  }

  async function send({ chatId, text, onDelta, onChatId, timeoutMs = 180_000, isCancelled } = {}) {
    const sessionId = chatId ?? randomUUID();
    onChatId?.(sessionId);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const opened = await gw.request({
      method: "POST",
      path: "/chat/stream",
      body: chatStreamBody({ text, sessionId, nodeId, timezone }),
    });
    const openedJson = (await opened.json()) ?? {};
    const resolvedChatId = openedJson.session_id ?? sessionId;
    onChatId?.(resolvedChatId);

    let sawTaskDone = false;
    let sawAgentIdle = false;
    let finishedEarly;
    const early = new Promise((resolve) => {
      finishedEarly = resolve;
    });

    function maybeFinish() {
      if (sawTaskDone && sawAgentIdle) finishedEarly();
    }

    const sub = await gw.stream(
      {
        method: "POST",
        path: "/chat/subscribe",
        body: {
          after_stream_seq: 0,
          after_chat_event_seq: 0,
          capabilities: SUBSCRIBE_CAPABILITIES,
          session_id: resolvedChatId,
        },
      },
      (event) => {
        if (isCancelled?.()) return;
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
        if (delta) onDelta?.(delta);
      },
    );

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(replyTimeoutError()), timeoutMs).unref?.();
    });

    try {
      await Promise.race([early, sub.finished, timeout]);
    } finally {
      sub.stop?.();
    }

    if (isCancelled?.()) {
      const err = new Error("cancelled");
      err.code = "cancelled";
      throw err;
    }

    const parsed = await history(resolvedChatId);
    let assistant = null;
    for (let i = parsed.messages.length - 1; i >= 0; i--) {
      if (parsed.messages[i].role === "assistant") {
        assistant = parsed.messages[i];
        break;
      }
    }
    return { chatId: resolvedChatId, messageId: assistant?.id ?? openedJson.message_id ?? null, text: assistant?.content ?? "" };
  }

  async function close() {
    await gw.close?.();
  }

  return { isSignedIn, listChats, history, send, close };
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

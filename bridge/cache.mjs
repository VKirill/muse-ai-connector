/**
 * @typedef {{
 *   id: string,
 *   role: string,
 *   content: string,
 *   streaming: boolean,
 *   createdAt: string | null,
 *   model: string | null,
 * }} CacheMessage
 */

/**
 * @param {Record<string, unknown>} record
 * @returns {{ chatId: string | null, revision: unknown, hasMore: boolean, messages: CacheMessage[] }}
 */
export function parseTranscript(record) {
  if (record?.schemaVersion !== 4) {
    throw new Error(`Unsupported hatch-chat-cache schemaVersion: ${record?.schemaVersion}`);
  }
  const byId = record.messagesById && typeof record.messagesById === "object" ? record.messagesById : {};
  const ids = Array.isArray(record.messageIds) ? record.messageIds : [];
  const messages = [];
  for (const id of ids) {
    const raw = byId[id];
    if (!raw || typeof raw !== "object") continue;
    const analytics = raw.analytics && typeof raw.analytics === "object" ? raw.analytics : {};
    messages.push({
      id: raw.id ?? id,
      role: raw.role ?? "",
      content: raw.content ?? "",
      streaming: !!raw.isTextStreaming,
      createdAt: raw.createdAt ?? null,
      model: analytics.finalModel ?? analytics.initialModel ?? null,
    });
  }
  return {
    chatId: record.sessionId ?? null,
    revision: record.transcriptRevision,
    hasMore: !!record.hasMore,
    messages,
  };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {Array<{
 *   id: string,
 *   title: unknown,
 *   snippet: unknown,
 *   updatedAt: unknown,
 *   createdAt: unknown,
 *   archived: unknown,
 *   pinned: unknown,
 *   status: unknown,
 * }>}
 */
export function parseChatList(record) {
  const sessions = Array.isArray(record?.sessions) ? record.sessions : [];
  const chats = sessions.map((s) => ({
    id: s.session_id,
    title: s.title,
    snippet: s.snippet,
    updatedAt: s.updated_at,
    createdAt: s.created_at,
    archived: s.archived,
    pinned: s.pinned,
    status: s.status,
  }));
  chats.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return chats;
}

/**
 * @param {CacheMessage[]} messages
 * @param {string} text
 * @param {string} [sentAfterIso]
 * @returns {CacheMessage | null}
 */
export function findUserMessage(messages, text, sentAfterIso) {
  const afterMs = sentAfterIso ? Date.parse(sentAfterIso) : NaN;
  let found = null;
  let foundMs = -Infinity;
  for (const message of messages) {
    if (message.role !== "user" || message.content !== text) continue;
    const createdMs = Date.parse(message.createdAt ?? "");
    if (Number.isFinite(afterMs) && (!Number.isFinite(createdMs) || createdMs < afterMs)) continue;
    const stamp = Number.isFinite(createdMs) ? createdMs : foundMs + 1;
    if (stamp >= foundMs) {
      found = message;
      foundMs = stamp;
    }
  }
  return found;
}

/**
 * @param {CacheMessage[]} messages
 * @param {string} userMessageId
 * @param {boolean} [busy]
 * @returns {{ state: "pending" | "streaming" | "done", text: string }}
 */
export function replyState(messages, userMessageId, busy = false) {
  let userIndex = messages.findIndex((m) => m.id === userMessageId);
  if (userIndex < 0) {
    const byText = findUserMessage(messages, userMessageId);
    if (byText) userIndex = messages.lastIndexOf(byText);
  }
  const start = userIndex < 0 ? messages.length : userIndex + 1;
  let assistant = null;
  for (let i = start; i < messages.length; i++) {
    if (messages[i].role === "user") break;
    if (messages[i].role === "assistant") assistant = messages[i];
  }
  if (!assistant) return { state: "pending", text: "" };
  const text = assistant.content ?? "";
  if (assistant.streaming || busy) return { state: "streaming", text };
  return { state: "done", text };
}

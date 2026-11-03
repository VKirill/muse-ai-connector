function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `history(chatId)` until the assistant reply that follows the last user
 * message is complete — present and not streaming. Returns the reply text, or
 * "" when no finished reply shows up before the deadline.
 *
 * @param {(chatId: string) => Promise<{ messages?: Array<{ role: string, content?: string, streaming?: boolean }> }>} history
 * @param {string} chatId
 * @param {{ timeoutMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function waitForPendingReply(history, chatId, { timeoutMs = 15_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let messages = [];
    try {
      messages = (await history(chatId))?.messages ?? [];
    } catch {
      // A failed read is retried until the deadline.
    }
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const assistant = lastUser < 0 ? null : messages.slice(lastUser + 1).filter((m) => m.role === "assistant").at(-1);
    if (assistant && !assistant.streaming && assistant.content) return assistant.content;
    if (Date.now() >= deadline) return "";
    await sleep(pollMs);
  }
}

/**
 * Polls `history(chatId)` for the next finished, non-empty assistant message
 * after the last user message. Empty assistant messages are Muse running its
 * own tools, not an answer: every newly seen message resets the idle clock and
 * the wait continues. Returns the reply text, or "" when no non-empty message
 * lands within `timeoutMs` of the last one seen.
 *
 * @param {(chatId: string) => Promise<{ messages?: Array<{ id?: string, role: string, content?: string, streaming?: boolean }> }>} history
 * @param {string} chatId
 * @param {{ timeoutMs?: number, pollMs?: number, isCancelled?: () => boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function waitForAssistantMessage(history, chatId, { timeoutMs = 180_000, pollMs = 3_000, isCancelled } = {}) {
  let signature = null;
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isCancelled?.()) return "";
    let messages = [];
    try {
      messages = (await history(chatId))?.messages ?? [];
    } catch {
      // A failed read is retried until the deadline.
    }
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const after = lastUser < 0 ? [] : messages.slice(lastUser + 1).filter((m) => m.role === "assistant");
    const last = after.at(-1);
    if (last && !last.streaming && String(last.content ?? "").trim()) return String(last.content);
    const sig = after.map((m) => `${m.id ?? ""}:${m.streaming ? 1 : 0}:${String(m.content ?? "").length}`).join("|");
    if (signature === null) {
      signature = sig;
    } else if (sig !== signature) {
      signature = sig;
      deadline = Date.now() + timeoutMs;
    }
    if (Date.now() >= deadline) return "";
    await sleep(pollMs);
  }
}

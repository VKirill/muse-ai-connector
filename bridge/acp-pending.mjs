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

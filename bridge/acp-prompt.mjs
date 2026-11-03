const SYSTEM_BLOCK_RE = /<(system_instructions|system-reminder)>[\s\S]*?<\/\1>/g;

/**
 * Joins the prompt's text blocks and removes BB's injected
 * <system_instructions>…</system_instructions> and <system-reminder>…</system-reminder>
 * sections (they may span several blocks after the join). Other markup is kept as is.
 * @param {unknown} prompt
 * @returns {string}
 */
export function promptText(prompt) {
  const joined = Array.isArray(prompt)
    ? prompt.map((block) => (typeof block?.text === "string" ? block.text : "")).join("")
    : String(prompt ?? "");
  return joined.replace(SYSTEM_BLOCK_RE, "").trim();
}

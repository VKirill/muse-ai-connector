const SYSTEM_BLOCK_RE = /<(system_instructions|system-reminder)>[\s\S]*?<\/\1>/g;
const INSTRUCTIONS_RE = /<system_instructions>([\s\S]*?)<\/system_instructions>/g;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CONTEXT_BUDGET = 16000;
const TRUNCATED = "\n…(truncated)";

const KEEP_MARKERS = [
  [/^Contents of .+\((?:project instructions|user's private global instructions)/, "project"],
  [/^Rules the owner taught in this project/, "owner"],
  [/^#{1,6}\s+Language\b/, "language"],
];
const DROP_MARKERS = [
  /^The following (?:dynamic )?instructions come from the BB plugin\b/,
  /^Available (?:bb )?skills\b/i,
  /^Memory index\b/,
];

function joinPrompt(prompt) {
  return Array.isArray(prompt)
    ? prompt.map((block) => (typeof block?.text === "string" ? block.text : "")).join("")
    : String(prompt ?? "");
}

/**
 * Joins the prompt's text blocks and removes BB's injected
 * <system_instructions>…</system_instructions> and <system-reminder>…</system-reminder>
 * sections (they may span several blocks after the join). Other markup is kept as is.
 * @param {unknown} prompt
 * @returns {string}
 */
export function promptText(prompt) {
  return joinPrompt(prompt).replace(SYSTEM_BLOCK_RE, "").trim();
}

/**
 * Extracts the parts of BB's <system_instructions> block that an agent working in
 * the project must follow: project and user instructions ("Contents of <path> (…)"),
 * the rules the owner taught in this project, and the Language section. Plugin tool
 * manuals, skills catalogues, memory indexes, reminders and the preamble are dropped.
 * Kept text is ordered project instructions → owner rules → language and capped at
 * 16000 chars, the tail cut with "…(truncated)".
 * @param {unknown} prompt
 * @returns {string} the kept context, or "" when there is nothing to keep.
 */
export function extractBbContext(prompt) {
  const joined = joinPrompt(prompt);
  const blocks = [];
  INSTRUCTIONS_RE.lastIndex = 0;
  let m;
  while ((m = INSTRUCTIONS_RE.exec(joined)) !== null) blocks.push(m[1]);
  if (!blocks.length) return "";
  const kept = { project: [], owner: [], language: [] };
  let bucket = null;
  for (const block of blocks) {
    for (const line of block.replace(REMINDER_RE, "").split("\n")) {
      const keep = KEEP_MARKERS.find(([re]) => re.test(line));
      if (keep) {
        bucket = keep[1];
        kept[bucket].push([line]);
        continue;
      }
      if (DROP_MARKERS.some((re) => re.test(line))) {
        bucket = null;
        continue;
      }
      if (bucket) kept[bucket][kept[bucket].length - 1].push(line);
    }
  }
  const text = ["project", "owner", "language"]
    .map((key) =>
      kept[key]
        .map((section) => section.join("\n").trim())
        .filter(Boolean)
        .join("\n\n"),
    )
    .filter(Boolean)
    .join("\n\n");
  if (text.length <= CONTEXT_BUDGET) return text;
  return text.slice(0, CONTEXT_BUDGET - TRUNCATED.length).trimEnd() + TRUNCATED;
}

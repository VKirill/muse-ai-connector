import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEM_BLOCK_RE = /<(system_instructions|system-reminder)>[\s\S]*?<\/\1>/g;
const INSTRUCTIONS_RE = /<system_instructions>([\s\S]*?)<\/system_instructions>/g;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CONTEXT_BUDGET = 16000;
const TRUNCATED = "\n…(truncated)";
const FILE_CHAR_CAP = 200000;
const TOTAL_CHAR_CAP = 400000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

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

function filePathFromUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function attachmentName(block, uri) {
  if (typeof block?.name === "string" && block.name) return block.name;
  const abs = filePathFromUri(uri);
  if (abs) return path.basename(abs);
  if (typeof uri === "string" && uri) {
    try {
      const base = path.basename(decodeURIComponent(new URL(uri).pathname));
      if (base) return base;
    } catch {
      const base = path.basename(uri);
      if (base) return base;
    }
  }
  return "file";
}

function typeHint(block, name, abs) {
  if (typeof block?.mimeType === "string" && block.mimeType) return block.mimeType;
  const ext = path.extname(name || abs || "").replace(/^\./, "");
  return ext || "binary";
}

function notSentLine(name, hint) {
  return `\n\n[Attached file: ${name} (${hint}, not sent)]`;
}

function sentAttachmentLine(name) {
  return `\n\n[Attached file: ${name} — sent as an attachment]`;
}

function tildeFence(content) {
  let n = 3;
  const runs = content.match(/~{3,}/g);
  if (runs) {
    for (const run of runs) n = Math.max(n, run.length + 1);
  }
  const fence = "~".repeat(n);
  return `${fence}\n${content}\n${fence}`;
}

function utf8Text(buf) {
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) return null;
  return text;
}

function inlineTextFile(name, content, budget) {
  const original = content.length;
  const keep = Math.max(0, Math.min(FILE_CHAR_CAP, budget, original));
  const body = content.slice(0, keep);
  const trunc = keep < original ? `\n…(file truncated: ${keep} of ${original} characters)` : "";
  return { text: `\n\n[Attached file: ${name}]\n${tildeFence(body)}${trunc}`, used: keep };
}

function inlineResourceLink(block, budget) {
  const uri = block?.uri;
  const name = attachmentName(block, uri);
  const abs = filePathFromUri(uri);
  if (!abs) return { text: notSentLine(name, typeHint(block, name, "")), used: 0 };
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { text: notSentLine(name, typeHint(block, name, abs)), used: 0 };
  }
  const content = utf8Text(buf);
  if (content === null) return { text: notSentLine(name, typeHint(block, name, abs)), used: 0 };
  return inlineTextFile(name, content, budget);
}

function inlineEmbeddedResource(block, budget) {
  const res = block?.resource && typeof block.resource === "object" ? block.resource : {};
  const uri = typeof res.uri === "string" ? res.uri : typeof block?.uri === "string" ? block.uri : "";
  const name = attachmentName(block, uri);
  if (typeof res.text === "string") return inlineTextFile(name, res.text, budget);
  if (typeof block?.text === "string") return inlineTextFile(name, block.text, budget);
  const mime = typeof res.mimeType === "string" ? res.mimeType : typeHint(block, name, "");
  return { text: notSentLine(name, mime), used: 0 };
}

function joinPromptWithAttachments(prompt) {
  let used = 0;
  const parts = [];
  for (const block of prompt) {
    if (block?.type === "resource_link") {
      const piece = inlineResourceLink(block, TOTAL_CHAR_CAP - used);
      parts.push(piece.text);
      used += piece.used;
      continue;
    }
    if (block?.type === "resource") {
      const piece = inlineEmbeddedResource(block, TOTAL_CHAR_CAP - used);
      parts.push(piece.text);
      used += piece.used;
      continue;
    }
    if (typeof block?.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/**
 * Joins the prompt's text blocks (and inlines attached text files) and removes BB's injected
 * <system_instructions>…</system_instructions> and <system-reminder>…</system-reminder>
 * sections (they may span several blocks after the join). Other markup is kept as is.
 * @param {unknown} prompt
 * @returns {string}
 */
export function promptText(prompt) {
  const raw = Array.isArray(prompt) ? joinPromptWithAttachments(prompt) : String(prompt ?? "");
  return raw.replace(SYSTEM_BLOCK_RE, "").trim();
}

function mimeFromName(name, fallback = "application/octet-stream") {
  const ext = path.extname(name || "").toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

function isImageMime(mime, name) {
  if (typeof mime === "string" && mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name || "");
}

function attachmentFromBuffer(buf, name, mime) {
  if (buf.length > MAX_ATTACHMENT_BYTES) return null;
  const mimeType = typeof mime === "string" && mime ? mime : mimeFromName(name);
  const type = isImageMime(mimeType, name) ? "image" : "file";
  return {
    type,
    mime_type: mimeType,
    data_base64: Buffer.from(buf).toString("base64"),
    filename: name || (type === "image" ? "image" : "file"),
  };
}

/**
 * Read a local file as a Muse chat attachment. Throws when the file is over 10 MB.
 * @param {string} filePath
 */
export function loadAttachmentFromPath(filePath) {
  const abs = path.resolve(filePath);
  const name = path.basename(abs);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    const err = new Error(`File too large for Muse (over 10 MB): ${name}`);
    err.code = "attachment_too_large";
    throw err;
  }
  const buf = fs.readFileSync(abs);
  return attachmentFromBuffer(buf, name, mimeFromName(name));
}

/**
 * A file goes to Muse as a real attachment up to 10 MB; over that a text file is
 * inlined truncated and a binary gets the not-sent line.
 */
function attachmentOrInline(name, mime, buf, budget) {
  const item = attachmentFromBuffer(buf, name, mime || mimeFromName(name));
  if (item) return { text: sentAttachmentLine(name), used: 0, attachment: item };
  const content = utf8Text(buf);
  if (content !== null) {
    const piece = inlineTextFile(name, content, budget);
    return { ...piece, attachment: null };
  }
  return { text: notSentLine(name, "over 10 MB"), used: 0, attachment: null };
}

function collectResourceLink(block, budget) {
  const uri = block?.uri;
  const name = attachmentName(block, uri);
  const mime = typeof block?.mimeType === "string" ? block.mimeType : "";
  const abs = filePathFromUri(uri);
  if (!abs) return { text: notSentLine(name, typeHint(block, name, "")), used: 0, attachment: null };
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { text: notSentLine(name, typeHint(block, name, abs)), used: 0, attachment: null };
  }
  return attachmentOrInline(name, mime, buf, budget);
}

function collectImageBlock(block) {
  const name = attachmentName(block, block?.uri);
  const mime = typeof block?.mimeType === "string" ? block.mimeType : mimeFromName(name, "image/png");
  if (typeof block?.data === "string" && block.data) {
    const buf = Buffer.from(block.data, "base64");
    const item = attachmentFromBuffer(buf, name, mime);
    if (!item) return { text: notSentLine(name, "over 10 MB"), attachment: null };
    return { text: "", attachment: item };
  }
  const abs = filePathFromUri(block?.uri);
  if (!abs) return { text: notSentLine(name, mime), attachment: null };
  try {
    const buf = fs.readFileSync(abs);
    const item = attachmentFromBuffer(buf, name, mime);
    if (!item) return { text: notSentLine(name, "over 10 MB"), attachment: null };
    return { text: "", attachment: item };
  } catch {
    return { text: notSentLine(name, mime), attachment: null };
  }
}

function collectEmbeddedResource(block, budget) {
  const res = block?.resource && typeof block.resource === "object" ? block.resource : {};
  const uri = typeof res.uri === "string" ? res.uri : typeof block?.uri === "string" ? block.uri : "";
  const name = attachmentName(block, uri);
  const mime = typeof res.mimeType === "string" ? res.mimeType : typeof block?.mimeType === "string" ? block.mimeType : "";
  if (typeof res.text === "string") {
    return attachmentOrInline(name, mime, Buffer.from(res.text, "utf8"), budget);
  }
  if (typeof res.blob === "string" && res.blob) {
    return attachmentOrInline(name, mime, Buffer.from(res.blob, "base64"), budget);
  }
  const abs = filePathFromUri(uri);
  if (abs) return collectResourceLink({ ...block, uri, mimeType: mime, name }, budget);
  return { text: notSentLine(name, mime || typeHint(block, name, "")), used: 0, attachment: null };
}

/**
 * Joins prompt text like promptText and collects attached files as Muse attachments.
 * Every file up to 10 MB goes in `attachments` with a marker line in the text; over
 * 10 MB a text file is inlined truncated and a binary gets the not-sent line.
 * @param {unknown} prompt
 * @returns {{ text: string, attachments: object[] }}
 */
export function collectPrompt(prompt) {
  if (!Array.isArray(prompt)) {
    return { text: String(prompt ?? "").replace(SYSTEM_BLOCK_RE, "").trim(), attachments: [] };
  }
  let used = 0;
  const parts = [];
  const attachments = [];
  for (const block of prompt) {
    if (block?.type === "image") {
      const piece = collectImageBlock(block);
      if (piece.text) parts.push(piece.text);
      if (piece.attachment) attachments.push(piece.attachment);
      continue;
    }
    if (block?.type === "resource_link") {
      const piece = collectResourceLink(block, TOTAL_CHAR_CAP - used);
      parts.push(piece.text);
      used += piece.used;
      if (piece.attachment) attachments.push(piece.attachment);
      continue;
    }
    if (block?.type === "resource") {
      const piece = collectEmbeddedResource(block, TOTAL_CHAR_CAP - used);
      parts.push(piece.text);
      used += piece.used ?? 0;
      if (piece.attachment) attachments.push(piece.attachment);
      continue;
    }
    if (typeof block?.text === "string") parts.push(block.text);
  }
  return { text: parts.join("").replace(SYSTEM_BLOCK_RE, "").trim(), attachments };
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

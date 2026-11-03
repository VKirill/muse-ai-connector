import fs from "node:fs";
import path from "node:path";

export const IMAGE_FORMATS = ["1:1", "9:16", "16:9", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "21:9"];

const FORMAT_SET = new Set(IMAGE_FORMATS);

function stripSandbox(p) {
  return String(p ?? "").replace(/^sandbox:\/\//, "");
}

export function imagePrompt(text, format) {
  const body = String(text ?? "").trim();
  if (format == null || format === "") return `Create image. ${body}`;
  if (!FORMAT_SET.has(format)) {
    const err = new Error(`Unknown image format: ${format}`);
    err.code = "unknown_image_format";
    throw err;
  }
  return `Create image format: ${format}. ${body}`;
}

export function parseLeadingFormat(text) {
  const raw = String(text ?? "");
  const m = raw.match(/^\s*(?:\[(\d+:\d+)\]|(\d+:\d+))\s+(.*)$/s);
  if (!m) return { format: null, text: raw };
  const format = m[1] || m[2];
  if (!FORMAT_SET.has(format)) return { format: null, text: raw };
  return { format, text: m[3] };
}

function eventSeq(event) {
  const seq = event?.seq ?? event?.chat_event_seq ?? event?.payload?.chat_event_seq ?? event?.payload?.seq;
  return Number.isFinite(Number(seq)) ? Number(seq) : null;
}

export function extractImages(historyJson, { sinceSeq } = {}) {
  const events = historyJson?.result?.chat_events ?? historyJson?.chat_events ?? [];
  const out = [];
  const seen = new Set();
  for (const event of events) {
    const seq = eventSeq(event);
    if (sinceSeq != null && seq != null && seq <= sinceSeq) continue;
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    if (payload.kind !== "image") continue;
    const list = Array.isArray(payload.data?.images) ? payload.data.images : [];
    if (list.length === 0 && !payload.image_path) continue;
    const imgs = list.length ? list : [{ path: payload.image_path }];
    for (const img of imgs) {
      const mediaPath = stripSandbox(img.path) || payload.image_path;
      if (!mediaPath || seen.has(mediaPath)) continue;
      seen.add(mediaPath);
      out.push({
        mediaPath,
        mime: img.mime ?? "image/webp",
        width: img.width ?? null,
        height: img.height ?? null,
        label: img.label ?? payload.display_text ?? event.display_text ?? "",
        byteLen: img.byte_len ?? img.byteLen ?? null,
      });
    }
  }
  return out;
}

export async function saveImages(client, images, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const img of images) {
    const bytes = await client.fetchMedia(img.mediaPath);
    const dest = path.join(dir, path.basename(img.mediaPath));
    fs.writeFileSync(dest, bytes);
    written.push({ ...img, path: dest, bytes });
  }
  return written;
}

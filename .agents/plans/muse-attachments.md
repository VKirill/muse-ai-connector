---
title: Muse attachments (images and files) through the API
status: building
started: 2026-11-03
task: muse-attachments
---

# Muse attachments

## Recon (2026-11-03, account main; probes in /tmp/muse-probe, bundle chat-js/41.js tG, 86.js send, 36.js NoiseRequestCodec)
- The web app sends attachments **inside the chat message**, not by a separate upload: `POST /chat/stream` with
  `items` instead of `message`:
  `items: [{type:"image", mime_type, data_base64, filename}, {type:"file", mime_type, data_base64, filename}, …, {type:"text", text}]`
  plus the usual `node_id, session_id, capabilities, timezone, metadata`.
  Only non-image files over 10 MB (video over 60 MB) go through a separate upload and a `{type:"file_ref", path}` item —
  out of scope here.
- Muse stores them as `workspace/user/media_library/image/<name>` and `workspace/user/files/<name>` and the user message
  shows `[image:<mime> <path>]` / `[file:<mime> <path>]` lines; `metadata.attachments[]` has filename, mime_type, path, bytes_len.
- One Noise transport message is at most 65535 bytes. A larger request body goes as a request head with
  `endBody:false` and an empty body, then `bodyChunk {data, endBody}` frames on the same stream.
  Wire: the frame message `{1: streamId, 4: {1: data, 2: endBody}}` wrapped like a request
  (`{1: frameId, 2: 0, 3: 1, 4: {2: <frame>}}`); 48 KiB chunks worked live.
- Live proofs: a 9 KB jpeg + a .md as items (Muse described both); a 68 KB png chunked (described); the owner's 58 KB photo
  + «Create image. …» → Muse generated the owner in the requested scene (artifacts/muse-soviet-me.png).

## Build
1. `bridge/protocol/envelope.mjs`: `encodeBodyChunk({streamId, chunk, end})`.
2. `bridge/protocol/gateway.mjs` `sendRequest`: a body over 48 KiB → head with `end:false`, no body, then chunk frames.
3. `bridge/protocol/api.mjs`: `chatStreamBody({text, attachments})` → `items` (attachments then the text item) when attachments
   are given, else `message` as now; `send({…, attachments})` passes them. Attachment = `{type:"image"|"file", mime_type, data_base64, filename}`.
4. ACP (`bin/muse-acp.mjs`, `bridge/acp-prompt.mjs`): report `promptCapabilities.image: true` so BB sends attached pictures as
   `{type:"image", data, mimeType}` blocks; each becomes an image attachment. `resource_link` files that are not text
   (pdf, docx, …) up to 10 MB become `file` attachments read from disk; text files stay inlined as now.
   Works in both models; in Muse Image the first message still gets the prefix.
5. CLI: `--attach <path>` (repeatable) for `send` and `image`; mime from the extension; images (png, jpg, jpeg, webp, gif, heic)
   go as image items, the rest as file items; over 10 MB → clear error.
6. README (EN + RU): attaching pictures and files in BB and with `--attach`.

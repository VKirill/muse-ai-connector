---
title: Muse image mode (CLI + BB chats)
status: building
started: 2026-11-03
---

# Muse image mode

## Goal
Generate pictures with Muse from BB and from the CLI. With a form factor the prompt starts with
`Create image format: <W:H>. ` and the user's prompt follows; without one it starts with `Create image. `.
The picture lands as a file in the caller's folder and is shown in the BB chat.

## What Muse does (recon 2026-11-03, account main, chat a506db6f…)
- Prompt «Create image format: 16:9. A small red fox…» → Muse runs `media.generate_image`, the text reply is just «Here it is.».
- The picture is in `/chat/history` as `result.chat_events[i]` with `event_name: "delta.presentation"`,
  `payload.kind: "image"`, `payload.image_path: "workspace/imagine_media/<name>.webp"` and
  `payload.data.images[]`: `{path:"sandbox://workspace/imagine_media/<name>.webp", mime:"image/webp", width:2048, height:1152,
  byte_len, label, missing:false, variants:{original:"https://<vm>.metaaivm.com/media/raw/workspace/imagine_media/<name>.webp"}}`.
  A redacted copy of this answer: `/tmp/muse-images/history-image.json`.
- `GET /media/raw/<image_path>` through the Noise gateway answers 200 (the `<vm>.metaaivm.com` host does not resolve
  publicly, so the bytes come through the gateway). The current `gw.request()` only offers `json()`: add a raw
  bytes accessor (`bytes()` → Buffer of the concatenated chunks, decoded per content-encoding when it is set).
- Muse may ask an approval card before generating; the connector already answers «Always allow».

## Pieces (one task, `muse-image-mode`)
1. `bridge/images.mjs` (plain ESM):
   - `IMAGE_FORMATS` = `["1:1","9:16","16:9","4:5","5:4","3:4","4:3","2:3","3:2","21:9"]`.
   - `imagePrompt(text, format?)` → `Create image format: <f>. <text>` / `Create image. <text>`; an unknown format throws.
   - `parseLeadingFormat(text)` → `{format, text}`: a known format as the first token (`16:9 …` or `[16:9] …`), else `{format:null, text}` unchanged.
   - `extractImages(historyJson, {sinceSeq?})` → `[{mediaPath, mime, width, height, label, byteLen}]` from `delta.presentation` image events (only events after `sinceSeq` when given; dedupe by path).
   - `saveImages(client, images, dir)` → fetches each `/media/raw/<mediaPath>` with the new raw accessor, writes `<dir>/<basename>`, returns the written paths.
2. API client (`bridge/protocol/api.mjs`, `gateway.mjs`): `client.fetchMedia(mediaPath)` → Buffer; `send()` result also carries the
   `chat_event_seq` it started from so callers can pick only the new images.
3. CLI: `musebridge image [--account <id>] [--format <W:H>] [--out <dir>] [--chat <id>] [--json] <prompt>` → sends `imagePrompt`, waits for the
   reply, reads history, saves the new images (default dir `./muse-images`), prints the paths (or JSON `{chatId, text, images:[{path,width,height,mime,label}]}`).
   Fails with a clear message when Muse answered without a picture.
4. BB chats: a second model in the Muse provider, **Muse Image** (`muse-image`). In it every user message is an image request:
   leading format token → `imagePrompt(rest, format)`; no tools intro, no BB system text. After the reply the agent saves the new
   images into `<workspace>/muse-images/` and sends them back as ACP content: an `image` content block (base64, mimeType) per picture
   plus a text line with the saved relative path. Follow-up messages in the same BB chat go to the same Muse chat (edits like «сделай светлее» work).
   The **Muse Spark** model keeps working as now.
5. Help text, README sections (EN + RU) for the image command and the Muse Image model.

## Not in scope
Video (`media.generate_video`), icons, Muse native tools beyond images.

---
title: Muse (muse.ai) web app — observed contract
date: 2026-11-02
source: PM capture in the owner's signed-in Chrome (Mac mini) via browser-harness/CDP, thread thr_q4w86he7i7
status: observed
---

# Muse web app — what we observed

Muse (https://muse.ai/) is Meta's personal assistant ("Muse Spark" model). Every user has a
cloud VM ("hatch"); the web app is a Next.js shell that talks to that VM.

## Transport (why we drive a browser)

| Layer | Observed |
|---|---|
| Chat traffic | One **binary WebSocket** `wss://hatch.metaaivm.com/v1/noise?vm_id=<vm>&auth_token=<redacted>` — Noise-protocol encrypted frames (handshake 66/64 bytes, then binary frames). No REST/SSE/GraphQL call carries chat messages. |
| HTTP on load | `GET /api/consent/status`, `POST /api/hatch/stateful-sharing`, `POST /api/hatch/vm/wake {vm_id, retry_count, connect_attempt_id}` → `{"status":"wake_requested"}`, `POST /api/falco` (telemetry with session claims), `GET /api/client-ip`, `POST /api/auth/check`, Next.js server action `POST /` (`next-action` header), Sentry `/monitoring`, Vercel analytics. |
| Device keys | IndexedDB `hatch-cvm-credentials` (store `keys`, held as browser crypto keys), `hatch-cvm-provisioning`. |

**Decision:** direct HTTP replay is not possible without reimplementing the Noise handshake with
device keys held inside the browser. The connector drives a real Chrome per account
(persistent profile) and reads results from the page's own cache. No token is extracted.

## Session

Cookies (names only): `.muse.ai`: `hatch_sess` (HttpOnly, Secure, Lax, ~30 days), `hatch_gw`,
`datr`, `dpr`, `wd`, `theme`, `layout_state`; `muse.ai`: `hatch_native_auth_temp`,
`hatch_native_auth_device`, `__Host-hatch_one_tap`; `.auth.meta.com`: `fs`.
Sign-in is a Meta account (phone or email, OIDC via auth.meta.com; may hit a checkpoint).
A persistent Chrome profile keeps it; re-login is needed roughly monthly or after a checkpoint.
Account menu (Settings → Meta Account, Log out) has **no account switcher**: one profile = one account.

## Pages and DOM

| Action | How |
|---|---|
| Main chat | `https://muse.ai/` (title `Chat — Muse`) |
| New side chat | navigate `https://muse.ai/thread/new`; after the first message the URL becomes `https://muse.ai/thread/<session_id uuid>` |
| Open side chat | `https://muse.ai/thread/<session_id>` |
| Composer | AX role `textbox`, name `Message` (a contenteditable). Focus it, `Input.insertText`, press Enter. Attach button: `Attach file`. |
| Messages | `[data-message-id]` with `data-message-role` = `user` / `assistant`; assistant ids look like `assistant-msg-<uuid>` |
| Busy | page text contains `is working` while Muse thinks |
| Signed-in signals | `[data-testid=hatch-nav-chat]`, `[data-testid=hatch-chat-switcher-trigger]`, the composer textbox; signed out = login form (phone/email) |
| Chats panel | button `Chats Open chat and side chats` (`hatch-chat-switcher-trigger`), `New side chat` |

Timing seen: reply to a one-word prompt in ~5–8 s; reloaded history renders in < 1 s.

## Page cache — the clean read path

IndexedDB database `hatch-chat-cache` (schemaVersion 4):

- store `side-chat-lists` (keyPath `cacheKey`): `{cacheKey, schemaVersion, cachedAtMs, targetKey, sessions:[...]}`;
  a session: `{session_id, can_send_messages, can_send_actions, created_at, updated_at (ms), status:"completed"|…, title, snippet, is_primary, is_thread, archived, pinned, unread_count}`.
- store `side-transcripts` (keyPath `cacheKey`, indexes `cached-at`, `target-session-cached-at`): one record per side chat
  `{cacheKey, schemaVersion, sessionId, targetKey, transcriptRevision, messageIds:[...], messagesById:{id: msg}, reactions, oldestSeq, newestSeq, hasMore, cachedAtMs, lastAccessedAtMs}`.
- store `main-transcripts`: same shape for the main chat (no `sessionId`).

A message:

```json
{"id":"assistant-msg-<uuid>","messageId":"assistant-msg-<uuid>","role":"assistant","content":"PONG",
 "createdAt":"2026-11-02T22:20:54.911Z","source":"runtime","isTextStreaming":false,
 "rootMessageExecutionId":"<uuid>","sortSeq":70,"sortSeqSource":"canonical",
 "analytics":{"initialModel":"Muse Spark","finalModel":"Muse Spark","clientFirstTokenMs":0,"clientDoneMs":0}}
```

User messages carry `deliveryStatus:"sent"`, `clientSentAt`. A reply is complete when the newest
assistant message after our user message has `isTextStreaming:false` and the page no longer shows
`is working`. While streaming, `content` grows: diff it to emit deltas (or diff the DOM text of the
last `[data-message-role=assistant]`, which updates first).

## Test evidence

Side chat "Reply with PONG" (session `3dfece7e-0301-47cb-8bf8-50383cde4a96`) in the owner's account:
"Test from connector: reply with the single word PONG." → `PONG`; "And now reply with the number 42." → `42`.

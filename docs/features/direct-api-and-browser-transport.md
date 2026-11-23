---
title: Direct API and Browser Transport
type: component
created: 2026-11-18
updated: 2026-11-23
status: active
confidence: medium
tags: [transport, noise, websocket, protobuf, zstd, chrome, indexeddb, permissions]
sources:
  - bridge/protocol/api.mjs
  - bridge/protocol/gateway.mjs
  - bridge/protocol/noise.mjs
  - bridge/protocol/envelope.mjs
  - bridge/protocol/ndjson.mjs
  - bridge/session.mjs
  - bridge/cache.mjs
  - bridge/permissions.mjs
  - bin/muse-acp.mjs
  - bin/musebridge.mjs
---

# Direct API and Browser Transport

Drives Muse chats primarily over an HTTPS-bootstrapped, Noise-encrypted WebSocket tunnel (`api` transport) and falls back to persistent Playwright Chrome (`browser` transport) when cookies are missing or rejected.

## Purpose

`bridge/protocol/*` implements Muse's web wire protocol (`bridge/protocol/gateway.mjs:273-667`, `bridge/protocol/api.mjs:165-401`) so chat turns run without launching Chrome, while `bridge/session.mjs`, `bridge/cache.mjs`, and `bridge/permissions.mjs` provide Chrome-based login, IndexedDB transcript fallback, and approval-card automation (`bridge/session.mjs:120-267`, `bridge/cache.mjs:16-118`, `bridge/permissions.mjs:17-141`).

## How it works

1. **Transport selection (`resolveTransport` / `openTransport`):** Defaults to `"api"` unless `--transport browser` or `MUSE_TRANSPORT=browser` is set (`bridge/protocol/api.mjs:68-71,375-386`). If `createMuseClient` throws `missing_cookies`, `auth_failed`, `401`, or `403`, `openTransport` (and `bin/muse-acp.mjs:298-308`) marks the account `signed_out` on auth failure and falls back to `openSession` (`bridge/protocol/api.mjs:363-400`).
2. **HTTPS bootstrap (`bootstrapHttps`):** Fetches `https://muse.ai/` with account cookies and parses Next.js flight chunks (`parseBootstrapFromHtml`) by searching for `"authToken"`, `"auth_token"`, and `"cvmMigrationInventorySnapshot"` (falling back to `"gatewayUrl"`/`"gateway_url"` objects when `authToken` is absent) (`bridge/protocol/gateway.mjs:186-228,281-284`). Explicit unauthenticated `backendAuthStatus` values (`/unauth|signed.?out|logged.?out|anonymous/i`) throw `403`; if `authToken` is missing or `backendAuthStatus` is non-`"authenticated"` (such as `"indeterminate"`), it calls `POST /api/hatch/token` with `{ vmAddress, vmName, force_refresh: true }` (or `{}` when no page context was parsed) and resolves the assignment via `assignmentFromToken`, then calls `POST /api/hatch/vm/wake` and `POST /api/hatch/stateful-sharing` (`bridge/protocol/gateway.mjs:252-323`).
3. **Noise XX handshake & framing:** `connectGateway` opens `wss://hatch.metaaivm.com/v1/noise` via `ws` with `Origin: https://muse.ai` (`bridge/protocol/gateway.mjs:23,325-336,612-627`), runs the 3-message `Noise_XX_25519_AESGCM_SHA256` handshake (`bridge/protocol/noise.mjs:19-23,117-251`), and multiplexes HTTP-like requests and server pushes in custom protobuf frames (`encodeRequest`, `encodeBodyChunk`, `decodeFrame`) (`bridge/protocol/envelope.mjs:39-223`). Payloads larger than `BODY_CHUNK_LIMIT` (`48` KiB) stream across `encodeBodyChunk` frames (`bridge/protocol/gateway.mjs:7,495-511`).
4. **Chat streaming & resubscribe:** `createMuseClient` registers the local node (`/api/nodes/register`) (`bridge/protocol/api.mjs:149-169`). `send()` posts `/chat/stream` and opens `/chat/subscribe` (`bridge/protocol/api.mjs:208-288`), decoding zstd-sniffed NDJSON events (`createStreamDecoder`, `ZSTD_MAGIC = 0xfd2fb528`) (`bridge/protocol/ndjson.mjs:3,22-96`), deduplicating deltas by `stream_seq`, and resubscribing with exponential backoff (`1s..30s`) if the stream or socket drops before `task.status` finishes and `agent.status` leaves `"working"` (`bridge/protocol/api.mjs:243-330`).
5. **Browser transport & approval cards:** `openSession` launches Playwright Chrome (`channel: "chrome"`, `--lang=en-US`) with profile `~/.muse-bridge/profiles/<id>/`, navigates `muse.ai/thread/<chatId>`, types into `COMPOSER_SELECTOR`, polls `indexedDB` (`hatch-chat-cache` `side-transcripts` and `side-chat-lists`) and `BUSY_TEXTS` (`["is working"]`), and auto-answers visible approval cards via `answerPermissionCards` (`bridge/session.mjs:18-31,52-230`, `bridge/permissions.mjs:115-141`).

### Modes and error handling

| Mode / Condition | Entry / Trigger | Transport Mechanism | Failure Behaviour |
|---|---|---|---|
| `api` (default) | `MUSE_TRANSPORT` unset or `"api"` (`bridge/protocol/api.mjs:68-71`) | `ws` + Noise XX + protobuf + zstd NDJSON (`bridge/protocol/gateway.mjs:612-667`) | Socket drop reconnects once per `request`/`stream` (`bridge/protocol/gateway.mjs:638-646`); `401`/`403` or `missing_cookies` falls back to Chrome (`bridge/protocol/api.mjs:363-400`) |
| `browser` (fallback / explicit) | `--transport browser`, `MUSE_TRANSPORT=browser`, or `api` auth fallback (`bridge/protocol/api.mjs:384-400`) | Playwright persistent Chrome + `hatch-chat-cache` IndexedDB (`bridge/session.mjs:120-230`) | `parseTranscript` throws if `schemaVersion !== 4` (`bridge/cache.mjs:16-19`); `send` throws `reply_timeout` after `timeoutMs` (`bridge/session.mjs:42-46,229`) |
| Approval card handling | `openSession.send()` and `openSession.approve()` (`bridge/session.mjs:181-192,238-256`) | Scans EN/RU buttons (`Always allow` / `Всегда разрешать` vs `Deny` / `Отклонить`) (`bridge/permissions.mjs:30-106`) | Non-money cards clicked automatically; money cards (`MONEY_RE`) invoke `onAsk` (`"Muse asks for approval: …"`) and extend `deadline`; `Deny` is never clicked (`bridge/permissions.mjs:8-20,124-129`) |

## Business rules

- **Fixed gateway host:** `bootstrapHttps` always returns `DEFAULT_WS` (`wss://hatch.metaaivm.com/v1/noise`) as `gatewayUrl`, preserving any per-VM host from flight HTML in `vmGatewayUrl` (`bridge/protocol/gateway.mjs:23,315-322`).
- **Node registration:** Every `createMuseClient` instance loads or generates a persistent `node_id` UUID (`accounts/<id>/node.json`) and registers `commands_v2.ping` via `POST /api/nodes/register` (`bridge/protocol/api.mjs:31-46,149-169`).
- **Cache schema guard:** `parseTranscript` requires `record?.schemaVersion === 4` and rejects other versions explicitly (`bridge/cache.mjs:16-19`).
- **Chrome executable lookup:** `chromeExecutable()` checks `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/usr/bin/google-chrome-stable`, and `/usr/bin/google-chrome` (`bridge/session.mjs:12-16,34-36`).

## Public API

| Export | File:Line | Purpose |
|---|---|---|
| `resolveTransport`, `openTransport`, `createMuseClient`, `chatStreamBody` | `bridge/protocol/api.mjs:51-71,165-401` | Selects `api`/`browser` driver, builds `/chat/stream` JSON, and runs Noise API sessions |
| `BODY_CHUNK_LIMIT`, `DEFAULT_WS`, `buildGatewayUrl`, `parseBootstrapFromHtml`, `bootstrapHttps`, `gatewaySocketOptions`, `defaultSocketFactory`, `connectGateway` | `bridge/protocol/gateway.mjs:7-667` | Flight HTML parsing, VM wake, `ws` dial, Noise handshake, and auto-reconnecting tunnel |
| `PROTOCOL_NAME`, `createHandshake` | `bridge/protocol/noise.mjs:12,117-252` | `Noise_XX_25519_AESGCM_SHA256` handshake and transport AEAD cipher states |
| `encodeRequest`, `encodeResponse`, `encodeBodyChunk`, `decodeFrame` | `bridge/protocol/envelope.mjs:39-70,184-223` | Custom protobuf HTTP-over-tunnel envelope codec |
| `decodeBody`, `createStreamDecoder` | `bridge/protocol/ndjson.mjs:13-96` | Magic-sniffing zstd and plain JSON/NDJSON decoders |
| `COMPOSER_SELECTOR`, `BUSY_TEXTS`, `launchOptions`, `chromeExecutable`, `openSession` | `bridge/session.mjs:18-36,120-267` | Persistent Playwright Chrome driver (`isSignedIn`, `waitForSignIn`, `listChats`, `history`, `send`, `approve`, `exportCookies`) |
| `parseTranscript`, `parseChatList`, `findUserMessage`, `replyState` | `bridge/cache.mjs:16-118` | `hatch-chat-cache` IndexedDB transcript and reply-state parsers |
| `PERM_CARD_ATTR`, `permissionDecision`, `answerPermissionCards` | `bridge/permissions.mjs:11-20,115-141` | Monetary vs. non-monetary approval card classifier and clicker |

## Gotchas

- `openSession` (`browser` transport) does not implement `fetchMedia`, so `muse-image` mode and `musebridge image` reject on the browser transport with `"Image mode needs the API transport."` (`bin/muse-acp.mjs:391-397`, `bin/musebridge.mjs:345-348`).
- `handshake(ws)` writes `"Noise server identity not verified\n"` to `stderr` on every new gateway connection (`bridge/protocol/gateway.mjs:390`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architecture](../architecture.md)
- [Muse AI Connector — Overview](../overview.md)

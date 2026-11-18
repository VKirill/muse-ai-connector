---
title: API Reference
type: component
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: medium
tags: [api, rpc, acp, muse-gateway, endpoints]
sources:
  - server.ts
  - host.ts
  - bin/muse-acp.mjs
  - bridge/acp-tools.mjs
  - bridge/auto-login.mjs
  - bridge/protocol/gateway.mjs
  - bridge/protocol/api.mjs
  - bridge/usage.mjs
  - bridge/hub-sync.mjs
  - app.tsx
---

# API Reference

All programmatic interfaces across `bb-plugin-muse`: BB Hub RPC (`rpcContract`), BB Host RPC (`hostContract`), `muse-acp` JSON-RPC 2.0 over stdio, and upstream `muse.ai` HTTPS and Noise WebSocket endpoints.

## Purpose

The plugin exposes two typed Zod RPC contracts between BB UI, Hub, and Host daemons (`server.ts:93-120`, `host.ts:84-115`), implements ACP JSON-RPC 2.0 on stdio for BB chat execution (`bin/muse-acp.mjs:617-709`), and consumes `muse.ai` HTTPS and Noise-tunnel endpoints (`bridge/protocol/gateway.mjs:273-306`, `bridge/protocol/api.mjs:150-284`, `bridge/usage.mjs:86-92`).

## How it works

1. The BB UI panel (`app.tsx`) invokes `rpcContract` methods on `server.ts` via `useRpc<typeof rpcContract>()` (`app.tsx:440`, `server.ts:416-458`).
2. `server.ts` translates each Hub RPC call into `hostContract` calls (`server.ts:93-109,234`) via `oneHost` and `bb.rpc.register` (`server.ts:352-457`), passing `HOST_LOGIN_TIMEOUT_MS` and sibling deadlines (`server.ts:127-132`).
3. `host.ts` handles `hostContract` calls locally or spawns `musebridge` subprocesses with JSON on `stdin`/`stdout` (`host.ts:185-203,251-338`).
4. For chat execution, BB spawns `muse-acp` (`bin/muse-acp.mjs`) over stdio JSON-RPC; `muse-acp` forwards prompts and streams responses via `bridge/protocol/api.mjs` and `bridge/protocol/gateway.mjs` (`bin/muse-acp.mjs:287-297,617-709`).

### Transport and protocol surfaces

| Surface | Framing / Auth | Timeout / Limit | Failure behaviour |
|---|---|---|---|
| Hub RPC (`rpcContract`) | BB plugin RPC; BB authenticated session | `HOST_LOGIN_TIMEOUT_MS` 12 min, `HOST_INSTALL_TIMEOUT_MS` 10 min, `HOST_CHECK_TIMEOUT_MS` 3 min, `USAGE_TIMEOUT_MS` 45 s (`server.ts:127-132`) | Returns `{ error }` in `HostEntry` or `usage_timeout` / `usage_unavailable` (`server.ts:192-201,362-364`) |
| Host RPC (`hostContract`) | BB host-daemon RPC; BB hub-host channel | `ADD_TIMEOUT_MS` 11 min, `CHECK_TIMEOUT_MS` 120 s, `LIST_TIMEOUT_MS` 15 s (`host.ts:15-17`) | Returns `problems[]` in `HostStatus` or throws stderr tail (`host.ts:245-249,285,315`) |
| ACP (`muse-acp`) | Line-delimited JSON-RPC 2.0 on stdio | `CLIENT_REQUEST_TIMEOUT_MS` 60 s (`bin/muse-acp.mjs:58`) | Replies `-32601` / `-32602` / `-32603` or streams `RetriableError` / `NonRetriableError` (`bin/muse-acp.mjs:609-612,707`) |
| Muse HTTPS + Noise Tunnel | Session `Cookie` header + Noise XX (`vm_id`, `auth_token`) | HTTP `401`/`403` triggers `auth_failed`; `REPLY_TIMEOUT_MS` default 180 s (`bridge/protocol/gateway.mjs:28-33`, `bin/muse-acp.mjs:21`) | `connectGateway` reconnects once per call; `send()` resubscribes with exponential backoff (`bridge/protocol/api.mjs:290-304`, `bridge/protocol/gateway.mjs:630-638`) |

## Business rules

- **Hub timeout headroom:** Every Hub-to-Host RPC timeout (`HOST_LOGIN_TIMEOUT_MS`, `HOST_CHECK_TIMEOUT_MS`, `HOST_INSTALL_TIMEOUT_MS`, `HOST_USAGE_TIMEOUT_MS`) is strictly larger than the corresponding subprocess timeout in `host.ts` so BB's 30 s default host-call deadline does not interrupt login or runtime installs (`server.ts:127-132`, `host.ts:15-17`).
- **Cookie handling across RPC:** `exportAccount` returns cookies only on `hostContract` for in-memory transit inside `syncAcrossHosts`; `rpcContract` never exposes cookie arrays to the browser UI (`server.ts:100-120`, `bridge/hub-sync.mjs:4,11-20`).
- **Gateway origin enforcement:** Every `/api/hatch/*` HTTPS call sends `Origin: https://muse.ai`, `Referer: https://muse.ai/`, and `x-app-id: hatch-web`, and WebSocket upgrade dials `wss://hatch.metaaivm.com/v1/noise` with `Origin: https://muse.ai` (`bridge/protocol/gateway.mjs:23-24,236-251,317-322`).

## Public API

### BB Hub RPC (`rpcContract`)

Registered in `server.ts:416-458` using schemas at `server.ts:111-120`.

| Method | Path / Name | Caller | Purpose | Auth |
|---|---|---|---|---|
| RPC | `hosts` (`server.ts:112,417-419`) | `app.tsx` (`app.tsx:453`), `bb plugin rpc call` | List connected/offline hosts, Chrome, runtime, and account rows | BB Hub session |
| RPC | `addAccount` (`server.ts:113,420-426`) | `app.tsx` (`app.tsx:870`) | Open visible Chrome sign-in on `hostId`, then sync new `signed_in` account to all hosts | BB Hub session |
| RPC | `reloginAccount` (`server.ts:114,427-432`) | `app.tsx` (`app.tsx:838`) | Re-authenticate existing `id` on `hostId`, then sync across hosts | BB Hub session |
| RPC | `syncAccounts` (`server.ts:115,433-443`) | `app.tsx` (`app.tsx:834`), `bridge/auto-login.mjs:609` | Push one `id` or all `signed_in` accounts from `hostId` to all connected hosts with runtime | BB Hub session |
| RPC | `checkAccounts` (`server.ts:116,444-446`) | `app.tsx` (`app.tsx:833`) | Run `musebridge accounts check` on `hostId` | BB Hub session |
| RPC | `removeAccount` (`server.ts:117,447-449`) | `app.tsx` (`app.tsx:835`) | Delete account `id` from `hostId` (and profile dir if `purge: true`) | BB Hub session |
| RPC | `installRuntime` (`server.ts:118,450-452`) | `app.tsx` (`app.tsx:857`) | Install `PLUGIN_VERSION` runtime on `hostId` | BB Hub session |
| RPC | `usage` (`server.ts:119,453-457`) | `app.tsx` (`app.tsx:612`), `bb plugin rpc call` | Fetch merged plan quota across unique accounts (`collectMergedUsage`) | BB Hub session |

### BB Host RPC (`hostContract`)

Registered in `host.ts:251-338` using schemas at `host.ts:84-115`.

| Method | Path / Name | Caller | Purpose | Auth |
|---|---|---|---|---|
| RPC | `status` (`host.ts:85,254-257`) | `server.ts:248,376` | Trigger background `ensureRuntime()` and return `HostStatus` | BB Hub→Host channel |
| RPC | `installRuntime` (`host.ts:90,258-264`) | `server.ts:451` | Run `installRuntime()` synchronously and return `HostStatus` | BB Hub→Host channel |
| RPC | `addAccount` (`host.ts:86,265-268`) | `server.ts:421` | Run `musebridge accounts add <label>` | BB Hub→Host channel |
| RPC | `reloginAccount` (`host.ts:87,269-272`) | `server.ts:428` | Run `musebridge accounts login <id>` | BB Hub→Host channel |
| RPC | `checkAccounts` (`host.ts:88,273-277`) | `server.ts:445` | Run `musebridge accounts check [<id>]` | BB Hub→Host channel |
| RPC | `removeAccount` (`host.ts:89,278-282`) | `server.ts:448` | Run `musebridge accounts remove <id> [--purge]` | BB Hub→Host channel |
| RPC | `exportAccount` (`host.ts:91-99,283-301`) | `server.ts:389` | Run `musebridge accounts export <id> --json` | BB Hub→Host channel |
| RPC | `importAccount` (`host.ts:100-110,302-311`) | `server.ts:390` | Pipe `{id, label, cookies, maxParallel}` to `musebridge accounts import` | BB Hub→Host channel |
| RPC | `usage` (`host.ts:111-114,312-337`) | `server.ts:455` | Run `musebridge accounts usage [<id>] --json` | BB Hub→Host channel |

### ACP JSON-RPC (`bin/muse-acp.mjs`)

Handled on `stdin`/`stdout` in `bin/muse-acp.mjs:617-709`.

| Method | Direction | Caller | Purpose | Auth |
|---|---|---|---|---|
| JSON-RPC | `initialize` (`bin/muse-acp.mjs:619-630`) | BB ACP host | Store `clientCapabilities`; advertise `promptCapabilities.image: true` and `mcpCapabilities.http: true` | Local stdio |
| JSON-RPC | `session/new` (`bin/muse-acp.mjs:631-646`) | BB ACP host | Allocate `muse-<uuid>` session, persist to `sessions.json`, start MCP servers, return models | Local stdio |
| JSON-RPC | `session/set_model` (`bin/muse-acp.mjs:647-655`) | BB ACP host | Switch session between `muse-spark` and `muse-image` | Local stdio |
| JSON-RPC | `session/prompt` (`bin/muse-acp.mjs:656-657`) | BB ACP host | Execute image turn or `muse-spark` tool loop | Local stdio |
| JSON-RPC | `session/cancel` (`bin/muse-acp.mjs:699-703`) | BB ACP host | Set `session.cancelled = true` to abort between steps | Local stdio |
| JSON-RPC | `session/close` (`bin/muse-acp.mjs:658-663`) | BB ACP host | Remove session from memory and close its MCP servers | Local stdio |
| JSON-RPC | `fs/read_text_file`, `fs/write_text_file` (`bin/muse-acp.mjs:77-96`, `bridge/acp-tools.mjs:453-501`) | `muse-acp` → BB | Route `read_file`/`write_file`/`edit_file` through ACP client when `clientCapabilities.fs` enables them | Local stdio |
| JSON-RPC | `session/update` via `update()` (`bin/muse-acp.mjs:123-125`) | `muse-acp` → BB | Stream `agent_message_chunk` (`bin/muse-acp.mjs:547`), `agent_thought_chunk` (`bin/muse-acp.mjs:553`), `tool_call` (`bin/muse-acp.mjs:559`), and `tool_call_update` (`bin/muse-acp.mjs:568`) | Local stdio |

### Muse HTTPS and Noise Gateway Endpoints

Called by `bridge/protocol/gateway.mjs`, `bridge/protocol/api.mjs`, and `bridge/usage.mjs`.

| Method | Path | Caller | Purpose | Auth |
|---|---|---|---|---|
| `GET` | `https://muse.ai/` (`bridge/protocol/gateway.mjs:281`) | `bootstrapHttps` | Fetch Next.js flight HTML containing `vmId`, `authToken`, `notaryToken` | Account `Cookie` header |
| `POST` | `https://muse.ai/api/hatch/token` (`bridge/protocol/gateway.mjs:265-290`) | `bootstrapHttps` | Fallback VM token assignment when `authToken` is missing | Account cookie header |
| `POST` | `https://muse.ai/api/hatch/vm/wake` (`bridge/protocol/gateway.mjs:265-300`) | `bootstrapHttps` | Wake assigned VM before dialing Noise WebSocket | Account cookie header |
| `POST` | `https://muse.ai/api/hatch/stateful-sharing` (`bridge/protocol/gateway.mjs:265-305`) | `bootstrapHttps` | Enable stateful sharing on the Muse session | Account cookie header |
| `POST` | `https://muse.ai/` (`bridge/usage.mjs:86-92`) | `fetchAccountUsage` | Next.js server action (`Next-Action` header, body `[{"includeAgreement":true}]`) for plan quota | Account `Cookie` header |
| `WSS` | `wss://hatch.metaaivm.com/v1/noise` (`bridge/protocol/gateway.mjs:23,51-59`) | `connectGateway` | Upgrade WebSocket with `vm_id`, `auth_token`, `app_id=hatch-web`, `request_id`, `notary_token` | `auth_token` + Noise XX |
| Tunnel `POST` | `/api/nodes/register` (`bridge/protocol/api.mjs:150-159`) | `createMuseClient` | Register local BB `node_id` on the VM | Noise tunnel |
| Tunnel `POST` | `/api/ping` (`bridge/protocol/api.mjs:173`) | `isSignedIn` | Check VM session liveness (`presence: "active"`) | Noise tunnel |
| Tunnel `GET` | `/api/session/list?include_peer_sidechats=true` (`bridge/protocol/api.mjs:182`) | `listChats` | List Muse side chats | Noise tunnel |
| Tunnel `POST` | `/chat/stream` (`bridge/protocol/api.mjs:220-224`) | `send` | Submit user message (`message`) or attachments (`items`) to `session_id` | Noise tunnel |
| Tunnel `POST` | `/chat/subscribe` (`bridge/protocol/api.mjs:275-287`) | `send` | Stream zstd NDJSON `delta.*`, `task.status`, and `agent.status` events | Noise tunnel |
| Tunnel `GET` | `/chat/history?limit=40&transcript_mode=messages&session_id=…` (`bridge/protocol/api.mjs:187-190`) | `history`, `historyRaw`, `send` | Fetch full `chat_events` and `messages` transcript | Noise tunnel |
| Tunnel `GET` | `/media/raw/<path>` (`bridge/protocol/api.mjs:128-131,199`) | `fetchMedia` | Download generated image bytes (`sandbox://` prefix stripped) | Noise tunnel |

## Gotchas

- `bb plugin rpc call muse <method>` has no `--input` flag; callers must pass `--input-file <path> --json` (`bridge/auto-login.mjs:609`).
- `bootstrapHttps` always returns `DEFAULT_WS` (`wss://hatch.metaaivm.com/v1/noise`) even when the HTML flight context reports a per-VM hostname, keeping the per-VM URL only in `vmGatewayUrl` (`bridge/protocol/gateway.mjs:307-314`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architecture](architecture.md)
- [Muse AI Connector — Overview](overview.md)

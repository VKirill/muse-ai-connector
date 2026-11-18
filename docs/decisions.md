---
title: Architectural Decisions
type: decisions
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: high
tags: [decisions, adr, architecture, protocol, security]
sources:
  - package.json
  - server.ts
  - host.ts
  - version.ts
  - launch-spec.mjs
  - bin/muse-acp.mjs
  - bridge/acp-tools.mjs
  - bridge/json-file.mjs
  - bridge/accounts.mjs
  - bridge/hub-sync.mjs
  - bridge/permissions.mjs
  - bridge/session.mjs
  - bridge/runtime-install.mjs
  - bridge/protocol/api.mjs
  - bridge/protocol/gateway.mjs
  - bridge/protocol/ndjson.mjs
  - tests/acp.test.mjs
  - tests/ui-panel.test.mjs
  - tests/version.test.mjs
---

# Architectural Decisions

Recorded architectural decisions extracted from the codebase and commit history, in reverse chronological order.

## 008. Default 10 parallel slots per account and carry maxParallel in hub sync (active)

**Date:** 2026-11-03

**Context:** Defaulting `maxParallel` to `1` serialized all BB sessions onto one lock unless each account was manually tuned, and `syncAcrossHosts` did not preserve per-account concurrency settings across connected machines (`bridge/accounts.mjs:8`, `bridge/hub-sync.mjs:18-20`).

**Decision:** Set `DEFAULT_MAX_PARALLEL = 10` (overridable per account `1..50` or via `MUSE_MAX_PARALLEL`) and include `maxParallel` in `exportAccount` / `importAccount` payloads (`bridge/accounts.mjs:7-8,179-185`, `host.ts:97,106`, `bridge/hub-sync.mjs:18-20`).

**Status:** active

**Consequences:** New accounts serve up to 10 concurrent chats out of the box without blocking parallel BB threads, and `maxParallel` stays consistent across synced hosts; higher concurrency shares one Muse cloud VM (`bridge/accounts.mjs:316-389`).

**Sources:** `bridge/accounts.mjs:7-8,179-185`, `bridge/hub-sync.mjs:18-20`, `host.ts:97,106`, commit `77bcb91`.

## 007. Keep the bridge as the sole workspace route (active)

**Date:** 2026-11-03

**Context:** Muse cloud VMs could potentially access remote machines over SSH or secondary accounts, creating credential distribution and sandbox boundaries outside BB (`bridge/acp-tools.mjs:320-334`).

**Decision:** Keep the local ACP bridge (`muse-acp` and ```` ```muse-tool ```` blocks in `bridge/acp-tools.mjs`) as the only route to the user's workspace; no SSH keys or extra accounts are provisioned for Muse (`bridge/acp-tools.mjs:311-369`).

**Status:** active

**Consequences:** Every file read, edit, patch, and bash command passes through `resolveSessionPath(cwd, p)` and ACP client capabilities (`fs/read_text_file`, `fs/write_text_file`), preserving workspace isolation at the cost of a round trip per tool batch (`bin/muse-acp.mjs:555-587`, `bridge/acp-tools.mjs:311-317,450-503`).

**Sources:** `bridge/acp-tools.mjs:311-369,450-503`, `bin/muse-acp.mjs:555-587`, commit `4b92cb3`.

## 006. Use atomic writes and exclusive lock files for all JSON stores (active)

**Date:** 2026-11-03

**Context:** Concurrent processes previously crashed on partially written JSON files before `writeJsonAtomic` (`bridge/json-file.mjs:26-36`) or wiped stores on transient parse failures before `readJson` (`bridge/json-file.mjs:59-68`) and exclusive `updateJson` locking (`bridge/json-file.mjs:149-158`).

**Decision:** Centralize state persistence in `bridge/json-file.mjs` using same-directory temp files + `renameSync` (`writeJsonAtomic`), parse-retry loops (`readJson`), and exclusive `<file>.lock` hard-linking with stale PID/age takeover (`updateJson`) (`bridge/json-file.mjs:35-176`).

**Status:** active

**Consequences:** Concurrent sessions and CLI commands serialize safely without truncating state or losing `museChatId` mappings (`bin/muse-acp.mjs:102-117`, `bridge/accounts.mjs:101-111`), at the expense of a small synchronous `Atomics.wait` backoff on lock contention (`bridge/json-file.mjs:12-14,145`).

**Sources:** `bridge/json-file.mjs:35-176`, `bin/muse-acp.mjs:102-117`, `bridge/accounts.mjs:101-111`.

## 005. Dial the Muse gateway with `ws` over HTTP/1.1 and sniff zstd magic bytes (active)

**Date:** 2026-11-03

**Context:** Node's built-in undici `WebSocket` negotiates HTTP/2 over ALPN and receives close code `1006` from `DEFAULT_WS` (`bridge/protocol/gateway.mjs:23`), while `decodeBytes` and `decodeBody` sniff `ZSTD_MAGIC` because Muse VM responses omit `content-encoding: zstd` (`bridge/protocol/gateway.mjs:11-20`, `bridge/protocol/ndjson.mjs:3-20`).

**Decision:** Add `ws` as a runtime dependency to force HTTP/1.1 WebSocket upgrades with `Origin` and Chrome `User-Agent` headers, parse VM context from Next.js flight HTML by object keys (`"authToken"`, `"cvmMigrationInventorySnapshot"`), and detect zstd compression by inspecting `0xfd2fb528` magic bytes (`bridge/protocol/gateway.mjs:186-229,317-328`, `bridge/protocol/ndjson.mjs:3-63`).

**Status:** active

**Consequences:** Normal chat turns, image downloads, and chat history run directly over Noise XX without launching Chrome per turn, leaving Chrome only for sign-in and `401`/`403` fallback (`bin/muse-acp.mjs:287-309`, `bridge/protocol/api.mjs:375-401`).

**Sources:** `bridge/protocol/gateway.mjs:11-20,186-229,317-328`, `bridge/protocol/ndjson.mjs:3-63`, `package.json:38`.

## 004. Embed `PLUGIN_VERSION` as a compile-time literal for standalone host bundles (active)

**Date:** 2026-11-03

**Context:** BB distributes `host.mjs` as a standalone bundled file without copying `package.json`, causing runtime `package.json` reads to fail silently (`version.ts:1-2`).

**Decision:** Store `PLUGIN_VERSION` as a literal in `version.ts`, import it in `host.ts` to drive background `ensureRuntime()` upgrades, and enforce parity with `package.json` and `package-lock.json` via tests (`version.ts:1-3`, `host.ts:10,176-183`, `tests/version.test.mjs:10-19`).

**Status:** active

**Consequences:** Host daemons reliably detect version mismatches and self-install `~/.muse-bridge/runtime/<version>/`, while every version bump must update `version.ts`, `package.json`, and `package-lock.json` together (`tests/ui-panel.test.mjs:81-88`).

**Sources:** `version.ts:1-3`, `host.ts:10,176-183`, `tests/version.test.mjs:10-19`, commit `6c61587`.

## 003. Wrap ACP tool execution in a fenced `muse-tool` text protocol with `[[done]]` (active)

**Date:** 2026-11-03

**Context:** Muse web chats expose no host-side function-calling API to external clients; additionally, Muse models occasionally omit closing fences or omit tool blocks on intermediate turns (`bridge/acp-tools.mjs:206-279`, `bin/muse-acp.mjs:24-27`).

**Decision:** Inject a workspace intro on the first message of a `muse-spark` chat requesting up to `8` ```` ```muse-tool ```` JSON blocks per turn and a trailing `[[done]]` marker on completion (`bridge/acp-tools.mjs:12,236-279,319-384`), scan JSON structurally even when fences are unclosed (`bridge/acp-tools.mjs:137-182`), and nudge blockless replies up to `3` times (`bin/muse-acp.mjs:24-27,528-544`).

**Status:** active

**Consequences:** Any Muse text reply can drive local workspace tools and MCP servers reliably without native tool hooks, at the cost of prompt tokens on turn 1 (`INTRO_BUDGET = 7000`) and extra round trips on nudges (`bridge/acp-tools.mjs:26,319-384`).

**Sources:** `MAX_TOOL_CALLS` (`bridge/acp-tools.mjs:12`), `INTRO_BUDGET` (`bridge/acp-tools.mjs:26`), `scanJsonValue` (`bridge/acp-tools.mjs:137-182`), `parseToolCalls` and `stripDoneMarker` (`bridge/acp-tools.mjs:236-279`), `buildIntro` (`bridge/acp-tools.mjs:319-384`), `MAX_BLOCKLESS_REPLIES` and `NUDGE_MESSAGE` (`bin/muse-acp.mjs:24-27,524-588`). Commits: `db4f0b4`, `7c9c2bc`.

## 002. Force `en-US` locale in Chrome and use language-independent DOM selectors (active)

**Date:** 2026-11-02

**Context:** Non-English Chrome profiles caused Muse UI locators matched on English button/aria labels to time out (`bridge/session.mjs:18-31`).

**Decision:** Launch Playwright Chrome with `locale: "en-US"` and `--lang=en-US`, match the composer via `textarea, [contenteditable="true"]` (`COMPOSER_SELECTOR`) and `[data-testid=hatch-nav-chat]`, and match approval cards against both English and Russian button labels (`bridge/session.mjs:18-31,77-87`, `bridge/permissions.mjs:30-34`).

**Status:** active

**Consequences:** Browser sign-in, fallback sends, and approval automation behave consistently regardless of the host OS or Chrome profile language (`tests/session-options.test.mjs`, `tests/permissions.test.mjs`).

**Sources:** `bridge/session.mjs:18-31,77-87`, `bridge/permissions.mjs:30-34`.

## 001. Register `muse-spark` and `muse-image` models and ignore BB reasoning levels (active)

**Date:** 2026-11-02

**Context:** BB's chat composer sent a default `medium` reasoning effort when opening a new chat, so `server.ts` declares `supportedReasoningEfforts` (`server.ts:302-310`) while `AVAILABLE_MODELS` in `bin/muse-acp.mjs` advertises `muse-spark` and `muse-image` (`bin/muse-acp.mjs:62-65`).

**Decision:** Declare `supportedReasoningEfforts` (`none`..`high`) and `reasoningLevels` on the `muse` provider in `server.ts`, advertise `muse-spark` and `muse-image` from `session/new`, and ignore reasoning parameters inside `muse-acp` (`server.ts:295-343`, `bin/muse-acp.mjs:60-65,645-655`).

**Status:** active

**Consequences:** BB chats open and switch between text/agent mode (`muse-spark`) and picture generation (`muse-image`) without composer errors (`tests/acp.test.mjs:105-124`).

**Sources:** `server.ts:295-343`, `bin/muse-acp.mjs:60-65,645-655`, commit `9fd24b5`.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Muse AI Connector — Overview](overview.md)

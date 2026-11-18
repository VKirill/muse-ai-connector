---
title: Testing
type: testing
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: medium
tags: [testing, node-test, typecheck, fake-driver, fixtures]
sources:
  - package.json
  - tsconfig.json
  - bin/muse-acp.mjs
  - bin/musebridge.mjs
  - tests/acp.test.mjs
  - tests/acp-tools.test.mjs
  - tests/accounts.test.mjs
  - tests/api-client.test.mjs
  - tests/runtime-install.test.mjs
  - tests/ui-layout.test.mjs
  - tests/ui-style.test.mjs
  - tests/ui-grid.test.mjs
  - tests/ui-scroll.test.mjs
  - tests/usage-drift.test.mjs
  - tests/version.test.mjs
---

# Testing

The test suite uses Node's built-in `node:test` runner and `tsc --noEmit`, exercising `muse-acp` and `musebridge` through fake drivers, dependency-injected protocol handlers, and static UI/version contract checks.

## Running checks

Commands configured in `package.json:14-15`:

```sh
npm test
npm run typecheck
node --test tests/acp-tools.test.mjs
```

`npm test` executes `node --test tests/*.test.mjs`, and `npm run typecheck` runs `tsc --noEmit` over `*.ts` and `*.tsx` (`package.json:14-15`, `tsconfig.json:13`). Suites that spawn `bin/musebridge.mjs` or import `bridge/session.mjs`, `bridge/auto-login.mjs`, or `bridge/protocol/gateway.mjs` require `node_modules` (`playwright-core`, `ws`, `zod`, `@get-bb/plugin-sdk`) to be installed (`package.json:35-40`, `tests/accounts.test.mjs:21`).

## What the suites cover

- **Fake ACP driver (`MUSE_BRIDGE_FAKE=1`):** `bin/muse-acp.mjs` swaps in `openFakeSession` when `MUSE_BRIDGE_FAKE=1`, returning replies in sequence from `MUSE_BRIDGE_FAKE_SCRIPT` (defaulting to `"PONG\n[[done]]"`), logging outgoing prompts/attachments to `MUSE_BRIDGE_FAKE_SENT`, and simulating send latency (`MUSE_BRIDGE_FAKE_DELAY_MS`) or interrupted streaming (`MUSE_BRIDGE_FAKE_REPLY_LAG_MS`) (`bin/muse-acp.mjs:16-18,142-278`). Used across `tests/acp.test.mjs`, `tests/acp-tools.test.mjs`, `tests/acp-image.test.mjs`, `tests/acp-cancel.test.mjs`, `tests/acp-mcp.test.mjs`, `tests/acp-skills.test.mjs`, `tests/acp-slots.test.mjs`, and `tests/native-tools.test.mjs`.
- **Fake CLI image/send driver:** `bin/musebridge.mjs` supports `MUSE_BRIDGE_FAKE=1` with `MUSE_BRIDGE_FAKE_HISTORY`, `MUSE_BRIDGE_FAKE_MEDIA`, and `MUSE_BRIDGE_FAKE_SENT` in `cmdImage` and `cmdSend` (`bin/musebridge.mjs:280-308,380-388,433-441`).
- **Account pool & atomic JSON:** `tests/accounts.test.mjs`, `tests/account-slots.test.mjs`, `tests/accounts-export.test.mjs`, and `tests/json-file.test.mjs` isolate state in `/tmp` via `MUSE_BRIDGE_HOME` and test multi-process lock contention (`tests/accounts.test.mjs:23-33`).
- **Wire protocol & API transport:** `tests/protocol-noise.test.mjs` verifies Noise XX against an official cacophony vector, while `tests/protocol-envelope.test.mjs`, `tests/protocol-ndjson.test.mjs`, `tests/ndjson.test.mjs`, `tests/api-client.test.mjs`, `tests/usage.test.mjs`, and `tests/usage-drift.test.mjs` test protobuf framing, zstd sniffing, flight HTML parsing, socket reconnects, and Next-Action drift using mock `fetchImpl` and fake sockets.
- **Host, Hub, UI & static invariants:** `tests/host-call-timeouts.test.mjs` and `tests/ui-panel.test.mjs` boot `server.ts` with a mock `bb` API; `tests/ui-layout.test.mjs`, `tests/ui-style.test.mjs`, `tests/ui-grid.test.mjs`, `tests/ui-scroll.test.mjs`, and `tests/version.test.mjs` assert EN/RU `i18n.ts` key parity, zero hex color literals, CSS grid/scroll rules, and `PLUGIN_VERSION` consistency.
- **DeepSWE relay:** `tests/bench-relay.test.mjs` tests `bench/deepswe/relay.mjs` prompt formatting, `DONE` detection, retry loops, and `round_error` survival with injectable queue/send callbacks.

## How to add a test

1. Create `tests/<area>.test.mjs` importing `node:assert/strict` and `node:test` (`tests/accounts.test.mjs:1,5`).
2. Isolate any disk state by setting `process.env.MUSE_BRIDGE_HOME` to a fresh directory from `fs.mkdtempSync("/tmp/muse-...")` and restoring the prior environment variable in `finally` (`tests/accounts.test.mjs:23-33`).
3. For `muse-acp` end-to-end tests, spawn `bin/muse-acp.mjs` with `MUSE_BRIDGE_FAKE=1` and a JSON reply array in `MUSE_BRIDGE_FAKE_SCRIPT` (`tests/acp.test.mjs:12-48,89-103`).
4. For `bridge/*` unit tests, inject mock `fetchImpl`, `exec`, `run`, or `openSession` functions through the module's options parameter (`tests/usage-drift.test.mjs:42-62`, `tests/runtime-install.test.mjs:31-50`).
5. When touching `app.tsx`, `app.css`, `i18n.ts`, or `version.ts`, verify `tests/ui-layout.test.mjs`, `tests/ui-style.test.mjs`, `tests/ui-grid.test.mjs`, `tests/ui-scroll.test.mjs`, and `tests/version.test.mjs` pass alongside `npm run typecheck`.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Gotchas](gotchas.md)
- [Muse AI Connector — Overview](overview.md)

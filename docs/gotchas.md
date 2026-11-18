---
title: Gotchas
type: gotchas
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: high
tags: [gotchas, reliability, noise, chrome, concurrency]
sources:
  - package.json
  - server.ts
  - host.ts
  - version.ts
  - bin/muse-acp.mjs
  - bridge/protocol/gateway.mjs
  - bridge/protocol/ndjson.mjs
  - bridge/auto-login.mjs
  - bridge/usage.mjs
  - bridge/session.mjs
  - bridge/json-file.mjs
  - bridge/acp-tools.mjs
  - bridge/acp-prompt.mjs
  - bridge/acp-pending.mjs
  - app.tsx
  - tests/accounts.test.mjs
  - tests/version.test.mjs
---

# Gotchas

Sharp edges, protocol traps, and non-obvious runtime constraints verified in the codebase.

## Critical

### Noise server identity is not verified

**Problem:** During the `Noise_XX_25519_AESGCM_SHA256` handshake in `handshake(ws)`, the client completes key exchange with whatever static public key the WebSocket endpoint presents and logs `Noise server identity not verified` to `stderr` (`bridge/protocol/gateway.mjs:375-384`).
**Risk:** Traffic is encrypted against passive observers, but the client does not pin or authenticate the remote Noise static key against a trusted server key.
**Workaround:** Keep account cookies private (`0600`) and treat the warning as an expected transport limitation until static-key pinning is implemented.

`bridge/protocol/gateway.mjs:375-384`

### Both Muse plugins claim provider ID `muse`

**Problem:** `server.ts` registers `MUSE_PROVIDER_ID = "muse"`, which is the same provider ID used by Meta's separate `Muse Code` CLI plugin (`server.ts:207,276-278`).
**Risk:** Installing both plugins on the same BB instance creates a provider ID collision in BB's provider registry.
**Workaround:** Install only one plugin claiming `muse` at a time.

`server.ts:207,276-278`

## High

### Node's built-in WebSocket fails with HTTP/2 ALPN close 1006

**Problem:** `wss://hatch.metaaivm.com/v1/noise` closes with code `1006` if dialed with Node's undici `WebSocket` because undici negotiates HTTP/2 via ALPN. `gateway.mjs` explicitly imports the `ws` package (`defaultSocketFactory`) to force an HTTP/1.1 WebSocket upgrade with `Origin` and Chrome `User-Agent` headers (`bridge/protocol/gateway.mjs:3,317-328`).
**Risk:** Replacing `ws` with global `WebSocket` breaks the direct API transport on every call.
**Workaround:** Always keep `ws` as a runtime dependency and pass `gatewaySocketOptions()` when opening the gateway socket.

`bridge/protocol/gateway.mjs:3,317-328`

### Responses and streams omit `content-encoding: zstd`

**Problem:** Muse VM responses and `/chat/subscribe` streams frequently send zstd-compressed bytes without a `content-encoding` header (`bridge/protocol/ndjson.mjs:13-20,52-63`).
**Risk:** Standard `Content-Encoding` header checks pass compressed binary frames to `JSON.parse` and fail with syntax errors.
**Workaround:** `decodeBody`, `decodeBytes`, and `createStreamDecoder` sniff the 4-byte little-endian `ZSTD_MAGIC` (`0xfd2fb528`) before parsing (`bridge/protocol/ndjson.mjs:3,9-11,55-63`, `bridge/protocol/gateway.mjs:11-20`).

`bridge/protocol/ndjson.mjs:3,9-20,52-63`

### Muse confuses its cloud VM with the user's workspace

**Problem:** Because every Muse account runs on a Meta cloud VM with its own `muse.exec` and `muse.read` tools, Muse attempts to inspect `<cwd>` on its cloud VM (finding nothing) or sends empty assistant messages while running native tools (`bin/muse-acp.mjs:25-26,505-523`, `bridge/acp-tools.mjs:320-334`).
**Risk:** `muse-acp` would misread empty native-tool steps as finished replies or write files to the remote VM instead of `<cwd>`.
**Workaround:** `buildIntro` explicitly states that `<cwd>` lives on the user's machine; `bin/muse-acp.mjs` polls `driver.history` via `waitForAssistantMessage` whenever `result.text` is empty, and nudges blockless replies up to 3 times (`bin/muse-acp.mjs:24-27,505-545`, `bridge/acp-pending.mjs:44-69`).

`bin/muse-acp.mjs:24-27,505-545`, `bridge/acp-tools.mjs:320-334`

### Host-call 30 s default deadline vs. long sign-in and install calls

**Problem:** BB host RPC calls default to a 30-second timeout unless `timeoutMs` is passed (`server.ts:421-455`), whereas `HOST_LOGIN_TIMEOUT_MS` / `ADD_TIMEOUT_MS` allow 11–12 minutes and `HOST_INSTALL_TIMEOUT_MS` allows 10 minutes (`server.ts:127-132`, `host.ts:15-17`).
**Risk:** Omitting `timeoutMs` on `host.call(...)` rejects `addAccount`, `reloginAccount`, `checkAccounts`, `installRuntime`, or `usage` while the subprocess is still running on the host.
**Workaround:** Pass `HOST_LOGIN_TIMEOUT_MS`, `HOST_CHECK_TIMEOUT_MS`, `HOST_INSTALL_TIMEOUT_MS`, or `HOST_USAGE_TIMEOUT_MS` on every slow `host.call` (`server.ts:421-455`).

`server.ts:127-132,421-455`

## Medium

### `host.mjs` ships standalone without `package.json`

**Problem:** BB deploys `host.mjs` as a single bundled file without `package.json` beside it (`version.ts:1-2`).
**Risk:** Reading `package.json` at runtime inside `host.ts` fails or falls back silently, breaking runtime version checks and auto-upgrades.
**Workaround:** Import `PLUGIN_VERSION` from `version.ts` and keep `package.json`, `package-lock.json`, and `version.ts` synchronized (`version.ts:1-3`, `host.ts:10`, `tests/version.test.mjs:10-19`).

`version.ts:1-3`, `host.ts:10`

### Next.js `Next-Action` hash drift breaks usage quota polling

**Problem:** `fetchAccountUsage` (`bridge/usage.mjs:254-264`) sends `DEFAULT_ACTION_ID` (`bridge/usage.mjs:11`) in the `Next-Action` header via `usageHeaders` and `postAction` (`bridge/usage.mjs:69-92`), which returns HTTP `409` when Meta rotates the `fetchSubscriptionAction` hash (`bridge/usage.mjs:117-120`).
**Risk:** Hardcoding one hash permanently breaks the quota meter after a Muse frontend deploy.
**Workaround:** `readUsage` tries the cached ID (`~/.muse-bridge/cache/usage-action.json`), falls back to `DEFAULT_ACTION_ID`, and then crawls `muse.ai` initial and lazy Turbopack chunks (`static/chunks/*.js?dpl=...`) to discover `fetchSubscriptionAction` (`bridge/usage.mjs:117-199,221-248`).

`bridge/usage.mjs:117-199,221-248`

### `sr-only` OTP input in Meta login rejects pointer clicks

**Problem:** Meta's 6-digit OTP verification screen overlays presentation digit boxes on top of a visually hidden `<input class="sr-only">` (`bridge/auto-login.mjs:509`).
**Risk:** Playwright pointer clicks on the code input time out or hit the overlay instead of focusing the backing input.
**Workaround:** `autoLoginAccount` calls `await codeInput.focus()` followed by `await codeInput.fill(code)` (`bridge/auto-login.mjs:509-511`).

`bridge/auto-login.mjs:509-511`

### Missing `node_modules` in clean git worktrees breaks subprocess tests

**Problem:** `tests/*.test.mjs` spawn `bin/musebridge.mjs` and import `playwright-core`, `ws`, `zod`, and `@get-bb/plugin-sdk` (`package.json:35-40`, `tests/accounts.test.mjs:21`).
**Risk:** Running `npm test` in a fresh checkout or worktree without `npm install` fails on module resolution in CLI and transport tests.
**Workaround:** Run `npm install` in the checkout before running `npm test` (see [Testing](testing.md)).

`package.json:35-40`, `tests/accounts.test.mjs:21`

## Low

### `muse-acp` accepts but ignores BB reasoning levels

**Problem:** `server.ts` advertises reasoning levels `none`, `low`, `medium`, and `high` on both `muse-spark` and `muse-image` (`server.ts:303-324,336-343`), even though Muse has no reasoning parameter.
**Risk:** Removing those arrays causes BB's chat composer to fail with HTTP 400 when a user's default reasoning effort is `medium`.
**Workaround:** Keep `supportedReasoningEfforts` and `reasoningLevels` declared in `server.ts` while `muse-acp` ignores the setting (`server.ts:302-324`).

`server.ts:302-324,336-343`

### `bb plugin rpc call` requires `--input-file`

**Problem:** The `bb plugin rpc call` CLI command does not accept an inline `--input` JSON flag (`bridge/auto-login.mjs:609`).
**Risk:** Scripts calling `muse.syncAccounts` or `muse.hosts` with `--input '{...}'` fail.
**Workaround:** Write JSON to a mode `0600` temp file, pass `--input-file <path> --json`, and delete the file in `finally` (`bridge/auto-login.mjs:605-616`).

`bridge/auto-login.mjs:605-616`

<!-- lane-pilot:backlinks -->
## Referenced by

- [Muse AI Connector — Overview](overview.md)

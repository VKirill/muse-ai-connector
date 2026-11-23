---
title: bb-plugin-muse
updated: 2026-11-23
sources:
  - package.json
  - docs/overview.md
  - docs/architecture.md
  - docs/api.md
  - docs/data-model.md
  - docs/conventions.md
  - docs/testing.md
  - docs/gotchas.md
  - docs/decisions.md
---

# bb-plugin-muse

## Identity

- **Package:** `bb-plugin-muse` v0.3.23 (`Apache-2.0`), BB provider ID `muse`, Node.js `>=22` ESM + TypeScript `^5.7.0` (`noEmit`) — see [Overview](docs/overview.md).
- **Dependencies:** `@get-bb/plugin-sdk@0.6.49`, `playwright-core@^1.56.1`, `ws@^8.22.1`, `zod@^4.6.5` — see [Overview](docs/overview.md).
- **Capabilities:** Bridges BB chats (`muse-spark`, `muse-image`), local workspace tools, MCP servers, skills, multi-account slot pools, IMAP OTP auto-login, cross-host cookie sync, and quota tracking — see [Architecture](docs/architecture.md).

## Entry points

- **Hub plugin:** `server.ts` (`plugin()`, `rpcContract`, `collectMergedUsage`) — see [API Reference](docs/api.md) and [BB Provider & ACP Agent](docs/features/bb-provider-and-acp-agent.md).
- **Host daemon:** `host.ts` (`experimental_defineHostEntry`, `hostContract`, `experimental_providerBridge`) — see [API Reference](docs/api.md) and [Settings Panel & i18n](docs/features/settings-panel-and-i18n.md).
- **UI panel & settings:** `app.tsx` (`MusePanel`, `MuseSettings`), `i18n.ts` (`en`/`ru`), `app.css` — see [Settings Panel & i18n](docs/features/settings-panel-and-i18n.md).
- **ACP agent:** `bin/muse-acp.mjs` (`initialize`, `session/new`, `session/set_model`, `session/prompt`, `session/cancel`, `session/close`) — see [BB Provider & ACP Agent](docs/features/bb-provider-and-acp-agent.md).
- **CLI:** `bin/musebridge.mjs` (`doctor`, `chats`, `history`, `send`, `image`, `approve`, `accounts`, `sync`, `login`) — see [CLI & Benchmark](docs/features/cli-and-benchmark.md).
- **Bundled skill:** `skills/muse-connector/SKILL.md` — see [Overview](docs/overview.md).

## Critical invariants

- **Compile-time version pin:** `package.json`, `package-lock.json`, and `version.ts` (`PLUGIN_VERSION`) must stay identical; `host.ts` ships standalone without `package.json` — see [Conventions](docs/conventions.md) and [Gotchas](docs/gotchas.md).
- **Workspace confinement:** Local `muse-tool` file/shell calls must resolve inside `session.cwd` via `resolveSessionPath`; `fs/*` ACP client requests run when `clientCapabilities.fs` enables them — see [BB Provider & ACP Agent](docs/features/bb-provider-and-acp-agent.md).
- **Atomic locked JSON:** Shared state files under `~/.muse-bridge/` (`MUSE_BRIDGE_HOME`) must mutate only via `updateJson` / `writeJsonAtomic` (`0600` for cookies/sync/node files) — see [Data Model](docs/data-model.md) and [Conventions](docs/conventions.md).
- **In-memory cookie sync:** Cookies travel host → hub memory → host during `syncAcrossHosts` and via `stdin` over SSH; never log cookies or pass them in `argv` — see [Account Pool & Auth](docs/features/account-pool-and-auth.md).
- **HTTP/1.1 WebSocket & zstd sniffing:** Gateway connections must use `ws` (never undici `WebSocket`) and sniff `0xfd2fb528` zstd magic bytes — see [Direct API & Browser Transport](docs/features/direct-api-and-browser-transport.md) and [Gotchas](docs/gotchas.md).
- **Approval policy:** Non-monetary Muse approval cards auto-approve (`Always allow`); monetary cards pause for owner action; `Deny` is never clicked — see [Direct API & Browser Transport](docs/features/direct-api-and-browser-transport.md).

## Conventions

- **Plain ESM bridge modules:** `bin/*.mjs` and `bridge/**/*.mjs` use zero-build ESM with JSDoc types; `bridge/runtime-install.mjs` uses Node built-ins only because it bundles into `host.mjs` — see [Conventions](docs/conventions.md).
- **UI styling & i18n:** `app.css` uses `--pk-*` tokens with zero hex literals; all visible strings/ARIA labels in `app.tsx` come from `i18n.ts` with `en`/`ru` key parity — see [Conventions](docs/conventions.md) and [Settings Panel & i18n](docs/features/settings-panel-and-i18n.md).
- **Slot defaults:** Default parallel slots per account is `10` (`1..50` allowed; `auto-login` assigns `20` to new accounts) — see [Account Pool & Auth](docs/features/account-pool-and-auth.md) and [Data Model](docs/data-model.md).

## Common gotchas

- **Noise server identity unverified:** Gateway handshake logs `"Noise server identity not verified"` to `stderr` — see [Gotchas](docs/gotchas.md).
- **Provider ID collision:** Both `bb-plugin-muse` and Meta's `Muse Code` claim provider `muse` — see [Gotchas](docs/gotchas.md).
- **Host RPC 30 s default deadline:** Slow `host.call` operations require explicit `HOST_*_TIMEOUT_MS` — see [API Reference](docs/api.md) and [Gotchas](docs/gotchas.md).
- **Next-Action hash drift & `sr-only` OTP input:** Usage quota fetching crawls Turbopack chunks on `409`; IMAP OTP focuses the hidden input before filling — see [Gotchas](docs/gotchas.md).

## Useful commands

```sh
npm test                                    # run all node:test suites (requires npm install)
npm run typecheck                           # tsc --noEmit on *.ts and *.tsx
MUSE_BRIDGE_FAKE=1 node --test tests/acp.test.mjs
node bin/musebridge.mjs doctor              # verify Chrome, profile dir, and sign-in
```

See [Testing](docs/testing.md) and [CLI & Benchmark](docs/features/cli-and-benchmark.md).

## Where to look next

- [Overview](docs/overview.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api.md)
- [Data Model](docs/data-model.md)
- [Decisions](docs/decisions.md)
- [Gotchas](docs/gotchas.md)
- [Testing](docs/testing.md)
- [Conventions](docs/conventions.md)

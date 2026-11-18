---
title: Muse AI Connector — Overview
type: overview
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: high
tags: [overview, bb-plugin, muse, acp, nodejs]
sources:
  - package.json
  - tsconfig.json
  - server.ts
  - host.ts
  - app.tsx
  - bin/muse-acp.mjs
  - bin/musebridge.mjs
  - bridge/runtime-install.mjs
  - bridge/protocol/gateway.mjs
  - bridge/protocol/noise.mjs
  - bridge/protocol/envelope.mjs
  - bridge/protocol/ndjson.mjs
  - bridge/accounts.mjs
  - bridge/acp-tools.mjs
  - bridge/hub-sync.mjs
  - bridge/session.mjs
  - bridge/auto-login.mjs
  - scripts/install.sh
  - version.ts
---

# Muse AI Connector — Overview

`bb-plugin-muse` registers Meta's `muse.ai` personal assistant as a `muse` ACP provider inside BB, bridging chat prompts, local workspace tools, MCP servers, and skills through signed-in user accounts.

## What it is

Every `muse.ai` account executes on its own Meta cloud VM, and this plugin turns those accounts into a multi-host BB provider without exposing workspace files over SSH (`server.ts:276-345`, `bridge/acp-tools.mjs:319-334`). When a user selects **Muse** in a BB chat, BB launches `muse-acp` on the target machine, acquires a parallel slot on a signed-in account, and forwards the prompt to Muse over the default direct API transport (`bin/muse-acp.mjs:287-297`, `bin/muse-acp.mjs:442-450`).

Because Muse cannot call local BB tools natively, `muse-acp` instructs the `muse-spark` model to emit fenced ```` ```muse-tool ```` JSON blocks, runs those tools locally in the session workspace, and feeds results back until the reply ends with `[[done]]` (`bin/muse-acp.mjs:524-588`). A second model, `muse-image`, generates and downloads images into `<cwd>/muse-images/` (`bin/muse-acp.mjs:366-418`).

To remove manual setup on headless machines, the BB host daemon self-installs a versioned Node runtime under `~/.muse-bridge/runtime/<version>/` (`host.ts:176-183`, `bridge/runtime-install.mjs:177-222`) and distributes account cookies across connected BB hosts through hub memory (`server.ts:399-442`, `bridge/hub-sync.mjs:11-36`).

## Stack

- **Runtime & language:** Node.js `>=22` plain ESM (`.mjs`) for CLI, agent, and bridge modules, plus TypeScript `^5.7.0` (`noEmit`) and React 19 JSX for BB plugin entry points (`package.json:7,18,44`, `tsconfig.json:1-14`).
- **BB plugin SDK:** `@get-bb/plugin-sdk` `0.6.49` is declared under `dependencies` (`package.json:35-36`). Entry points import `defineRpcContract` (`server.ts:1-2`), `experimental_defineHostEntry` and `experimental_providerBridge` (`host.ts:5-6,12`), and `definePluginApp` (`app.tsx:2`).
- **Validation:** `zod` `^4.6.5` for hub/host RPC contracts and plugin setting bounds (`package.json:39`, `server.ts:9-120`, `server.ts:227`, `host.ts:25-115`).
- **Direct API transport:** `ws` `^8.22.1` over HTTP/1.1 with custom `Noise_XX_25519_AESGCM_SHA256` (`node:crypto`), custom protobuf framing, and `node:zlib` zstd decompression (`package.json:38`, `bridge/protocol/gateway.mjs:3,317-328`, `bridge/protocol/noise.mjs:1-12`, `bridge/protocol/envelope.mjs:39-223`, `bridge/protocol/ndjson.mjs:1-21`).
- **Browser automation & login:** `playwright-core` `^1.56.1` driving persistent Google Chrome (`channel: "chrome"`) profiles (`package.json:37`, `bridge/session.mjs:2,24-31`, `bridge/auto-login.mjs:7`).
- **Testing:** Built-in `node --test` runner across `tests/*.test.mjs` and `tsc --noEmit` (`package.json:14-15`).

## Quick start

Run checks (`package.json:14-15`), install local shims (`scripts/install.sh:1-51`), and verify Chrome (`bin/musebridge.mjs:219-239`):

```sh
npm install
npm test
npm run typecheck
bash scripts/install.sh
musebridge doctor
```

## Where to look next

- [Architecture](architecture.md) — system context, container boundaries, key flows, and invariants.
- [API Reference](api.md) — Hub RPC, Host RPC, ACP JSON-RPC, and Muse gateway endpoints.
- [Data Model](data-model.md) — on-disk JSON state, lock files, and IndexedDB cache layout.
- [BB Provider & ACP Agent](features/bb-provider-and-acp-agent.md) — `muse-acp` tool loop, MCP/skill bridging, and `muse-image`.
- [Account Pool & Auth](features/account-pool-and-auth.md) — slots, IMAP OTP auto-login, cookie sync, and usage quotas.
- [Direct API & Browser Transport](features/direct-api-and-browser-transport.md) — Noise XX WebSocket tunnel, Chrome fallback, and approval cards.
- [Settings Panel & i18n](features/settings-panel-and-i18n.md) — BB UI panel, EN/RU localization, and runtime self-install.
- [CLI & Benchmark](features/cli-and-benchmark.md) — `musebridge` CLI and DeepSWE pilot kit.
- [Conventions](conventions.md), [Testing](testing.md), [Decisions](decisions.md), [Gotchas](gotchas.md).

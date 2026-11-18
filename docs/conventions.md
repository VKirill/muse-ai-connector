---
title: Conventions
type: conventions
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: high
tags: [conventions, typescript, esm, css, i18n]
sources:
  - package.json
  - tsconfig.json
  - server.ts
  - host.ts
  - app.tsx
  - app.css
  - i18n.ts
  - version.ts
  - bin/musebridge.mjs
  - bridge/accounts.mjs
  - bridge/auto-login.mjs
  - bridge/cookies.mjs
  - bridge/hub-sync.mjs
  - bridge/json-file.mjs
  - bridge/acp-tools.mjs
  - bridge/runtime-install.mjs
  - bridge/sync.mjs
  - bridge/usage.mjs
  - bridge/protocol/api.mjs
  - bridge/protocol/gateway.mjs
  - tests/ui-grid.test.mjs
  - tests/ui-layout.test.mjs
  - tests/ui-style.test.mjs
  - tests/version.test.mjs
---

# Conventions

The project uses TypeScript ESM for BB plugin entry points, zero-build plain `.mjs` modules for the self-installed bridge runtime, atomic JSON persistence, and CSS custom-property theming.

## Directory and module split

- **Root entry files (`.ts` / `.tsx`):** `server.ts`, `host.ts`, and `app.tsx` (`package.json:28-30`) alongside `i18n.ts`, `usage-format.ts`, `relogin-summary.ts`, and `version.ts` match the `include` glob (`tsconfig.json:13`). Type checking runs `tsc --noEmit` (`package.json:15`, `tsconfig.json:9`).
- **Bridge and CLI runtime (`.mjs`):** `bin/*.mjs` and `bridge/**/*.mjs` are plain ES modules with JSDoc `@typedef` / `@param` types and zero TypeScript compilation step so `~/.muse-bridge/runtime/<version>/` runs directly under Node `>=22` (`package.json:7,18`, `bridge/runtime-install.mjs:131-133,177-222`).
- **Node-only dependencies in `bridge/runtime-install.mjs`:** Because `host.ts` bundles `bridge/runtime-install.mjs` into `host.mjs`, `bridge/runtime-install.mjs` imports only Node built-in modules (`node:child_process`, `node:fs`, `node:path`, `node:util`) (`host.ts:8-9`, `bridge/runtime-install.mjs:1-7`).
- **Standalone vs. bundled imports in `app.tsx`:** `app.tsx` imports `server.ts` only via `import type` and duplicates `USAGE_TIMEOUT_MS = 45000` locally so the frontend bundle never pulls in server code (`app.tsx:6,14-16`).

## Naming and error conventions

- **Typed error codes:** Internal helpers create `Error` instances with a `.code` string property (`codedError` / `toolError` / `authError`) so callers switch on `err.code` instead of parsing messages (`bridge/accounts.mjs:24-28`, `bridge/acp-tools.mjs:103-107`, `bridge/protocol/gateway.mjs:28-39`).
- **Account IDs:** Labels are slugified to lowercase `[a-z0-9-]+` with `-2`, `-3`, ... suffixes on collision (`bridge/accounts.mjs:57-73`).
- **Direct CLI invocation guard:** `bin/musebridge.mjs` guards `main(process.argv)` behind `invokedDirectly()` using `fs.realpathSync` so tests can import and unit-test exported command handlers (`cmdAccountsRefresh`, `cmdAccountsUsage`, `cmdAccountsAutoLogin`) without spawning a subprocess (`bin/musebridge.mjs:587,677,780,1024-1039`).
- **Dependency injection in bridge functions:** Network, filesystem, process, and Playwright drivers accept optional `deps` / `fetchImpl` / `exec` / `run` parameters (`bridge/usage.mjs:254`, `bridge/auto-login.mjs:247,352`, `bridge/sync.mjs:103`, `bridge/runtime-install.mjs:177`) for deterministic unit tests.

## State and security patterns

- **Private file permissions:** Directories holding credentials (`accounts/<id>/`) are `chmod 0o700`, and sensitive files (`cookies.json`, `node.json`, `sync.json`) are written with mode `0o600` (`bridge/cookies.mjs:16-34`, `bridge/protocol/api.mjs:40-45`, `bridge/sync.mjs:46,59`).
- **Atomic read-modify-write:** All shared JSON files (`accounts.json`, `sessions.json`, `sync.json`, `usage-action.json`) use `writeJsonAtomic` and `updateJson` (`bridge/json-file.mjs:35-176`).
- **Secret isolation:** Passwords and cookie arrays travel on `stdin` (`accounts import`, `accounts auto-login --password-stdin`, `ssh ... musebridge accounts import`) or in memory (`syncAcrossHosts`), never in `argv` or logs (`bin/musebridge.mjs:631-665,784-826`, `bridge/sync.mjs:68-116`, `bridge/hub-sync.mjs:4,11-36`).

## UI, CSS, and i18n conventions

- **Pokecut CSS tokens (`app.css`):** Components scope variables under `[data-bb-plugin="muse"]` reading `--pk-*` tokens with semantic fallbacks (`--muted`, `--card`, `--primary`, `--destructive`); raw hex color literals (`#...`) and `var(--spacing)` are forbidden and tested (`app.css:1-27`, `tests/ui-style.test.mjs:8-15`, `tests/ui-grid.test.mjs:21-27`).
- **Strict i18n key parity (`i18n.ts`, `app.tsx`):** Every visible string, `aria-label`, `title`, and `placeholder` in `app.tsx` comes from `t(key, vars)` in `i18n.ts`, and `en` and `ru` objects share identical key sets (`i18n.ts:3-183`, `tests/ui-layout.test.mjs:114-139`).

## Version synchronization

- **`PLUGIN_VERSION` parity:** `package.json` (`version`), `package-lock.json` (`version` and `packages[""].version`), and `version.ts` (`PLUGIN_VERSION`) must carry the exact same `x.y.z` string (`version.ts:1-3`, `tests/version.test.mjs:10-19`, `tests/ui-layout.test.mjs:141-148`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Muse AI Connector — Overview](overview.md)

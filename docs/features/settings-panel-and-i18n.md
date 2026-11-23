---
title: Settings Panel and i18n
type: component
created: 2026-11-18
updated: 2026-11-23
status: active
confidence: medium
tags: [ui, react, i18n, host, runtime-install, pokecut]
sources:
  - app.tsx
  - app.css
  - i18n.ts
  - relogin-summary.ts
  - usage-format.ts
  - host.ts
  - server.ts
  - bridge/runtime-install.mjs
  - version.ts
  - tests/ui-style.test.mjs
  - tests/ui-grid.test.mjs
  - tests/ui-layout.test.mjs
---

# Settings Panel and i18n

Provides the BB plugin settings summary, three-tab management panel (`Accounts`, `Machines`, `Add account`), EN/RU localization, and background per-host runtime self-installation.

## Purpose

`app.tsx`, `app.css`, `i18n.ts`, `relogin-summary.ts`, and `usage-format.ts` implement BB's plugin UI (`navPanel` `"muse"` and `settingsSection` `"muse-accounts"`) (`app.tsx:898-912`), while `host.ts`, `server.ts`, and `bridge/runtime-install.mjs` automatically build `~/.muse-bridge/runtime/<version>/` on every connected macOS/Linux host (`server.ts:236-269`, `host.ts:176-183`, `bridge/runtime-install.mjs:177-222`).

## How it works

1. **Runtime warm-up and self-install:** `server.ts` starts background service `runtime-warmup`, calling `host.call("status", {})` on every connected host at startup and every `10` minutes (`WARMUP_INTERVAL_MS`) (`server.ts:239-269`). On each host, `ensureRuntime()` checks `runtimeStatus` and, if `dev` is unset and `installed` is false or `version !== PLUGIN_VERSION` (and `platform !== "win32"`), calls `installRuntime` (`host.ts:176-183`).
2. **Runtime build (`installRuntime`):** Downloads `https://codeload.github.com/VKirill/muse-ai-connector/tar.gz/refs/tags/v<version>` (or copies `dir:<path>` in local/test runs excluding `.git`, `.bb`, `node_modules`, `bench/runs`), runs `npm install --omit=dev --no-audit --no-fund` in a `.tmp-<pid>` directory, atomically renames to `~/.muse-bridge/runtime/<version>`, updates the `current` symlink, writes `~/.muse-bridge/bin/musebridge` and `muse-acp` shims, and prunes versions beyond the newest `2` (`KEEP_VERSIONS = 2`) (`bridge/runtime-install.mjs:11-26,114-222`).
3. **Panel navigation & host loading:** `useMuseHosts()` loads `rpc.call("hosts", {})`, sorting hosts with Chrome (`chromeFound === true`) first (`server.ts:383`, `app.tsx:439-487`). `SideNav` switches via `nav.toPluginPanel("muse", { subPath })` between `""` (`AccountsPage`), `"machines"` (`MachinesPage`), and `"add"` (`AddAccountPage`) (`app.tsx:543-570,813-896`).
4. **Accounts view & usage meter:** `mergedAccounts` combines identical account IDs across hosts (`status === "signed_in"` wins, `max` takes max, `lastUsedAt` takes latest) (`app.tsx:85-102`). `AccountsPage` calls `rpc.call("usage", {})` with a `45` s UI timeout (`USAGE_TIMEOUT_MS`), rendering plan, weekly percentage bar, localized reset date (`formatUsageReset`), extra tokens (`formatExtraTokens`), parallel slot count, per-machine status chips, and `Sign in again`, `Check`, `Copy to all machines`, and `Remove` actions (`app.tsx:203-437,572-676`).
5. **Machines & Add account views:** `MachinesPage` displays per-host runtime, Chrome, `musebridge`, `muse-acp`, `problems[]`, account `busy/max` rows, and an `Install` button when runtime is missing (`app.tsx:113-201,678-706`). `AddAccountPage` filters connected Chrome hosts (`disabled={!h.connected || !h.status?.chromeFound}`), submits `addAccount`, and reports synced host counts via `addSuccessText` (`app.tsx:67-75,708-811`).

### Modes and states

| View / State | Condition | UI / Host Behaviour | Failure Handling |
|---|---|---|---|
| Locale detection (`detectLocale`) | `<html lang>`, `data-pk-lang`, or Cyrillic sidebar with `bb-plugin-ru:enabled` (`i18n.ts:190-226`) | Translates `t()` strings (`i18n.ts:228-234`) and formats `formatUsageReset` / `formatExtraTokens` (`usage-format.ts:18-40`) | Returns `"en"` fallback (`i18n.ts:213-226`) |
| Dev runtime override | `MUSE_RUNTIME_DEV` env or `~/.muse-bridge/bin/.dev` file (`bridge/runtime-install.mjs:28-38`) | Shims execute `$target/bin/<tool>.mjs` and `ensureRuntime()` skips auto-install (`host.ts:179`, `bridge/runtime-install.mjs:126-130`) | `readStatus` reports `bridgeVersion: "dev"` (`host.ts:216`) |
| Windows host | `process.platform === "win32"` (`host.ts:177,222,259`) | Skips self-install; `MachineCard` shows `runtimeUnsupported` (`app.tsx:154-155`) | `installRuntime` returns `{ ok: false, error: "Windows is not supported" }` (`bridge/runtime-install.mjs:180`) |
| Failed `npm install` | Non-zero exit from `npm install --omit=dev` (`bridge/runtime-install.mjs:204-208`) | Removes `.tmp-<pid>` directory and keeps previous `current` runtime (`bridge/runtime-install.mjs:211-214`) | Displays last 5 lines of stderr (`runtime.error`) in `MachineCard` (`host.ts:168`, `app.tsx:172`) |

## Business rules

- **Zero hardcoded colors or spacing regressions:** `app.css` scopes all variables under `[data-bb-plugin="muse"]` using `--pk-*` tokens (`--muse-gap: 16px`, `--muse-pad: 24px`, `--muse-card-pad: 20px`) and zero hex color literals (`app.css:1-27`, `tests/ui-style.test.mjs:10-16`, `tests/ui-grid.test.mjs:21-27`).
- **Complete localization parity:** Every JSX visible string and `aria-label`/`title`/`placeholder` in `app.tsx` uses `t()`, and `en` and `ru` dictionaries share identical keys (`i18n.ts:3-183`, `tests/ui-layout.test.mjs:114-139`).
- **Localized usage fallback:** `formatUsageReset` and `formatExtraTokens` render raw English Muse strings (`periodLabel`, `extraTokensLeftLabel`) only when `locale === "en"` and compute numeric dates/percentages for `"ru"` (`usage-format.ts:18-40`).
- **Relogin host selection:** `pickReloginHost` chooses a connected Chrome host where the account is `signed_out` first, otherwise the first connected Chrome host (`app.tsx:59-65`).

## Public API

| Export | File:Line | Purpose |
|---|---|---|
| `default` (`definePluginApp`) | `app.tsx:898-912` | Registers `navPanel` (`"muse"`) and `settingsSection` (`"muse-accounts"`) |
| `detectLocale`, `t`, `reloginSummary` | `i18n.ts:213-256` | Locale detection, template interpolation, and relogin sync status formatting |
| `formatUsageReset`, `formatExtraTokens` | `usage-format.ts:18-40` | Locale-aware reset date and extra-token percentage formatters |
| `devOverride`, `runtimeStatus`, `installRuntime` | `bridge/runtime-install.mjs:28-54,177-222` | Runtime status inspection, `.dev` override lookup, and tarball/dir installation |
| `default` (`experimental_defineHostEntry`), `experimental_providerBridge` | `host.ts:12,251-339` | Host daemon RPC handlers and ACP provider bridge re-export |
| `PLUGIN_VERSION` | `version.ts:3` | Compile-time plugin version literal (`"0.3.23"`) |

## Gotchas

- `useLocale` polls `MutationObserver` on `<html lang>` / `data-pk-lang` plus timers at `500`, `2000`, and `5000` ms because BB's Russifier plugin may mutate sidebar labels after initial mount (`app.tsx:18-36`, `i18n.ts:198-211`).
- `reloginSummary` defaults `locale` to `"en"` when called without a third argument (`i18n.ts:238-242`, `app.tsx:341`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architecture](../architecture.md)
- [Muse AI Connector — Overview](../overview.md)

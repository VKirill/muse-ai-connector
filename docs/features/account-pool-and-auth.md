---
title: Account Pool and Auth
type: component
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: medium
tags: [accounts, slots, locks, auto-login, imap, cookies, sync, usage]
sources:
  - bridge/accounts.mjs
  - bridge/cookies.mjs
  - bridge/auto-login.mjs
  - bridge/hub-sync.mjs
  - bridge/session.mjs
  - bridge/sync.mjs
  - bridge/usage.mjs
  - server.ts
  - host.ts
---

# Account Pool and Auth

Manages registered Muse accounts, concurrent chat slots (`1..50`), Chrome and automated IMAP OTP login, multi-host/SSH cookie synchronization, and plan quota fetching.

## Purpose

`bridge/accounts.mjs` schedules prompts across signed-in Muse accounts using atomic slot locks (`bridge/accounts.mjs:193-389`), `bridge/auto-login.mjs` automates Meta email OTP sign-in via Chrome and TLS IMAP (`bridge/auto-login.mjs:140-592`), `bridge/hub-sync.mjs` and `bridge/sync.mjs` distribute cookies across BB hosts and standalone SSH machines (`bridge/hub-sync.mjs:11-36`, `bridge/sync.mjs:103-148`), and `bridge/usage.mjs` reads weekly limits and extra token balances over HTTPS (`bridge/usage.mjs:254-264`).

## How it works

1. **Account registration & selection:** `addAccount(label)` creates a unique lowercase `id` and profile directory (`~/.muse-bridge/profiles/<id>/`) with status `"unknown"` (`bridge/accounts.mjs:206-228`). `pickAccount()` filters `signed_in` accounts (falling back to `unknown` only if no `signed_in` accounts are free), checks `!isLocked(id)`, and sorts by fewest `busySlots(id)` then oldest `lastUsedAt` (`bridge/accounts.mjs:365-389`).
2. **Slot acquisition:** `acquire(id)` attempts exclusive creation (`flag: "wx"`) of slot `0` (`locks/<id>.lock`) through `maxParallel - 1` (`locks/<id>.<n>.lock`), reclaiming locks whose `pid` is dead or whose timestamp exceeds `STALE_LOCK_MS` (`30` min) (`bridge/accounts.mjs:6,38-45,137-143,316-359`).
3. **Interactive or IMAP OTP sign-in:**
   - Interactive sign-in (`accounts add` / `accounts login`) launches visible Chrome (`headless: false`) via `session.waitForSignIn()` (up to `10` min), sets `"signed_in"`, and exports `muse.ai` + `auth.meta.com` cookies (`bridge/session.mjs:9,131-139,258-260`).
   - Automated sign-in (`autoLoginAccount`) resolves the IMAP host (`resolveImapHost`), snapshots `UIDNEXT - 1` over TLS port `993` (`queryImapOtp`), opens Chrome to `muse.ai`, submits email, polls IMAP (`waitForImapOtp`, default `90` s timeout / `2` s poll) for a 6–8 digit code with `UID >= minUid`, focuses the hidden `sr-only` input, fills first/last/birthday if Meta prompts for new profile creation, saves `0600` cookies, pushes SSH sync targets, and triggers BB Hub `muse.syncAccounts` (`bridge/auto-login.mjs:17-20,57-237,352-618`).
4. **Cross-host cookie sync:** `syncAcrossHosts` calls `exportAccount` on the source host (`id`, `label`, `cookies`, optional `maxParallel`) and calls `importAccount` on every other connected host with an installed or dev runtime, holding cookies only in hub memory (`server.ts:387-443`, `bridge/hub-sync.mjs:11-36`). Standalone machines in `sync.json` receive cookies on `stdin` via `sshRun` (`bridge/sync.mjs:68-88`) called by `syncAccount` with `ssh -o BatchMode=yes` (`bridge/sync.mjs:103-118`).
5. **Quota & usage fetching:** `fetchAccountUsage` POSTs `[{"includeAgreement":true}]` with `Next-Action` to `https://muse.ai/`, caches results in memory for `5` minutes (`CACHE_TTL_MS`), and falls back through `DEFAULT_ACTION_ID` and Turbopack JS chunk discovery (`discoverActionId`) when Meta rotates the server-action hash (`bridge/usage.mjs:11-15,117-264`). `collectMergedUsage` deduplicates accounts across hosts so each unique account is queried once (`server.ts:156-205`).

### Modes and variants

| Feature / Mode | Input / Source | Behaviour | Failure Handling |
|---|---|---|---|
| `maxParallel` resolution | `account.maxParallel` → `MUSE_MAX_PARALLEL` → `10` (`bridge/accounts.mjs:8,179-185`) | Caps concurrent slots at `MAX_PARALLEL_CAP` (`50`); `setMaxParallel` rejects outside `1..50` (`bridge/accounts.mjs:7,282-294`) | `pickAccount` throws `no_free_account` when every account's slots are busy (`bridge/accounts.mjs:380-382`) |
| `auto-login --batch` | Lines `<email> <password> [mailbox: domain]` (`bridge/auto-login.mjs:78-97`) | Registers new accounts with `defaultNewMaxParallel = 20` (`bridge/auto-login.mjs:323-336`) | Aborts immediately with `captcha_blocked` or `region_waitlist` without bypassing challenges (`bridge/auto-login.mjs:395-397,542-548`) |
| `auto-login` Env Catalog | `bb env-catalog list --kind login --json` (`bridge/auto-login.mjs:247-293`) | Matches registered emails, `MUSE_MAIL_*` names, or `"muse"` tags; reads credentials into memory only | Skips entries without passwords; CLI exits `1` listing failed rows |
| `syncAccounts` / `sync` | Hub RPC (`server.ts:433-443`) vs. SSH (`bridge/sync.mjs:103-148`) | Hub syncs `cookies` + `maxParallel`; SSH sync pipes `cookies` array via `stdin` | One failing host/target records an error row and does not stop remaining hosts (`bridge/hub-sync.mjs:23-35`, `bridge/sync.mjs:109-117`) |

## Business rules

- **Unique ID generation & migration:** `slugify` and `uniqueId` derive account IDs with `-2` suffixes on collision (`bridge/accounts.mjs:57-73`), and `migrateDefaultIfNeeded` migrates an existing `profiles/default` directory into `"default"` (`bridge/accounts.mjs:75-94`).
- **Cookie matching (`cookieHeader`):** Sends only cookies whose `expires` is unset/future, whose `domain` matches exact or `.domain` suffix, whose `path` prefixes the URL path, and whose `secure` flag matches `https:` (`bridge/cookies.mjs:48-87`).
- **Built-in IMAP host map:** `resolveImapHost` maps `mail.com`/`email.com`, `gmx.com`/`gmx.net`, `gmail.com`/`googlemail.com`, `yandex.ru`/`yandex.com`/`ya.ru`, `outlook.com`/`hotmail.com`/`live.com`, `yahoo.com`, `icloud.com`/`me.com`, and `purelymail.com`, defaulting unknown domains to `imap.<domain>` (`bridge/auto-login.mjs:22-39,57-68`).
- **Never bypass anti-bot or regional gates:** `inspectPageState` scans URL, title, body text, and iframe `src` for CAPTCHA markers (`captcha_blocked`) and `autoLoginAccount` checks for `Muse isn't available in your country` (`region_waitlist`), throwing immediately and setting status `signed_out` on waitlist (`bridge/auto-login.mjs:304-321,395-397,529-548`).

## Public API

| Export | File:Line | Purpose |
|---|---|---|
| `listAccounts`, `addAccount`, `removeAccount`, `setStatus`, `touch`, `setMaxParallel`, `maxParallelOf`, `busySlots`, `isLocked`, `acquire`, `pickAccount` | `bridge/accounts.mjs:193-389` | Account registry CRUD, slot lock acquisition, and load-balanced account selection |
| `cookiesPath`, `nodeIdPath`, `saveCookies`, `loadCookies`, `cookieHeader` | `bridge/cookies.mjs:7-87` | Private `0600` cookie persistence and RFC-style request header filtering |
| `resolveImapHost`, `parseCredentialLines`, `extractOtpFromImapFetch`, `queryImapOtp`, `waitForImapOtp`, `loadCredentialsFromEnvCatalog`, `autoLoginAccount`, `syncBbHubAccounts` | `bridge/auto-login.mjs:57-618` | Credential parsing, TLS IMAP OTP polling, Playwright login, and BB hub sync trigger |
| `syncAcrossHosts` | `bridge/hub-sync.mjs:11-36` | Hub-side in-memory cookie + `maxParallel` export/import loop |
| `syncTargetsPath`, `listTargets`, `addTarget`, `removeTarget`, `syncAccount`, `syncAll`, `syncIfTargets` | `bridge/sync.mjs:17-148` | SSH `sync.json` management and `BatchMode` cookie push |
| `DEFAULT_ACTION_ID`, `fetchAccountUsage` | `bridge/usage.mjs:11,254-264` | Next-Action subscription quota reader with Turbopack chunk discovery |
| `collectMergedUsage` | `server.ts:156-205` | Deduplicated multi-host usage aggregation with `USAGE_TIMEOUT_MS` (`45` s) |

## Gotchas

- `sync.mjs` (`syncAccount`) sends only the `cookies` JSON array to remote SSH hosts (`bridge/sync.mjs:106-111`), whereas `hub-sync.mjs` (`syncAcrossHosts`) sends `{ id, label, cookies, maxParallel }` (`bridge/hub-sync.mjs:13-20`).
- `auto-login` assigns `defaultNewMaxParallel = 20` to newly registered email accounts (`bridge/auto-login.mjs:323,333`), whereas `addAccount` alone leaves `maxParallel` unset so `DEFAULT_MAX_PARALLEL = 10` applies (`bridge/accounts.mjs:8,179-185,215-223`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architecture](../architecture.md)
- [Muse AI Connector — Overview](../overview.md)

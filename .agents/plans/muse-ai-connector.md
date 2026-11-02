---
title: Muse AI connector (BB provider plugin)
status: building
started: 2026-11-02
updated: 2026-11-02
---

# Muse AI connector

## Goal
Pick **Muse** in a BB chat: the prompt runs in a Muse side chat of one of the owner's signed-in
Muse accounts, the reply streams back into BB. Tasks spread over several accounts. The owner signs
in to each account once in a Chrome window the connector opens.

Contract of the site: [muse-recon.md](muse-recon.md) (read it first).

## Architecture

```
BB chat ──ACP stdio──▶ bin/muse-acp.mjs ──▶ bridge/pool.mjs (pick account, lock)
                                          └▶ bridge/session.mjs (playwright-core, persistent Chrome profile per account)
                                                 ├ write: composer textbox → insertText → Enter
                                                 └ read:  IndexedDB hatch-chat-cache (side-transcripts) + DOM busy signal
bin/musebridge (CLI): doctor | chats | history | send | accounts add|list|remove
server.ts / host.ts / app.tsx: BB plugin (provider "Muse", settings + accounts status, EN+RU)
```

- Runtime: Node 22 ESM `.mjs` with JSDoc types, tests with `node --test` (same as
  `/Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-zcode`). Only runtime dependency of the
  bridge: `playwright-core` (uses the installed Google Chrome, `channel: "chrome"`).
- State dir: `~/.muse-bridge/` (override `MUSE_BRIDGE_HOME`): `accounts.json`, `profiles/<accountId>/`
  (Chrome user data dir), `locks/<accountId>.lock`, `sessions.json` (BB session → account + Muse session_id).
  Nothing of it goes into git; no cookie or token is ever read, logged or copied.
- Pure logic (parsing cache records, deciding "reply done", picking an account) lives in modules
  with no browser import, so tests run on fixtures without Chrome.

## Reference plugins (read, do not copy blindly)
- `/Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-zcode` — UI-driven provider: `server.ts`
  (`bb.providers.register`, settings), `host.ts`, `app.tsx`, `bin/zcode-acp` + `bin/zcode-acp.mjs` (ACP agent over stdio).
- `/Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-devin/server.ts` — minimal ACP provider declaration.
- UI: `/Users/vechkasov/Documents/BB-сервис/docs/DESIGN.md`, `/Users/vechkasov/Documents/BB-сервис/docs/design/pokecut-plugin.css`,
  i18n pattern `/Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-md-editor/i18n.ts` (if missing, the md-editor/markdown-pro plugin folder).

## Tasks
1. `muse-bridge-core` — **done** 2026-11-02, run `lprun_adae76e942f24d348acd60f06532e40c` (merge `ee1809f`) — package, session driver, cache parser, CLI for one account.
2. `muse-account-pool` — **done** 2026-11-02 (as `muse-account-pool.2`), run `lprun_adae76e942f24d348acd60f06532e40c` (merge `1a104bc`) — accounts.json registry, locks, pick, `accounts add|list|remove|check` with the Chrome sign-in window.
3. `muse-acp-provider` — **done** 2026-11-02, run `lprun_adae76e942f24d348acd60f06532e40c` (merge `12e694a`) — `muse-acp` ACP agent over stdio + provider "Muse" registered in BB, streaming into BB chat.
4. `muse-settings-ui` — **done** 2026-11-02 (as `muse-settings-ui.2`), run `lprun_adae76e942f24d348acd60f06532e40c` (merge `2c4377e`) — settings/status screen EN+RU (Pokecut), README EN+RU.
5. `muse-locale-fix.2` — **done** 2026-11-02, run `lprun_adae76e942f24d348acd60f06532e40c` (merge `a965318`) — Chrome launches force `en-US`, language-independent `COMPOSER_SELECTOR`, exported `BUSY_TEXTS`; fixes the live send failure on a Russian-locale profile (found during the live smoke).

## History
### 2026-11-02
- Run `lprun_adae76e942f24d348acd60f06532e40c` shipped all four build tasks: `muse-account-pool.2` (merge `1a104bc`), `muse-acp-provider` (merge `12e694a`), `muse-settings-ui.2` (merge `2c4377e`); `muse-bridge-core` landed earlier in the same run (`ee1809f`). `npm test` green (26 pass) + `tsc --noEmit` clean at merge head `2c4377e`.
- Still open (not code): owner live smoke (sign-in + real send), public repo `VKirill/muse-ai-connector`, `gitnexus analyze`, hub install, registry + journal entry.
- Live smoke surfaced a locale bug (Russian profile: composer labelled `Сообщение`, send timed out) → `muse-locale-fix.2` merged (`a965318`): `launchOptions()` forces `en-US`, `COMPOSER_SELECTOR` replaces the role/name locator, `BUSY_TEXTS` exported (kept English-only — the UI is forced to en-US). `npm test` green (30 pass) + `tsc --noEmit` clean at merge head `a965318`. Live re-send still pending.

## Limits (say them in README)
UI-driven: breaks when Muse changes its page or cache schema (schemaVersion 4 checked, a mismatch is a clear error).
One Chrome profile per account; accounts run in parallel, one prompt at a time per account.

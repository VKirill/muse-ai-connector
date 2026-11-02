---
title: Muse AI connector (BB provider plugin)
status: building
started: 2026-11-02
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
1. `muse-bridge-core` — package, session driver, cache parser, CLI for one account.
2. `muse-account-pool` — several accounts, sign-in window, pick + lock, status.
3. `muse-acp-provider` — ACP agent + BB plugin provider registration, streaming.
4. `muse-settings-ui` — settings/status screen EN+RU, Pokecut, README.

Then: public repo `VKirill/muse-ai-connector`, `gitnexus analyze`, install on the hub, registry + journal.

## Limits (say them in README)
UI-driven: breaks when Muse changes its page or cache schema (schemaVersion 4 checked, a mismatch is a clear error).
One Chrome profile per account; accounts run in parallel, one prompt at a time per account.

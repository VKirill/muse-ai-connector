---
title: Muse AI connector (BB provider plugin)
status: building
started: 2026-11-02
updated: 2026-11-03
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
6. `muse-provider-models` — **done** 2026-11-02, run `lprun_adae76e942f24d348acd60f06532e40c` (merge `d1852a4`) — ACP `session/new` advertises `muse-spark` and `session/set_model` is accepted; provider accepts BB reasoning levels `none–high` (fixes HTTP 400 on new Muse chats); plugin 0.1.1.
7. `muse-acp-prompt-fix` — **done** 2026-11-03, run `lprun_adae76e942f24d348acd60f06532e40c` (merge `8f40445`) — ACP sends only the user's words (`bridge/acp-prompt.mjs` strips BB `<system_instructions>`/`<system-reminder>`), keeps one Muse chat per BB thread (`onChatId` saves the id as soon as it exists) and flushes an interrupted turn's reply before the next prompt.
8. `muse-acp-pending-wait` — **done** 2026-11-03, run `lprun_adae76e942f24d348acd60f06532e40c` (merge `d0132dc`) — the interrupted turn's pending reply is polled until it finishes (`bridge/acp-pending.mjs`, `MUSE_PENDING_WAIT_MS`) instead of read once, so real Muse's still-streaming reply reaches BB before the next prompt.

## History
### 2026-11-03
- `muse-acp-pending-wait` merged (`d0132dc`): `waitForPendingReply` polls chat history until the assistant reply after the last user message is complete (retries failed reads, `""` on timeout), `streamPendingReply` streams only the undelivered remainder; fake driver gained `MUSE_BRIDGE_FAKE_REPLY_LAG_MS` for realistic cancels mid-reply, `tests/acp-pending.test.mjs` 3 tests. The plan's `bridge/session.mjs` chat-id-before-cancel reorder was dropped. `npm test` green (51 pass) + `tsc --noEmit` clean at merge head `d0132dc`.
- `muse-deepswe-pier-agent.2` merged (`bb01164`): first try wrote into the main checkout instead of the task worktree and was rejected; retry landed `bench/deepswe/muse_agent.py` on `pier.agents.base.BaseAgent` (fixes the `install_spec` AttributeError on ovh-main), README updated, `bench/deepswe/__pycache__/` untracked. `npm test` green (51 pass) + `tsc --noEmit` clean at merge head `bb01164`. All build tasks of this run are done; live re-check on the owner's thread and the ovh pilot remain.
- Owner report on a live BB chat (thread thr_mv2ft9kxgd, provider Muse): BB's ~184 KB `<system_instructions>` block was typed into Muse, and after a `session/cancel` mid-reply the already-written Muse reply never reached BB and the thread drifted across three Muse chats. `muse-acp-prompt-fix` merged (`8f40445`): `bridge/acp-prompt.mjs` strips system blocks (empty → short note, no Chrome launch), `session.send` takes an `onChatId` callback so `sessions.json` holds the chat id from the moment the URL carries it, and a cancelled turn's pending reply is read from the chat and streamed to BB before the next prompt (fake driver gained per-chat memory, `history`, `onChatId`, `MUSE_BRIDGE_FAKE_DELAY_MS`). `npm test` green (48 pass) + `tsc --noEmit` clean at merge head `8f40445`. Live re-check still pending.
### 2026-11-02
- Run `lprun_adae76e942f24d348acd60f06532e40c` shipped all four build tasks: `muse-account-pool.2` (merge `1a104bc`), `muse-acp-provider` (merge `12e694a`), `muse-settings-ui.2` (merge `2c4377e`); `muse-bridge-core` landed earlier in the same run (`ee1809f`). `npm test` green (26 pass) + `tsc --noEmit` clean at merge head `2c4377e`.
- Still open (not code): owner live smoke (sign-in + real send), public repo `VKirill/muse-ai-connector`, `gitnexus analyze`, hub install, registry + journal entry.
- Live smoke surfaced a locale bug (Russian profile: composer labelled `Сообщение`, send timed out) → `muse-locale-fix.2` merged (`a965318`): `launchOptions()` forces `en-US`, `COMPOSER_SELECTOR` replaces the role/name locator, `BUSY_TEXTS` exported (kept English-only — the UI is forced to en-US). `npm test` green (30 pass) + `tsc --noEmit` clean at merge head `a965318`. Live re-send still pending.
- A fresh BB chat on provider Muse failed with HTTP 400 ("does not support medium reasoning level") → `muse-provider-models` merged (`d1852a4`): `session/new` returns the `muse-spark` models block, `session/set_model` accepted, `server.ts` declares reasoning levels `none–high` (Muse ignores the knob — README Limits says so); version 0.1.1. `npm test` green (31 pass) + `tsc --noEmit` clean at merge head `d1852a4`. Live re-check still pending.
- Same run later shipped two side quests: `muse-protocol-core` (merge `1cfad2e`) — pure wire-protocol blocks in `bridge/protocol/` per [muse-protocol.md](muse-protocol.md); wiring into a direct client is the future `muse-api-client` task — and `muse-deepswe-kit` (merge `7eacfca`) — DeepSWE v1.1 pilot kit under `bench/deepswe/` (ovh sandbox scripts, Pier agent, Mac relay, pass@1 report), install on ovh-main awaits the owner's word. `npm test` green (44 pass) + `tsc --noEmit` clean at merge head `7eacfca`.

## Limits (say them in README)
UI-driven: breaks when Muse changes its page or cache schema (schemaVersion 4 checked, a mismatch is a clear error).
One Chrome profile per account; accounts run in parallel, one prompt at a time per account.

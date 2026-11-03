# Muse AI connector (bb-plugin-muse) — progress

## Now
- Node bridge `musebridge` (playwright-core, persistent Chrome profile per account) drives muse.ai: `doctor`, `chats`, `history`, `send`, `login`, `approve`, `accounts list|add|check|refresh|remove`; reads the page's IndexedDB `hatch-chat-cache` (transcript + chat-list parsers, hard `schemaVersion 4` check). Account pool: `accounts.json` registry, per-account locks (stale after 30 min or dead pid), `pickAccount()` picks the least-recently-used signed-in account; `accounts add` opens a headed Chrome sign-in window. Chrome launches force `en-US` and the composer is matched by a language-independent selector (`COMPOSER_SELECTOR`, `BUSY_TEXTS`), so any profile language works.
- `muse-acp` ACP agent over stdio: a BB session pins one account + Muse side chat (`sessions.json`), streams `agent_message_chunk`s back; Muse hears only the user's words (`bridge/acp-prompt.mjs` strips BB `<system_instructions>`/`<system-reminder>` blocks; empty after stripping → short note, no Chrome launch), the Muse chat id is saved as soon as the URL carries it, and an interrupted turn's pending reply is polled until it finishes (`bridge/acp-pending.mjs`, `MUSE_PENDING_WAIT_MS`) and flushed to BB before the next prompt — one Muse chat per BB thread; advertises model `muse-spark` (`session/new` models block, `session/set_model` accepted) and accepts BB reasoning levels `none–high` (Muse ignores the knob); `MUSE_BRIDGE_FAKE=1` swaps in a fake driver for tests. Approval cards in a chat the connector drives are answered «Always allow» at once (`bridge/permissions.mjs`, never clicks Deny); money cards are left to the owner with a one-line «Muse asks for approval» notice, `musebridge approve --chat <id>` answers pending cards in an existing chat, and long agentic replies are covered by `send --timeout` plus the DeepSWE relay timeout `MUSE_RELAY_REPLY_TIMEOUT_SEC` (default 5400 s).
- Direct Muse API client is the default transport: each account's cookies live at `~/.muse-bridge/accounts/<id>/cookies.json` (mode 0600; `accounts refresh <id>` re-exports them from the signed-in profile), `bridge/protocol/gateway.mjs` bootstraps over HTTPS (token, notary, vm wake, reconnect) and runs Noise XX, `bridge/protocol/api.mjs` speaks chats (send → deltas → final message, same shape as the browser `send`). `musebridge`/`muse-acp` pick `--transport api|browser` — api is the default, missing cookies or 401/403 fall back to Chrome, `MUSE_TRANSPORT=browser` forces it; Chrome is now only for sign-in and fallback.
- BB plugin "Muse" registered (provider id `muse`; package `bb-plugin-muse` 0.1.1, ESM, Node 22; settings `agentCommand`, `headless`, `replyTimeoutSec` passed as env): settings screen in BB Settings → Plugins → Muse manages accounts per host (add/check/remove, busy pill), EN+RU i18n, Pokecut styles; README EN + «По-русски».
- DeepSWE v1.1 pilot kit under `bench/deepswe/` (repo only, not installed on ovh-main): sudo-gated sandbox scripts (`server/setup.sh`, forced-command shell, docker-exec), Pier agent `muse_agent.py` on Pier's own `pier.agents.base.BaseAgent`, Mac relay `relay.mjs` driving Muse over SSH + `musebridge send`, `report.mjs` pass@1 summary.

## Blocked
- none

## Next
- [ ] Live smoke by the owner: `musebridge accounts add` sign-in + a real send over the api transport (auto-approve cards, the Russian-locale send failure, the new-chat HTTP 400, and the leaked system instructions / lost reply on a BB interrupt are all fixed in code but not yet re-verified live)
- [ ] Install the DeepSWE kit on ovh-main (root `bench/deepswe/server/setup.sh`, needs Muse's SSH pubkey) and run a pilot — only on the owner's word
- [ ] Publish public repo `VKirill/muse-ai-connector`, run `gitnexus analyze`, install the plugin on the hub, registry + journal entry

## Last verify
- command: npm test; npm run typecheck
- result: green (65 pass / 0 fail; tsc clean)
- when: 2026-11-03

## Pointers
- Todos: none filed (.agents/todos/ does not exist)
- Plans: .agents/plans/muse-ai-connector.md (delivery map — all 13 accepted tasks of the run are done incl. the prompt/interrupt/pending-reply fixes, the Pier agent, auto-approve and the direct API client; publishing pending); items/ per shipped task (muse-bridge-core, muse-account-pool.2, muse-acp-provider, muse-acp-prompt-fix, muse-acp-pending-wait, muse-settings-ui.2, muse-locale-fix.2, muse-provider-models, muse-protocol-core, muse-deepswe-kit, muse-deepswe-pier-agent.2, muse-auto-approve, muse-api-client.2); wire-protocol map muse-protocol.md; gateway methods muse-nodes.md; workspace options muse-workspace.md; site contract muse-recon.md
- Changelog: .agents/CHANGELOG.md

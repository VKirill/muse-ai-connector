# Muse AI connector (bb-plugin-muse) — progress

## Now
- Node bridge `musebridge` (playwright-core, persistent Chrome profile per account) drives muse.ai: `doctor`, `chats`, `history`, `send`, `login`, and `accounts list|add|check|remove`; reads the page's IndexedDB `hatch-chat-cache` (transcript + chat-list parsers, hard `schemaVersion 4` check). Chrome launches force `en-US` and the composer is matched by a language-independent selector (`COMPOSER_SELECTOR`, `BUSY_TEXTS`), so any profile language works.
- Account pool: `accounts.json` registry, per-account locks (stale after 30 min or dead pid), `pickAccount()` = preferred or signed-in account with the oldest `lastUsedAt`; `accounts add` opens a headed Chrome sign-in window and waits up to 10 min.
- `muse-acp` ACP agent over stdio: a BB session pins one account + Muse side chat (`sessions.json`), streams `agent_message_chunk`s back; advertises model `muse-spark` (`session/new` models block, `session/set_model` accepted) and accepts BB reasoning levels `none–high` (Muse ignores the knob); `MUSE_BRIDGE_FAKE=1` swaps in a fake driver for tests.
- BB plugin "Muse" registered (provider id `muse`; settings `agentCommand`, `headless`, `replyTimeoutSec` passed as env): settings screen in BB Settings → Plugins → Muse manages accounts per host (add/check/remove, busy pill), EN+RU i18n, Pokecut styles; README EN + «По-русски».
- Package `bb-plugin-muse` 0.1.1 (ESM, Node 22); 31 tests green on fixtures/fake drivers, no live Muse call in tests.

## Blocked
- none

## Next
- [ ] Live smoke by the owner: `musebridge accounts add` sign-in + a real send (the Russian-locale send failure and the new-chat HTTP 400 are both fixed in code but not yet re-verified live; test side chat "Reply with PONG" exists)
- [ ] Publish public repo `VKirill/muse-ai-connector`, run `gitnexus analyze`, install the plugin on the hub, registry + journal entry

## Last verify
- command: npm test; npm run typecheck
- result: green (31 pass / 0 fail; tsc clean)
- when: 2026-11-02

## Pointers
- Todos: none filed (.agents/todos/ does not exist)
- Plans: .agents/plans/muse-ai-connector.md (delivery map — build tasks done incl. provider-model fix, publishing pending); items/muse-bridge-core, items/muse-account-pool.2, items/muse-acp-provider, items/muse-settings-ui.2, items/muse-locale-fix.2, items/muse-provider-models; site contract .agents/plans/muse-recon.md
- Changelog: .agents/CHANGELOG.md

# Muse AI connector (bb-plugin-muse) — progress

## Now
- Node bridge `musebridge` (playwright-core, persistent Chrome profile per account) drives muse.ai: `doctor`, `chats`, `history`, `send` (prints the streaming reply), `login`.
- Reads the page's IndexedDB `hatch-chat-cache`: transcript and chat-list parsers with a hard `schemaVersion 4` check (clear error on mismatch).
- Reply-state machine `pending | streaming | done` with `onDelta` streaming and `reply_timeout`; all parsing/reply logic is pure and tested on fixtures without Chrome.
- Package `bb-plugin-muse` 0.1.0 (ESM, Node 22, sole runtime dep `playwright-core`); 10 fixture tests green.

## Blocked
- none

## Next
- [ ] Live smoke: `musebridge login` + a real send (test side chat "Reply with PONG" already exists in the owner's account)
- [ ] muse-account-pool: `accounts.json` registry, locks, pick, `accounts add|list|remove|check`
- [ ] muse-acp-provider: ACP agent + BB provider registration, streaming into BB chat
- [ ] muse-settings-ui (EN+RU, Pokecut) + README; then public repo VKirill/muse-ai-connector, gitnexus analyze, hub install

## Last verify
- command: npm test (node --test tests/*.test.mjs)
- result: green (10 pass / 0 fail)
- when: 2026-11-02

## Pointers
- Todos: none filed (.agents/todos/ does not exist yet)
- Plans: .agents/plans/muse-ai-connector.md (delivery map, building); items/muse-account-pool, items/muse-settings-ui; site contract .agents/plans/muse-recon.md
- Changelog: .agents/CHANGELOG.md

---
title: Muse plugin packaging for any BB user
status: building
started: 2026-11-03
---

# Muse plugin packaging

## Goal
Any BB user installs the plugin `muse` (git source VKirill/muse-ai-connector) and, without a terminal:
1. the connector runtime (CLI `musebridge` + ACP agent `muse-acp`) installs itself on every connected
   BB machine;
2. in BB Settings → Plugins → Muse they press **Add account** on a machine with Chrome, sign in once in
   the Chrome window that opens, and the account (its cookies) becomes usable on **every** connected
   machine — including headless servers;
3. picks the provider **Muse** in any chat on any of those machines.

## Facts (checked 2026-11-03)
- A BB host receives only the bundled `host.mjs` of a plugin
  (`~/.bb-machines/<hub>/plugin-host-artifacts/muse/<hash>/host.mjs`). `bin/`, `bridge/` and
  `node_modules` are NOT shipped to hosts. Today the CLI exists on our machines only because we cloned it
  by hand and linked it on PATH.
- The provider launches `muse-acp` by name from the host daemon's PATH (`server.ts`, `MUSE_AGENT_COMMAND`);
  PATH differs per machine (`~/.local/bin` is not on the OVH daemon's PATH).
- Sign-in: `musebridge accounts add <label>` opens Chrome with a per-account profile, waits for sign-in,
  exports cookies to `~/.muse-bridge/accounts/<id>/cookies.json` (0600), then pushes to ssh sync targets.
  The API transport needs only those cookies; Chrome is needed only to sign in or refresh.

## Pieces
### A. Runtime self-install (task muse-runtime-install)
- `bridge/runtime-install.mjs` (plain ESM, no deps, imported by host.ts and bundled into host.mjs):
  `runtimeStatus({home})` and `installRuntime({version, home, source, run})`.
  - Layout: `~/.muse-bridge/runtime/<version>/` (the repo at tag `v<version>`, `npm install --omit=dev`),
    shims `~/.muse-bridge/bin/musebridge` and `~/.muse-bridge/bin/muse-acp` (sh scripts that `exec node
    <runtime>/bin/<x>.mjs "$@"`, finding node like the current launchers do), `~/.muse-bridge/runtime/current`
    pointing to the active version. Old versions beyond the last 2 are removed.
  - `source`: default `https://codeload.github.com/VKirill/muse-ai-connector/tar.gz/refs/tags/v<version>`
    (fetch + `tar -xzf`); `dir:<path>` copies a local checkout (tests, dev). Install is atomic: build in
    `<version>.tmp-<pid>`, rename when `npm install` succeeded.
  - A dev override: if `~/.muse-bridge/bin/.dev` exists (or env `MUSE_RUNTIME_DEV=<checkout>`), shims point
    at that checkout and auto-install leaves them alone.
- `host.ts`: status reports `runtime: {installed, version, path}`; on `status` the host auto-installs when
  the runtime is missing or its version differs from the plugin version (once per process, in the
  background; status shows `installing`); new handler `installRuntime` for the button. `runBridge` uses
  `~/.muse-bridge/bin/musebridge` first, then PATH.
- `server.ts`: launch spec `command: "/bin/sh"`, `args: ["-c", "exec \"$HOME/.muse-bridge/bin/muse-acp\" \"$@\"", "muse-acp"]`
  unless the setting **Agent command** is set (then as today). Windows: not supported, status says so.
### B. Accounts on every machine through the hub (task muse-hub-sync)
- CLI: `musebridge accounts export <id> --json` prints `{id, label, cookies}` (the only command that
  prints cookie values; used by the host RPC only); `accounts import` exists (stdin).
- host.ts: handlers `exportAccount {id}` and `importAccount {id, label, cookies}` (cookies passed to
  `musebridge accounts import` on stdin).
- `bridge/hub-sync.mjs` (plain ESM, injected caller): `syncAcrossHosts({sourceHostId, accountId, hosts, call})`
  exports from the source and imports on every other connected host with a runtime; returns per host
  `{hostId, ok, error}`.
- server.ts: after a successful `addAccount` and on the new RPC `syncAccounts {hostId, id?}`, run it.
  Cookies only travel host → hub memory → host; never logged or stored on the hub.
### C. Settings screen (task muse-settings-v2)
Pokecut per `/Users/vechkasov/Documents/BB-сервис/docs/DESIGN.md`, EN+RU keys (i18n.ts):
- per machine: runtime line (installed vX / installing / Install button / not supported), Chrome line;
- accounts table: label, status pill, slots busy/max, last used, actions Check / Sync to all / Remove;
- **Add account** block: label field + button; while waiting a clear state «A Chrome window opened on
  <machine>. Sign in to Muse there; this closes by itself» with a spinner and a Cancel hint; then success
  «Signed in, copied to N machines» or the error;
- a machine without Chrome: the Add block says «No Chrome on this machine — add the account on <machine
  with Chrome>; it is copied here automatically».
### D. README (task muse-readme)
One accurate README (EN + RU section): what the service is, architecture (Muse cloud VM ↔ Noise WebSocket
↔ musebridge/muse-acp ↔ BB), install for any user (plugin only), accounts and sign-in, parallel slots,
machines and sync, the agent (tools, MCP, skills, BB rules, [[done]]), CLI reference, limits, security
notes (cookies 0600, never logged), troubleshooting.

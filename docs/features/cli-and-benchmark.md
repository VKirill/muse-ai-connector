---
title: CLI and Benchmark
type: component
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: medium
tags: [cli, musebridge, benchmark, deepswe, pier, ssh]
sources:
  - bin/musebridge.mjs
  - bin/musebridge
  - bin/muse-acp
  - bridge/acp-prompt.mjs
  - scripts/auto-login.mjs
  - scripts/install.sh
  - bench/deepswe/relay.mjs
  - bench/deepswe/muse_agent.py
  - bench/deepswe/report.mjs
  - bench/deepswe/run-pilot.sh
  - bench/deepswe/server/setup.sh
  - bench/deepswe/server/muse-task-shell
  - bench/deepswe/server/muse-docker-exec
---

# CLI and Benchmark

Exposes the standalone `musebridge` CLI (`doctor`, chats, sending, image generation, approval cards, account management, IMAP auto-login, SSH sync) and the DeepSWE v1.1 evaluation harness.

## Purpose

`bin/musebridge.mjs` lets operators and host RPC handlers manage accounts, inspect usage, send prompts or images, and sync cookies outside BB chats (`bin/musebridge.mjs:34-76,982-1022`), while `bench/deepswe/*` connects Pier benchmark containers on `ovh-main` to Muse via a Mac-side `musebridge` relay (`bench/deepswe/relay.mjs:1-159`, `bench/deepswe/muse_agent.py:1-95`).

## How it works

### `musebridge` CLI

1. Shell wrappers `bin/musebridge` and `bin/muse-acp` resolve symlinks and locate `node` in `/opt/homebrew/bin/node`, `/usr/local/bin/node`, or `PATH` before invoking `.mjs` entry points (`bin/musebridge:1-14`, `bin/muse-acp:1-14`).
2. `main(argv)` parses the subcommand and flags (`--account`, `--chat`, `--attach`, `--timeout`, `--transport`, `--headed`, `--json`) (`bin/musebridge.mjs:82-116,982-1022`).
3. `send` and `image` select an account (`--account` or `pickAccount()`), acquire a slot lock, call `touch(accountId)`, open the resolved transport (or `openFakeImageTransport` when `MUSE_BRIDGE_FAKE=1`), verify sign-in (`requireSignedIn`), and print text, saved image paths, or JSON (`bin/musebridge.mjs:181-217,310-446`).
4. `accounts` subcommands handle registry CRUD, Chrome sign-in (`add`, `login`, `check`, `refresh`), slot limits (`set --max-parallel 1..50`), quota (`usage`), cookie JSON `export`/`import`, and `auto-login` (`bin/musebridge.mjs:479-960`).

### DeepSWE v1.1 benchmark kit

1. On `ovh-main`, `bench/deepswe/server/setup.sh` provisions locked user `muse`, installs forced SSH command `muse-task-shell`, and grants passwordless `sudo` solely for `muse-docker-exec` into `/srv/muse-bench/current` (`bench/deepswe/server/setup.sh:65-130`, `bench/deepswe/server/muse-task-shell:10-16`).
2. `run-pilot.sh` runs `pier run` with `muse_agent:MuseAgent` (default `N=10`, `SEED=0`, `CONCURRENCY=1`) (`bench/deepswe/run-pilot.sh:6-22`). `MuseAgent.run` writes the container hostname to `/srv/muse-bench/current`, queues `queue/<session>.json`, and polls `queue/<session>.done` up to `MUSE_BENCH_TIMEOUT_SEC` (`5400` s) (`bench/deepswe/muse_agent.py:22-95`).
3. On the Mac host, `bench/deepswe/relay.mjs` polls the remote queue over `ssh ovh-main`, prompts Muse with SSH instructions (`buildPrompt`) via `musebridge send --json --timeout 5400`, sends `CONTINUE_PROMPT` up to `maxContinues` (`8`) until `isDone` matches a trailing `DONE`, and writes `queue/<session>.done` (`bench/deepswe/relay.mjs:19-152`).
4. `bench/deepswe/report.mjs` walks `reward.json` files in a run directory and writes `report.md` with `pass@1` totals (`bench/deepswe/report.mjs:17-47`).

### Modes and failure handling

| Component / Mode | Options / Env | Behaviour | Failure Handling |
|---|---|---|---|
| `musebridge send` | `--account`, `--chat`, `--attach`, `--timeout`, `--transport api\|browser`, `--headed`, `--json` (`bin/musebridge.mjs:395-446`) | Streams deltas to stdout or prints `{chatId, messageId, text}` as JSON | Exits `1` on bad `--timeout` or missing text, exits `2` if signed out (`bin/musebridge.mjs:208,406,411`) |
| `musebridge image` | `--format W:H`, `--out` (default `./muse-images`), `--chat`, `--attach`, `--json` (`bin/musebridge.mjs:310-393`) | Prefixes prompt unless `--chat` is set without `--format` (`bin/musebridge.mjs:329`) | Exits `1` if browser transport lacks `fetchMedia` or reply contains 0 images (`bin/musebridge.mjs:346-359`) |
| `musebridge accounts auto-login` | `[<id>]`, `--force`, `--headed`, `--email`, `--imap-host`, `--password-stdin`, `--batch <file\|->`, `--max-parallel`, `--json` (`bin/musebridge.mjs:780-918`) | Signs in from `--batch`, `--email` + stdin/`MUSE_IMAP_PASSWORD`, or Env Catalog; syncs BB Hub on any success (`bin/musebridge.mjs:807-917`) | Exits `1` if any account fails or `--max-parallel` is outside `1..50` (`bin/musebridge.mjs:795,917`) |
| `relayLoop` (`relay.mjs`) | `--once`, `MUSE_RELAY_POLL_SEC` (`30`), `MUSE_RELAY_REPLY_TIMEOUT_SEC` (`5400`) (`bench/deepswe/relay.mjs:107-152`) | Retries every `pollSec`; sets `status: "gave_up"` if `DONE` is absent after `maxContinues` (`bench/deepswe/relay.mjs:65`) | Logs `{event: "round_error", error}` on busy account or SSH error and retries next round unless `--once` (`bench/deepswe/relay.mjs:138-145`) |

## Business rules

- **Attachment size limit on CLI:** `loadAttachFlags` calls `loadAttachmentFromPath`, exiting `1` if any `--attach` file exceeds `10` MB (`bin/musebridge.mjs:108-116`, `bridge/acp-prompt.mjs:192-203`).
- **Safe cookie export:** `accounts export <id>` requires `--json` and fails without printing cookies if omitted (`bin/musebridge.mjs:605-611`).
- **DeepSWE sandbox isolation:** `muse-docker-exec` rejects container names not matching `^[a-z0-9][a-z0-9_.-]{0,63}$` or differing from `/srv/muse-bench/current`, and runs inside `-w /app` (`bench/deepswe/server/muse-docker-exec:17-46`). `sshd` restricts `muse` to Tailscale IP `100.100.68.99` (`MUSE_FROM`) with port/X11/tunnel forwarding disabled (`bench/deepswe/server/setup.sh:25,77,119-125`).

## Public API and commands

| Command / Script | File:Line | Purpose |
|---|---|---|
| `musebridge doctor [--account <id>]` | `bin/musebridge.mjs:219-239` | Check Chrome binary, profile dir, and sign-in status |
| `musebridge chats [--account <id>] [--transport api\|browser] [--json]` | `bin/musebridge.mjs:241-256` | List Muse side chats |
| `musebridge history [--account <id>] [--transport api\|browser] <chatId> [--json]` | `bin/musebridge.mjs:258-278` | Print chat transcript |
| `musebridge send … <text>` / `musebridge image … <prompt>` | `bin/musebridge.mjs:310-446` | Send text/attachments or generate/save images |
| `musebridge approve [--account <id>] --chat <id>` | `bin/musebridge.mjs:448-477` | Answer pending non-money approval cards in Chrome |
| `musebridge accounts list\|add\|login\|auto-login\|remove\|check\|usage\|refresh\|import\|export\|set` | `bin/musebridge.mjs:479-960` | Full account lifecycle, quota, cookie I/O, and slot tuning |
| `musebridge sync targets add\|remove\|list <name>` / `musebridge sync [--account <id>]` | `bin/musebridge.mjs:706-778` | Manage SSH sync hosts and push cookies |
| `musebridge login` | `bin/musebridge.mjs:962-980` | Interactive sign-in (adds `"default"` when registry is empty) |
| `scripts/install.sh` / `scripts/auto-login.mjs` | `scripts/install.sh:1-51`, `scripts/auto-login.mjs:1-13` | Symlink CLIs to `~/.local/bin` + install BB plugin; run `cmdAccountsAutoLogin` |
| `bench/deepswe/{muse_agent.py,relay.mjs,report.mjs,run-pilot.sh,server/setup.sh}` | `bench/deepswe/relay.mjs:56-159` | DeepSWE v1.1 container queue, SSH sandbox, Mac relay, and pass@1 report |

## Gotchas

- `bench/deepswe` must run with `CONCURRENCY=1` (`--n-concurrent 1`) because `/srv/muse-bench/current` exposes only one active task container at a time (`bench/deepswe/run-pilot.sh:8,21`, `bench/deepswe/server/muse-docker-exec:22-30`).
- Passing `--account` to `musebridge send` or `musebridge image` still acquires a slot lock on that account (`bin/musebridge.mjs:339-340,413-414`), whereas `chats`, `history`, and `doctor` do not acquire slot locks (`bin/musebridge.mjs:219-278`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architecture](../architecture.md)
- [Muse AI Connector — Overview](../overview.md)

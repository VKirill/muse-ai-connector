---
name: muse-connector
description: "Operate, sign in, and troubleshoot the BB Muse AI connector plugin (`muse`, `musebridge` CLI, `muse-acp` ACP agent): authorize Muse accounts when the user sends `<email> <password> [mailbox: ...]` in chat, run automated IMAP OTP login, sync cookies across connected BB machines, inspect weekly/extra quota usage, manage parallel slots, and send Muse Spark / Muse Image requests. Use when: muse, muse.ai, musebridge, muse-acp, muse-ai-connector, Muse Spark, Muse Image, sign in to Muse, add Muse account, аккаунты muse, логин и пароль muse, авторизоваться в muse, перелогин muse, куки muse, квота/лимиты muse, коннектор muse."
---

# Muse AI Connector (`muse`)

Operate the BB `muse` provider plugin (`~/.muse-bridge/` runtime on each macOS/Linux BB host): sign in accounts from `<email> <password>` credentials via IMAP OTP, distribute cookies to all connected BB machines automatically, monitor weekly/token quotas, and run CLI or ACP requests.

## Quick start

```sh
# 1. Inspect local accounts (busy/max slots) and merged quota across BB hosts
~/.muse-bridge/bin/musebridge accounts list
printf '{}\n' > /tmp/muse-empty.json
bb plugin rpc call muse usage --input-file /tmp/muse-empty.json --json
rm -f /tmp/muse-empty.json

# 2. Sign in from `<email> <password> [mailbox: domain]` on stdin + sync all BB hosts
~/.muse-bridge/bin/musebridge accounts auto-login --batch - --max-parallel 20 <<'EOF'
user@mail.com MyMailboxPassword mailbox: mail.com
EOF
```

## Signing in when the user sends login and password in chat

Never echo or write plaintext passwords or cookie JSON to files, commits, logs, or chat replies.

1. **Pick a connected macOS/Linux BB host with Google Chrome.**
   - Check the current thread host via `bb status --json` (`thread.environment.hostId`) and `~/.muse-bridge/bin/musebridge doctor`.
   - If Chrome or runtime is missing on this host, query `bb plugin rpc call muse hosts --input-file <emptyJson> --json` to locate a connected host with `"chromeFound": true` (Windows hosts do not run the self-installed runtime).
2. **Choose credential mode (works on a clean BB with or without `env-catalog`):**
   - **Clean BB (no extra plugins required):** Pipe one or more `<email> <password> [mailbox: domain]` lines directly on stdin to `--batch -` (passwords stay in memory only):
     ```sh
     ~/.muse-bridge/bin/musebridge accounts auto-login --batch - --max-parallel 20 <<'EOF'
     alice@mail.com PassOne mailbox: mail.com
     bob@gmx.com PassTwo
     EOF
     ```
     For a single account with a custom IMAP server: `printf '%s\n' "$PASS" | ~/.muse-bridge/bin/musebridge accounts auto-login --email user@domain.tld --imap-host imap.domain.tld --password-stdin --max-parallel 20`. (Gmail, Yandex, and iCloud require an IMAP app password.)
   - **With BB Env Catalog (`env_set` tool or `bb env-catalog` installed) — persistent auto-relogin:** Store each mailbox as `kind=login`, `name=MUSE_MAIL_<SLUG>`, `host=<domain or imap host>`, `username=<email>`, `password=<password>`, `tags=["muse"]`, then run `~/.muse-bridge/bin/musebridge accounts auto-login --max-parallel 20`. Future expired sessions re-authenticate with zero arguments (`~/.muse-bridge/bin/musebridge accounts auto-login`).
3. **What `auto-login` executes automatically:**
   - Registers missing accounts (`maxParallel: 20` by default), opens a persistent headless Chrome profile (`~/.muse-bridge/profiles/<id>/`), snapshots `UIDNEXT` on TLS IMAP port `993`, triggers Meta's 6-digit email OTP, fills the `sr-only` code input (plus First/Last/Birthday if creating a brand-new Meta account), exports `0600` cookies to `~/.muse-bridge/accounts/<id>/cookies.json`, pushes to SSH targets (`~/.muse-bridge/sync.json` if configured), and calls `bb plugin rpc call muse syncAccounts` so **all connected BB hosts receive the signed-in cookies automatically**.
4. **Verify sign-in and multi-host distribution:**
   - Run `bb plugin rpc call muse hosts --input-file <emptyJson> --json` and `bb plugin rpc call muse usage --input-file <emptyJson> --json` to confirm every connected macOS/Linux host shows `"status": "signed_in"` and live quota percentages.

## Interactive accounts, concurrency, and manual sync

- **Non-IMAP or personal Meta accounts:** Run `~/.muse-bridge/bin/musebridge accounts refresh <id>` if its Chrome profile is still signed in, or `~/.muse-bridge/bin/musebridge accounts login <id>` (`accounts add <label>` for new) to open a visible Chrome window on that host (up to ~10 min).
- **Manual cross-host cookie push:** Write `{"hostId":"<sourceHostId>"}` to a `0600` temp file and run `bb plugin rpc call muse syncAccounts --input-file <tmp> --json`, then remove the temp file.
- **Adjust parallel chat slots (`1..50`):** `~/.muse-bridge/bin/musebridge accounts set <id> --max-parallel 20`, then re-run `syncAccounts` so `maxParallel` propagates to all hosts.

## Guardrails

- **Always use `--input-file <path> --json`** with `bb plugin rpc call muse <method>`; `bb plugin rpc call` has no `--input` flag.
- **Stop immediately on `captcha_blocked` or `region_waitlist`.** Never attempt to solve or bypass CAPTCHAs or regional waitlists (`Muse isn't available in your country or region yet`). Report the code to the user: CAPTCHA requires interactive `musebridge accounts login <id>`, and brand-new Muse signups require initial activation from a supported region.

## Reference

- Full CLI flags, RPC schema, `muse-spark` / `muse-image` behaviour, IMAP host map, and error codes: [REFERENCE.md](REFERENCE.md).

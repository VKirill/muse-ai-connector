# muse-connector Technical Reference

## 1. Runtime and State Layout (per macOS/Linux BB Host)

| Item | Location / Value |
|---|---|
| Plugin ID / Provider ID | `muse` (do not install alongside Meta's `Muse Code` plugin; both claim provider `muse`) |
| Git repository | `https://github.com/VKirill/muse-ai-connector` |
| Bundled BB skill | `skills/muse-connector/` (registered automatically via `"bb": { "skills": ["skills"] }`) |
| Runtime install root | `~/.muse-bridge/runtime/<version>/` (`~/.muse-bridge/runtime/current` symlink; keeps last 2 versions) |
| CLI & ACP shims | `~/.muse-bridge/bin/musebridge`, `~/.muse-bridge/bin/muse-acp` |
| Account registry | `~/.muse-bridge/accounts.json` (`id`, `label`, `status`, `maxParallel`, timestamps) |
| Saved cookies | `~/.muse-bridge/accounts/<id>/cookies.json` (mode `0600`, `muse.ai` + `auth.meta.com`) |
| Persistent Chrome profiles | `~/.muse-bridge/profiles/<id>/` |
| Slot lock files | `~/.muse-bridge/locks/<id>.lock` and `<id>.<n>.lock` (reclaimed on dead PID or >30 min age) |
| BB session -> Muse chat map | `~/.muse-bridge/sessions.json` |
| Optional SSH sync targets | `~/.muse-bridge/sync.json` (mode `0600`, for standalone non-BB SSH machines) |

Normal text and image requests use the direct HTTP + Noise WebSocket (`wss://hatch.metaaivm.com/v1/noise`) transport without launching Chrome per turn, falling back to Playwright Chrome only on missing cookies or HTTP `401`/`403`.

## 2. Models and ACP Agent Behaviour (`muse-acp`)

| Model ID | Display Name | Behaviour |
|---|---|---|
| `muse-spark` | Muse Spark (default) | Text tool-loop protocol: injects workspace `<cwd>`, BB project/owner/language rules (up to 16 KB), and accepts up to 8 ```` ```muse-tool ```` JSON blocks per round until `[[done]]` (up to `MUSE_MAX_TOOL_ROUNDS`, default `60`). |
| `muse-image` | Muse Image | No tools intro. Prefixes first prompt (or leading ratio like `16:9 cat` / `[4:5] cat`) with `Create image format: <W:H>. ...` or `Create image. ...`. Saves generated images to `<workspace>/muse-images/` and emits image content blocks. |

- **Local tools exposed to Muse Spark:** `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `apply_patch`, `bash` (default 120 s, max 600 s), `tool_schema`, `list_skills`, `read_skill`, plus session MCP tools as `mcp__<server>__<tool>`. Paths outside `<cwd>` are refused; outputs cap at ~8 KB/call and ~24 KB/round.
- **Approval cards:** Non-monetary prompts (`Allow Muse to ...?`) are auto-approved (`Always allow`). Monetary cards (purchase, payment, subscription) pause the turn and require user action or `musebridge approve --account <id> --chat <id>`.
- **Slot selection:** Among `signed_in` accounts with free slots (`busy < maxParallel`), `pickAccount` chooses the lowest `busy` count, breaking ties by oldest `lastUsedAt`.

## 3. CLI Reference (`~/.muse-bridge/bin/musebridge`)

```sh
musebridge doctor [--account <id>]
musebridge chats [--account <id>] [--transport api|browser] [--json]
musebridge history [--account <id>] [--transport api|browser] <chatId> [--json]
musebridge send [--account <id>] [--chat <id>] [--attach <path>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>
musebridge image [--account <id>] [--format W:H] [--out dir] [--chat <id>] [--attach <path>] [--timeout <sec>] [--transport api|browser] [--json] <prompt>
musebridge approve [--account <id>] --chat <id>

musebridge accounts list [--json]
musebridge accounts add <label>
musebridge accounts login <id>
musebridge accounts auto-login [<id>] [--force] [--headed] [--email <addr>] [--imap-host <host>] [--password-stdin] [--batch <file|->] [--max-parallel <n>] [--json]
musebridge accounts remove <id> [--purge]
musebridge accounts check [<id>]
musebridge accounts usage [<id>] [--no-cache] [--json]
musebridge accounts refresh <id>
musebridge accounts set <id> --max-parallel <1..50>
musebridge accounts import [<id>] [--label <label>]      # reads JSON cookies array or export object from stdin
musebridge accounts export <id> --json                   # prints {id, label, cookies, maxParallel?}; host RPC only

musebridge sync targets add <ssh-host>
musebridge sync targets remove <ssh-host>
musebridge sync targets list
musebridge sync [--account <id>]
```

### Automated IMAP OTP Login (`accounts auto-login`)

- **Batch stdin mode (`--batch -`):** Works on any clean BB installation without additional plugins. Accepts lines `<email> <password> [mailbox: domain]` (skips `#` and `--` comments), registers missing accounts (default `maxParallel: 20`), signs in via Chrome + TLS IMAP (`993`), saves cookies, and triggers BB Hub `muse.syncAccounts`.
- **Single-account stdin mode:** `printf '%s\n' "$PASS" | musebridge accounts auto-login [<id>] --email <addr> [--imap-host <host>] --password-stdin`.
- **Default Env Catalog discovery (`no credential flags`):** When BB `env-catalog` is installed, calls `bb env-catalog list --kind login --json`, matches registered email accounts plus entries named `MUSE_MAIL_*` or tagged `"muse"`, and reads `{ access: { host, username, password } }` via `bb env-catalog get <NAME> --json` in memory only.
- **Built-in IMAP host map:** `mail.com` / `email.com` -> `imap.mail.com`, `gmx.com` -> `imap.gmx.com`, `gmx.net` -> `imap.gmx.net`, `gmail.com` / `googlemail.com` -> `imap.gmail.com`, `yandex.ru` -> `imap.yandex.ru`, `yandex.com` -> `imap.yandex.com`, `outlook.com` / `hotmail.com` / `live.com` -> `outlook.office365.com`, `yahoo.com` -> `imap.mail.yahoo.com`, `icloud.com` / `me.com` -> `imap.mail.me.com`, `purelymail.com` -> `imap.purelymail.com`, fallback `imap.<domain>` on TLS port `993`.

## 4. BB Plugin RPC Contract (`bb plugin rpc call muse <method>`)

Write JSON input to a `0600` temp file, pass `--input-file <json-path> --json`, and delete the temp file afterwards:

| Method | Input JSON | Purpose |
|---|---|---|
| `hosts` | `{}` or `{"hostId":"..."}` | Per-machine runtime, Chrome (`chromeFound`), and accounts status across BB hosts. |
| `usage` | `{}` | Merged weekly quota (`percentUsed`, `resetsAt`, `extraTokens*`, `plan`) across connected hosts. |
| `syncAccounts` | `{"hostId":"<sourceHostId>","id":"<optionalAccountId>"}` | Exports `signed_in` cookies + `maxParallel` from `<sourceHostId>` through hub memory to all other connected hosts with runtime installed. |
| `checkAccounts` | `{"hostId":"...","id":"<optional>"}` | Runs `musebridge accounts check` on target host (3 min timeout). |
| `addAccount` | `{"hostId":"...","label":"..."}` | Opens visible Chrome on target host (12 min timeout) and syncs across hosts. |
| `reloginAccount` | `{"hostId":"...","id":"..."}` | Opens visible Chrome to re-authenticate `<id>` (12 min timeout) and syncs across hosts. |
| `removeAccount` | `{"hostId":"...","id":"...","purge":false}` | Removes account (`purge: true` also deletes `profiles/<id>/`). |
| `installRuntime` | `{"hostId":"..."}` | Forces `~/.muse-bridge/runtime/<PLUGIN_VERSION>` install on macOS/Linux host (also warmed automatically every 10 min). |

## 5. Environment Variables and Plugin Settings

| Variable / Setting | Default | Description |
|---|---|---|
| `MUSE_TRANSPORT` | `api` | Set `browser` to force Playwright Chrome transport instead of Noise WebSocket API |
| `MUSE_HEADLESS` / **Headless Chrome** | `1` (`true`) | `0` (`false`) shows Chrome window during browser-transport runs |
| `MUSE_REPLY_TIMEOUT_SEC` / **Reply timeout** | `180` | Max seconds to wait per Muse reply (`10..1800`) |
| **Agent command** (`agentCommand`) | `""` | Empty uses `~/.muse-bridge/bin/muse-acp`; set full path only to override |
| `MUSE_MAX_PARALLEL` | `1` | Fallback slot count when an account has no explicit `maxParallel` |
| `MUSE_MAX_TOOL_ROUNDS` | `60` | Max tool execution rounds per prompt |
| `MUSE_PENDING_WAIT_MS` | `30000` | Wait budget on next turn to recover tail of a cancelled in-flight reply |
| `MUSE_SKILL_DIRS` | standard dirs + bundled `skills/` | Colon-separated skill scan roots for `list_skills` / `read_skill` |
| `MUSE_BRIDGE_HOME` | `~/.muse-bridge` | Override state directory (used in isolated tests) |
| `MUSE_RUNTIME_DEV` | unset | Point shims to a local checkout instead of `~/.muse-bridge/runtime/current` |

## 6. Error Codes and Recovery

| Code / Symptom | Cause and Action |
|---|---|
| `no_signed_in_account` | All accounts are `signed_out` or missing on that machine. Run `musebridge accounts auto-login` on a Chrome host or call `syncAccounts` RPC from a host that has signed-in accounts. |
| `no_free_account` | Every `signed_in` account has `busy == maxParallel`. Wait, raise `--max-parallel`, or add accounts. |
| `imap_auth_failed` / `imap_timeout` | Wrong mailbox password, IMAP disabled in mailbox settings, or app password required (Gmail/Yandex/iCloud). Verify IMAP over TLS port `993` or pass `--imap-host`. |
| `otp_timeout` | Meta did not send the 6-digit code within 90 s. Retry once; check whether Meta rate-limited OTP emails. |
| `captcha_blocked` | CAPTCHA / human challenge detected. Stop immediately (never attempt to bypass) and ask the user to sign in interactively (`musebridge accounts login <id>`). |
| `region_waitlist` | `Muse isn't available in your country or region yet` on a brand-new account. Existing Muse accounts sign in from EU IPs, while initial Muse activation requires a supported-region IP. |
| `usage_unavailable` (`409` action ID drift) | `bridge/usage.mjs` POSTs `[{"includeAgreement":true}]` to `https://muse.ai/` with `Next-Action: <fetchSubscriptionAction>`. When Meta rotates the hash, `discoverActionId` scans initial and lazy Turbopack modal chunks (`static/chunks/*.js?dpl=...`), caches the new ID in `~/.muse-bridge/cache/usage-action.json`, and evicts stale IDs automatically. |

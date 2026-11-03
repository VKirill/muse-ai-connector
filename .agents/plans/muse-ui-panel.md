---
title: Muse panel — accounts with limits, machines, add account
status: dispatched
tasks: [muse-account-usage, muse-ui-panel]
---

# Muse panel: accounts with limits, machines, add account

> [!NOTE]
> Owner's request (2026-11-03): put the UI in order — not everything on one settings page. Separate places for: adding an account, which machines hold which accounts, and one page listing every account with its Muse limits (how much of the plan is used).

## Where Muse keeps the limits (live finding)

The Muse web app reads the usage card through a Next.js server action, **`fetchSubscriptionAction`**:

```
POST https://muse.ai/settings/usage
Next-Action: 409b972cbb33d3e372f4ca9d3c8332677217064f62
Accept: text/x-component
Content-Type: text/plain;charset=UTF-8
Origin: https://muse.ai   Referer: https://muse.ai/settings/usage
sec-fetch-site: same-origin  sec-fetch-mode: cors  sec-fetch-dest: empty
User-Agent: <the same Chrome UA gateway.mjs uses>   Cookie: <account cookies>
body: [{}]
```

Plain HTTP works with the account's cookies (no Chrome) **only with the browser-like headers above**; without `Referer`/`sec-fetch-*` it answers `403 {"error":"Forbidden"}`. The answer is RSC text; line `1:` is JSON:

```json
{"success":true,"subscription":{"tier":{"name":"Muse Free","tierCode":"HATCH_FREE","isPaid":false},
 "usage":{"state":"METERED","percentUsed":28,"resetsAt":1794082412,"quotaStatus":"SUFFICIENT"},
 "statusSubtitle":"Weekly limit resets on Nov 7","usageRowLabel":"Free plan","usageRowValueLabel":"28% used",
 "topupBalance":40000000,"topupTotal":40000000,"topupRowLabel":"Additional tokens",
 "topupRowValueLabel":"0% used (1B tokens left)"}}
```

Live 2026-11-03: `main` 28% (resets Nov 7), `kennethc990@mail.com` 7% (resets Nov 9). `usage.state` may also be `UNLIMITED` (no percent). The action id is a build hash and changes when Muse redeploys: when the known id answers 404 / not an RSC success, discover the current id — GET `https://muse.ai/settings/usage`, collect `/_next/static/chunks/*.js` script URLs from the HTML, fetch them and find `createServerReference)("<id>", … ,"fetchSubscriptionAction")`; cache the found id in `~/.muse-bridge/cache` (or memory) and retry once.

## Task 1 — `muse-account-usage` (bridge + CLI)

- New `bridge/usage.mjs`: `fetchAccountUsage({ accountId?, cookies?, fetchImpl = fetch, cache = true })` → `{ plan, planCode, isPaid, state, percentUsed, resetsAt, quotaStatus, periodLabel, extraTokensTotal, extraTokensBalance, extraTokensLeftLabel, checkedAt }` (periodLabel = `statusSubtitle`, extraTokensLeftLabel = `topupRowValueLabel`). Cookies from `loadCookies(accountId)` when not given. Errors: 401/403 → `code: "auth_failed"`; anything else unreadable → `code: "usage_unavailable"` with a short reason. Cache the result per account for 5 minutes (skipped with `cache:false`).
- Reuse the header set of `bridge/protocol/gateway.mjs` (Chrome UA, Origin, Referer, sec-fetch-*); export a helper there only if the module already allows it without touching its behaviour — otherwise copy the constants into usage.mjs.
- CLI: `musebridge accounts usage [<id>] [--json]` — all accounts (or one); JSON is `{ accounts: [{ id, label, status, usage | null, error | null }] }`; text output one line per account: `main  Muse Free  28% used · Weekly limit resets on Nov 7 · extra 0% used (1B tokens left)`. Help text updated.
- Tests: `tests/usage.test.mjs` (fake fetch: parse, UNLIMITED, drift discovery, 403, cache).

## Task 2 — `muse-ui-panel` (BB screen)

BB gives a plugin its own page: `app.slots.navPanel({ id, title, icon, path, component })`, route `/plugins/muse/muse/<subPath>`, inner navigation with `useBbNavigate().toPluginPanel("muse", { subPath })`. The panel has a top tab bar with three pages:

| subPath | Page | What it shows |
|---|---|---|
| `""` | **Accounts** («Аккаунты») | Every Muse account once (merged across machines by id). Per account: label, status pill, plan name, a progress bar of the weekly limit with «28% использовано», «Weekly limit resets on Nov 7», extra tokens line, parallel chats limit, and chips of the machines where it is installed (each chip: machine name + signed in / signed out). Actions: Check, Copy to all machines, Remove (with «delete Chrome profile» on the remove confirm, not as a loose checkbox). Usage that cannot be read shows «Limit unavailable: <reason>» on that card only. A «Refresh limits» button. |
| `"machines"` | **Machines** («Машины») | One card per BB machine: online state, connector version / Install button, Chrome found or not, bridge and agent state; the list of accounts on it as compact rows (label + status + busy slots `2/10`), no account actions here except a link to the account on the Accounts page. |
| `"add"` | **Add account** («Добавить аккаунт») | Machine picker (only machines with Chrome are selectable; others greyed with «no Chrome»), label field, Add button, the 3-step text (window opens → sign in → copied to N machines), and the result notice. After success a link «Open accounts». |

- The settings section (`settingsSection`) keeps only a short summary («2 accounts · 3 machines») and an «Open Muse panel» button (`toPluginPanel("muse")`); the account and machine cards move out of it. BB's own config fields (Agent command, Headless, Reply timeout) stay where BB renders them.
- RPC: host contract `usage { id?: string } → { accounts: [{ id, usage|null, error|null }] }` running `musebridge accounts usage --json` on that host; server `usage {} → { accounts: [{ id, label, usage, error, hosts:[hostId] }] }` reading each account's usage once, from the first connected host where it is signed in, in parallel.
- Style: keep the existing Pokecut look (app.css classes, BB CSS variables only; `tests/ui-style.test.mjs` forbids hex colours). Narrow layout: tabs scroll, cards stack. All strings in i18n en + ru.
- Version 0.3.9 (package.json, package-lock.json root + `packages[""]`, version.ts).

## Checks

- `/tmp/muse-usage-check/check.mjs` — red on base (no `bridge/usage.mjs`).
- `/tmp/muse-ui-check/check.mjs` — red on base (17 missing pieces: navPanel, sub-pages, usage RPC, i18n keys).

## After acceptance (PM)

Release 0.3.9, update CLI on Mac mini / OVH / MacBook and the hub plugin, open the panel in live BB (both themes, narrow width, ru/en), confirm both accounts show their limits.

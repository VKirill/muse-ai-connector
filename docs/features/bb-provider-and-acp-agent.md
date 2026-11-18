---
title: BB Provider and ACP Agent
type: component
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: medium
tags: [acp, provider, muse-spark, muse-image, tools, mcp, skills]
sources:
  - server.ts
  - launch-spec.mjs
  - bin/muse-acp.mjs
  - bridge/acp-tools.mjs
  - bridge/acp-prompt.mjs
  - bridge/acp-mcp.mjs
  - bridge/acp-skills.mjs
  - bridge/acp-pending.mjs
  - bridge/images.mjs
  - bridge/protocol/api.mjs
---

# BB Provider and ACP Agent

Registers `muse` as an ACP provider in BB and runs `muse-acp` on stdio to bridge BB chat sessions to `muse.ai` with local workspace tools, MCP servers, skills, attachments, and image generation.

## Purpose

`server.ts` exposes the `muse` provider, model picker (`muse-spark`, `muse-image`), and provider settings (`agentCommand`, `headless`, `replyTimeoutSec`) to BB (`server.ts:207-350`), while `launch-spec.mjs` builds the `/bin/sh` or custom command launch descriptor (`launch-spec.mjs:6-24`) and `bin/muse-acp.mjs` drives the ACP session lifecycle, tool loop, and error recovery (`bin/muse-acp.mjs:420-709`).

## How it works

1. BB calls `initialize` on `muse-acp` over stdio; `muse-acp` stores `clientCapabilities` (`fs.readTextFile`, `fs.writeTextFile`) and returns `promptCapabilities: { image: true, audio: false, embeddedContext: false }` and `mcpCapabilities: { http: true, sse: false }` (`bin/muse-acp.mjs:619-630`).
2. On `session/new`, `muse-acp` creates session `muse-<uuid>`, writes it to `sessions.json` via `saveSession`, starts attached stdio and HTTP MCP servers in parallel (skipping servers that fail), and returns `muse-spark` and `muse-image` (`bin/muse-acp.mjs:106-117,631-646`, `bridge/acp-mcp.mjs:216-225`).
3. On `session/prompt`, `collectPrompt` extracts attachments (`image`, `resource_link`, `resource`) and strips `<system_instructions>` / `<system-reminder>` blocks (`bridge/acp-prompt.mjs:161-164,279-310`), while `extractBbContext` keeps only project instructions, owner-taught rules, and `# Language` (`bridge/acp-prompt.mjs:322-357`).
4. If both stripped text and attachments are empty, `muse-acp` replies with `"Nothing to send to Muse: the message held only BB system instructions."` without acquiring an account or opening a transport (`bin/muse-acp.mjs:426-429`).
5. Otherwise, `muse-acp` picks and pins an account on the session (`pickAccount`), waits up to `5` minutes (`LOCK_WAIT_MS`) for a slot (`waitForLock`), opens the API or browser driver, verifies `driver.isSignedIn()`, and flushes any `pendingReply` left by a previously cancelled turn (`bin/muse-acp.mjs:338-364,433-463`, `bridge/acp-pending.mjs:15-30`).
6. In `muse-image` mode, `runImageTurn` sends the prompt (prefixing the first turn or leading aspect ratios via `parseLeadingFormat` and `imagePrompt`), extracts image paths from history (`extractImages`), downloads bytes with `driver.fetchMedia`, writes files under `<cwd>/muse-images/`, and streams Markdown image chunks (`bin/muse-acp.mjs:366-418`, `bridge/images.mjs:12-76`).
7. In `muse-spark` mode, the first turn prepends `buildIntro(ctx.cwd, mcpNames)` and `extractBbContext` (re-sent only when BB rules change), then loops up to `MUSE_MAX_TOOL_ROUNDS` (`60`), executing up to `8` ```` ```muse-tool ```` blocks per reply in order and returning `TOOL RESULT <n>/<total> <name> (ok|error)` (`bin/muse-acp.mjs:478-588`, `bridge/acp-tools.mjs:12,236-266,319-384`).
8. If Muse returns an empty reply (running its own VM tools), `muse-acp` emits `"Muse is working with its own tools…"` and polls `driver.history` via `waitForAssistantMessage`; if a non-empty reply has neither `muse-tool` blocks nor a trailing `[[done]]` marker (`stripDoneMarker`), `muse-acp` emits the reply as `agent_thought_chunk` and sends `NUDGE_MESSAGE` up to `MAX_BLOCKLESS_REPLIES` (`3`) times (`bin/muse-acp.mjs:24-27,505-549`, `bridge/acp-tools.mjs:268-279`, `bridge/acp-pending.mjs:44-69`).

### Modes and variants

| Mode / Variant | Trigger | Prompt / Tool Handling | Output & Failure Behaviour |
|---|---|---|---|
| `muse-spark` (default) | Default model or `session/set_model` (`bin/muse-acp.mjs:60,647-654`) | Sends `buildIntro`, forwards BB rules on turn 1 or change, runs `muse-tool` loop (`bin/muse-acp.mjs:478-588`) | Streams thoughts (`agent_thought_chunk`), tool updates, and `[[done]]`-stripped final text; 4th blockless reply emits `RetriableError: [muse_no_tool] Muse stopped without using a tool` (`bin/muse-acp.mjs:27,542-544`) |
| `muse-image` | `session/set_model` with `muse-image` (`bin/muse-acp.mjs:61,464-466`) | No tools intro; prefixes first turn or leading `W:H` (`1:1`..`21:9`) with `Create image [format: W:H].` (`bin/muse-acp.mjs:367-370`, `bridge/images.mjs:4-30`) | Saves images to `<cwd>/muse-images/` via `fetchMedia`; browser transport replies `"Image mode needs the API transport."` (`bin/muse-acp.mjs:391-397`) |
| `MUSE_BRIDGE_FAKE=1` | Environment variable (`bin/muse-acp.mjs:16`) | Uses `openFakeSession` + `MUSE_BRIDGE_FAKE_SCRIPT` (`bin/muse-acp.mjs:142-278`) | Logs outgoing payloads to `MUSE_BRIDGE_FAKE_SENT`; defaults to `"PONG\n[[done]]"` (`bin/muse-acp.mjs:160,174-191`) |
| `session/cancel` | Client notification (`bin/muse-acp.mjs:699-703`) | Sets `session.cancelled = true`; checked before/after sends and each tool call (`bin/muse-acp.mjs:487,574,603-608`) | If `sendInFlight`, records `session.pendingReply` and resumes tail on next prompt (`MUSE_PENDING_WAIT_MS` 30 s) (`bin/muse-acp.mjs:22,352-364,604-606`) |

### Failure handling

- **Service faults (`sendWithRetry`):** Retries `driver.send` with delays `MUSE_RETRY_DELAYS_MS` (default `10000,30000,60000` ms) unless `cancelled` or `isAuthError` (`auth_failed`, `missing_cookies`, `no_signed_in_account`, `401`, `403`) (`bin/muse-acp.mjs:28-34,44-54`).
- **Exhausted errors:** `isAuthError` sets account status `signed_out` and emits `NonRetriableError: muse signed out: <id>`; other errors emit `RetriableError: [muse_unavailable] <shortCause>` (`bin/muse-acp.mjs:596-613`).
- **Tool round cap:** Reaching `MUSE_MAX_TOOL_ROUNDS` (`60`) ends the turn with `"Stopped: Muse hit the tool round limit (MUSE_MAX_TOOL_ROUNDS=…)."` (`bin/muse-acp.mjs:23,532-537,580-586`).

## Business rules

- **Local tool catalogue:** `runTool` exposes `read_file`, `write_file`, `edit_file` (requires unique `old` match), `list_dir`, `grep` (cap `200` matches, `5000` files, `512` KB/file), `glob` (cap `500` files, skips `.git` and `node_modules`), `apply_patch` (`git apply` in repos or `patch -p1`), `bash` (`/bin/bash -lc`, default `120` s, max `600` s), `tool_schema`, `list_skills` (max `30`), `read_skill` (max `20` KB), and `mcp__<server>__<tool>` (`bridge/acp-tools.mjs:15-101,391-704`, `bridge/acp-skills.mjs:6-91`).
- **Path and output caps:** `resolveSessionPath` rejects any path outside `session.cwd`; single tool outputs cap at `OUTPUT_CAP` (`8` KB) and combined multi-tool messages cap at `MESSAGE_CAP` (`24` KB) keeping 75% head / 25% tail (`bridge/acp-tools.mjs:10-14,109-120,311-317`).
- **Attachment & context budgets:** Attachments up to `10` MB (`MAX_ATTACHMENT_BYTES`) go as native Muse `image`/`file` items (`chatStreamBody.items`); larger UTF-8 text files are inlined up to `200,000` chars/file and `400,000` total chars, while binary files >10 MB produce `[Attached file: … (over 10 MB, not sent)]` (`bridge/acp-prompt.mjs:10-12,176-218`, `bridge/protocol/api.mjs:59-63`). Forwarded BB context caps at `16,000` chars (`bridge/acp-prompt.mjs:8,355-356`).
- **ACP filesystem delegation:** When the client announces `fs.readTextFile` or `fs.writeTextFile`, `toolRead`, `toolWrite`, and `toolEdit` delegate file I/O through `clientRequest` (`CLIENT_REQUEST_TIMEOUT_MS = 60_000`) (`bin/muse-acp.mjs:58,77-96,467-474`, `bridge/acp-tools.mjs:453-502`).
- **Skill discovery roots:** `skillDirs` scans `MUSE_SKILL_DIRS` (colon-separated) or defaults to `<cwd>/.claude/skills`, `<cwd>/.agents/skills`, `~/.claude/skills`, `~/.agents/skills`, `~/.bb/skills`, and bundled `skills/` (`bridge/acp-skills.mjs:8-27`).

## Public API

| Export / Setting | File:Line | Purpose |
|---|---|---|
| `MUSE_PROVIDER_ID`, `MUSE_AGENT_COMMAND` | `server.ts:207-208` | Provider ID `"muse"` and default command `"muse-acp"` |
| `SETTINGS` (`agentCommand`, `headless`, `replyTimeoutSec`) | `server.ts:210-230,271-274` | Plugin settings forwarded to `muse-acp` env (`MUSE_HEADLESS`, `MUSE_REPLY_TIMEOUT_SEC`) |
| `museLaunchSpec(agentCommand)` | `launch-spec.mjs:6-24` | Builds ACP spawn command (`/bin/sh` wrapper or override) with `--bb-permission=full|accept-edits` |
| `loadStore()`, `saveSession(session)` | `bin/muse-acp.mjs:102-117` | Reads/persists `~/.muse-bridge/sessions.json` |
| `parseToolCall`, `parseToolCalls`, `stripDoneMarker`, `buildIntro`, `runTool`, `resolveSessionPath`, `cap` | `bridge/acp-tools.mjs:109-427` | Fenced `muse-tool` parser (including unclosed blocks), intro builder, and sandboxed executor |
| `collectPrompt`, `promptText`, `extractBbContext`, `loadAttachmentFromPath` | `bridge/acp-prompt.mjs:161-357` | Strips BB tags, extracts rules, and encodes attachments |
| `startMcpServers`, `buildMcpIndex`, `describeMcpTool`, `callMcpTool` | `bridge/acp-mcp.mjs:216-253` | Manages stdio and streamable HTTP MCP servers (`PROTOCOL_VERSION = "2025-06-18"`) |
| `skillDirs`, `listSkills`, `readSkill` | `bridge/acp-skills.mjs:10-91` | Scans `SKILL.md` frontmatter and loads skill instructions |

## Gotchas

- `muse-acp` sets `loadSession: false` in `initialize` (`bin/muse-acp.mjs:624`) and keeps session state in `sessions.json` (`bin/muse-acp.mjs:106-117`) so resuming processes restore `accountId` and `museChatId` by `sessionId` (`bin/muse-acp.mjs:312-329`).
- `parseToolCalls` scans openers structurally rather than relying on closing ```` ``` ```` fences so tool payloads containing embedded markdown fences or truncated braces still parse (`bridge/acp-tools.mjs:137-266`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architecture](../architecture.md)
- [Muse AI Connector — Overview](../overview.md)

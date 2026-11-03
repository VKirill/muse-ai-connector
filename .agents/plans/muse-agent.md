---
title: Muse as a full BB agent (tools, MCP, skills, Lane Pilot writer)
status: building
started: 2026-11-03
updated: 2026-11-03
---

# Muse as a full BB agent

## Goal
In a BB chat (and later as a Lane Pilot writer) the Muse provider works on any task like other agents:
reads and edits files in the thread's workspace, runs commands, calls the MCP servers BB passes in
`session/new` (bb-bridge with Lane Pilot, Env Catalog, Image Studio...; MetaMCP; chrome-devtools),
and uses skills on demand. Muse itself runs on its cloud VM; the tools run locally inside `bin/muse-acp.mjs`.

## What BB gives an ACP agent (from recordings in ~/.local/share/bb-source-vk/packages/provider-bridge-protocol/recordings/acp-cursor/)
- `initialize.clientCapabilities`: `fs.readTextFile: true`, `fs.writeTextFile: true`, `terminal: false`.
- `session/new.mcpServers`: list of `{name, command, args, env:[{name,value}]}` (stdio) or `{type:"http", name, url, headers}`.
  The first is `bb-bridge` (BB's own tools).
- Updates the agent sends: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `session_info_update`.

## Tool protocol (text, one round trip per tool call)
Muse cannot call our tools natively (node.register is unproven; see muse-nodes.md). So:
1. The first message of a Muse chat carries a short intro (< 8 KB): who it is (a BB agent working in
   `<cwd>`), the tool protocol, the list of tool names (local tools, `mcp__<server>__<tool>` names, no
   schemas), that `tool_schema` returns a tool's input schema, that skills are found with `list_skills`.
2. To call a tool Muse ends its reply with exactly one fenced block:
   ````
   ```muse-tool
   {"tool":"<name>","args":{...}}
   ```
   ````
3. muse-acp parses the LAST `muse-tool` block of the reply, emits `tool_call` (status in_progress, title,
   kind read|edit|execute|search|other, rawInput) and runs it; then `tool_call_update` (completed or
   failed, content text capped ~20 KB). The text before the block streams to BB as a thought
   (`agent_thought_chunk`), never the raw block.
4. The result goes back to the same Muse chat as the next message:
   `TOOL RESULT <name> (ok|error):\n<output>` and the loop goes on.
5. A reply without a `muse-tool` block is the final answer: it streams to BB as `agent_message_chunk`,
   stopReason `end_turn`. Limits: at most `MUSE_MAX_TOOL_ROUNDS` (default 60) rounds per prompt, then
   end with a message saying the limit was hit; `session/cancel` stops the loop between rounds.
6. A malformed block (bad JSON, unknown tool) is answered to Muse as `TOOL RESULT ... (error)` with the reason.

## Local tools (task muse-acp-tools)
- `read_file {path, offset?, limit?}`, `write_file {path, content}`, `edit_file {path, old, new}` (exact,
  unique match), `list_dir {path?}`, `grep {pattern, path?}`, `bash {command, timeout_sec?}` (runs in the
  session cwd with `/bin/bash -lc`, default timeout 120 s, max 600, output capped).
- Paths resolve against the session `cwd`; a path outside cwd is refused.
- When the client announced `fs.readTextFile` / `fs.writeTextFile`, read/write go through the ACP client
  requests `fs/read_text_file {sessionId, path, line?, limit?}` / `fs/write_text_file {sessionId, path, content}`
  (absolute paths) so BB sees the edits; otherwise local fs.
- Fake mode for tests: `MUSE_BRIDGE_FAKE_SCRIPT=<json file>` = array of Muse replies returned in order
  (after the last one, repeat "PONG"); `MUSE_BRIDGE_FAKE_SENT=<file>` appends `{"text": ...}` per message sent to Muse.

## MCP and skills (task muse-acp-mcp)
- On `session/new` start every stdio MCP server (spawn command/args with env), MCP `initialize` +
  `notifications/initialized` + `tools/list`; http servers via JSON-RPC POST (streamable HTTP, accept
  JSON or SSE). Tool name for Muse: `mcp__<server>__<tool>`. `tools/call` result content joined as text.
  A server that fails to start is skipped with a stderr line; the others work. Servers close on `session/close` / exit.
- `tool_schema {name}` returns the description and input schema of any tool.
- Skills: `list_skills {query?}` scans SKILL.md front matter (name, description) in `MUSE_SKILL_DIRS`
  (colon-separated; default `<cwd>/.claude/skills`, `<cwd>/.agents/skills`, `~/.claude/skills`,
  `~/.agents/skills`, `~/.bb/skills`), returns up to 30 matches `name — description`; `read_skill {name}`
  returns the SKILL.md text. The intro only says skills exist and how to find them (there are ~680).

## Later (not these tasks)
- node.register spike: if Muse calls commands of a registered node, swap the text protocol for native calls.
- Lane Pilot writer trial on a low-risk task with the Muse provider.
- Server identity check for the Noise channel.

## History
### 2026-11-03
- Both build tasks done: `muse-acp-tools` (merge `6b3ccdf`) — the local tool loop per the protocol above (`bridge/acp-tools.mjs`, thoughts stream as `agent_thought_chunk`, path guard, capped output, fs/* via the ACP client when announced); `muse-acp-mcp` (merge `f65b096`) — session MCP servers as `mcp__<server>__<tool>` tools and `list_skills`/`read_skill` (`bridge/acp-mcp.mjs`, `bridge/acp-skills.mjs`, a failing server skipped). `npm test` green (92 pass) + `tsc --noEmit` clean at merge head `f65b096`; the live check in a real BB chat stays with the owner. The "Later" items remain open.

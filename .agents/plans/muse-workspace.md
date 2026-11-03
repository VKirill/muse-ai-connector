---
title: Muse workspace — how Muse works on the user's files
status: decided (owner, 2026-11-03): the muse-tool bridge stays the only route
---

# Muse workspace

## Decision (2026-11-03)
Muse reaches the user's files only through the muse-tool bridge of `muse-acp`: the connector runs her tool calls on the machine of the
BB chat and returns the results. No SSH into the user's machines, no extra OS accounts, no Remote Login on the Mac.

## Why (measured 2026-11-03)
- Muse's cloud VM cannot run git against GitHub (the egress proxy refuses it); a GitHub token gives her nothing for code work.
- SSH from her VM to the tailnet works only through her own ProxyCommand (`sandbox-proxy.sh <magicdns-name> <port>`, raw IPs refused).
  A replay of task `muse-account-slots` over SSH took 5.4 min against 4.3 min through the bridge: every command pays the SSH round trip.
- Her SSH key would give a Meta-hosted machine full access to the owner's account (browser profiles, keys, BB access). Not worth it.
- Through the bridge Muse solved 7 of 7 past coding tasks at first try (blind judge: better than SWE-2/Grok in 5 of 6).

## Bridge (0.3.11)
- Up to 8 muse-tool blocks per reply, run in order; one combined `TOOL RESULT n/total` message back.
- Tools: read_file, write_file, edit_file, apply_patch, list_dir, glob, grep, bash, tool_schema, list_skills, read_skill, MCP tools.
- Output caps: 8 KB per call (head + tail), 24 KB per message.

## Open
- Measure the 0.3.11 bridge on the same replay tasks (time per task, rounds per task).
- `musebridge send` drops a direct message of about 11 KB silently (4 KB passes); find the limit and fail loudly.

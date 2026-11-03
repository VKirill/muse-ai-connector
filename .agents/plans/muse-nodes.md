---
title: Muse nodes — exposing BB tools to Muse as node commands
status: researched (not built)
updated: 2026-11-03
source: muse.ai app bundles loaded in the signed-in profile `main` (2026-11-03), read-only
---

# Muse nodes

## What the web app shows
- Gateway methods (VM HTTP API over the Noise tunnel):
  `node.register` POST `/api/nodes/register`, `node.heartbeat` `/api/nodes/heartbeat`, `node.list` `/api/nodes/list`,
  `node.unpair`, `node.disconnect`, `nodes.invoke_ack` `/nodes/invoke-ack`, `nodes.invoke_result` `/nodes/invoke-result`, `nodes.sync` `/nodes/sync`.
  The same table also lists `git.log` `/git/log` and `git.show_file` `/git/show_file` (the VM has its own git API).
- Register body: `{node_id, display_name, platform, commands_v2: {<command_id>: <spec>}}`. The web client registers only
  `ping: {description: "Connection liveness check"}`.
- Command spec (from the web client's own UI commands such as `ui.set.voice.reconnect_call`, `pin.reminder`):
  `{description, required: {<param>: {type, description, enum_values}}, optional: {...}, permissions: [], datatype: "void" | "application/json", timeout_ms}`.
  `type` 1 = string, 2 = number (seen).
- Invocation: the gateway pushes event `client.invoke` with `{command_id, invoke_id, params_json}`; the client answers with
  `client.invoke.result` `{invoke_id, ok: true, payload_json}` or `{invoke_id, ok: false, error: {code, message}}`.
  Events `node.connected`, `node.disconnected`, `node.unpaired` refresh the device list (Settings → Devices).

## Idea
Our CLI (direct API transport) registers itself as a node, e.g. `display_name: "BB (Mac mini)"`, with a short list of BB commands:
`bb.web_search {query}`, `bb.image {prompt}`, `bb.task {title, brief}` (queues a Lane Pilot task, never merges by itself), `bb.read_file {path}` limited to a folder.
Muse's VM agent then calls them like it calls the web client's UI commands; results go back as `payload_json`.

## Not proven yet
- Whether the Muse model is offered commands of a third-party node at all (the web client registers only `ping`; desktop/mobile apps may get more).
- Live test needed (after task muse-api-client lands): register a node with `bb.echo {text}` → ask Muse «call bb.echo with "hi" on the BB node» → see `client.invoke`.
- Each exposed command is a door into BB: start with read-only/echo, add risky ones only with the owner's word.

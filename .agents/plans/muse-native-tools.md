---
title: Muse native tools in BB turns — empty replies, intro, real file attachments
status: waiting for the owner's word
source: report from the content-factory chat (thr_mkb8h767cp), BB thread thr_zx8cjjr4ke, Muse chat 8528f1b2-dad8-4192-9456-ea952b042eb2
---

# Muse native tools in BB turns

## Evidence (Muse chat history, 2026-11-03, read with `musebridge history --transport api`)

| time (UTC) | role | content |
|---|---|---|
| 18:37:33 | user | intro + task |
| 18:37:39 | assistant | `""` (Muse working with its own browser/subagent tools) |
| 18:38:10 | assistant | `""` |
| 18:38:26 | user | **our nudge** «Your last reply had no muse-tool block…» |
| 18:38:32 … 18:39:07 | assistant | `""` ×4 |
| 18:39:23 | assistant | «Промежуточный статус … жду два асинхронных результата» |
| 18:41:32 | user | `"[Attached file: serp-….xml] ~~~ <?xml …"` — text file inlined |
| 18:41:57 | assistant | `""` |
| 18:42:11 | user | nudge again |

All the empty assistant messages have `streaming: false`. They are Muse's tool-call steps (browser.search/open/browse, subagent.spawn); Muse's agent goes idle while async results are pending, so `driver.send()` returns an empty text, `bin/muse-acp.mjs` counts it as a blockless reply, sends `NUDGE_MESSAGE`, and after `MAX_BLOCKLESS_REPLIES` ends the BB turn with an empty/stop message — before the real text arrives.

## 1. Empty replies are not answers (`bin/muse-acp.mjs`, maybe `bridge/acp-pending.mjs`)

- A reply whose text is empty after trim is not a reply: do not count it as blockless, do not nudge, do not end the turn.
- Instead keep waiting on the same Muse chat for the next non-empty assistant message after the last one seen (poll `driver.history(chatId)` every ~3 s, or resubscribe in the API transport), up to `REPLY_TIMEOUT_MS` counted from the last activity; each new empty assistant message resets the idle clock (Muse is still working).
- Stream a short `agent_thought_chunk` («Muse is working with its own tools…») once, so the BB turn shows progress.
- When a non-empty message arrives, handle it as the reply (tool block / [[done]] / blockless as today).
- Timeout with nothing but empty messages → end the turn with a clear message («Muse is still working on its side; ask it to continue»), not an empty agentMessage.
- The nudge is sent only after a non-empty reply without a block and without [[done]].

## 2. Intro: native tools vs the workspace (`bridge/acp-tools.mjs` buildIntro)

Add a short block to the intro (and repeat it in `NUDGE_MESSAGE`):
- «`muse-tool` is not one of your tools. It is a fenced text block you write at the end of your reply; the BB bridge on the user's machine runs it and answers in the next message.»
- «Your own tools (muse.read / muse.write / muse.exec, your shell) work on your cloud VM, not in the user's workspace. Files the user asked for must be written with a muse-tool write_file block.»
- «For the web use your native browser.* tools as usual; then bring the result into the workspace with muse-tool.»

## 3. Attached files go to Muse as real attachments (`bridge/acp-prompt.mjs`, `bin/muse-acp.mjs`)

Today text files (`resource_link` / `resource` with text) are inlined as `[Attached file: name] ~~~ body ~~~`; images and binaries already go as real attachments (task muse-attachments). Owner's request: every attached file goes as a real Muse attachment (items of the chat message, ≤10 MB, the existing attachment path), and the text only carries one line `[Attached file: name — sent as an attachment]`. Files over 10 MB: inline the first part as today with a «truncated» note. Muse Image model: same.

## Checks to write before dispatch (red on base)

- `/tmp/muse-empty-reply/check.mjs`: run `bin/muse-acp.mjs` in fake mode where the scripted Muse chat gets two empty assistant messages and then, without a new user message, a non-empty «answer [[done]]»; expect no nudge in the sent log and the BB turn text «answer». Needs a fake knob for a late message — the writer adds it to the fake driver.
- `/tmp/muse-attach-text/check.mjs`: a prompt with a text `resource_link` → the fake send log shows one attachment with the file name and the text has no `~~~` body.
- Intro: `buildIntro()` output contains «not one of your tools» and «cloud VM».

Version: next patch after 0.3.10.

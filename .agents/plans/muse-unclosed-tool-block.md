---
title: Parse muse-tool blocks Muse sends without the closing fence
status: ready (waits for the owner's word: the report came from thread thr_mkb8h767cp)
task: muse-unclosed-tool-block
check: node /tmp/muse-unclosed/check.mjs <checkout>  (red on base: all 5 real replies -> kind none)
---

# Unclosed muse-tool blocks

## Finding (2026-11-03)
Content-factory run on Muse (BB session thr_ss25zgvfxa, Muse chat 84a16a39…): tool replies end with `"}` — no closing
fence, sometimes no last `}`; once a sentence was glued right after `"}}`. The raw `/chat/history` shows Muse's server
stores exactly this text (`display_text` == `payload.content`, `display_text_ready: true`): 10 of ~40 tool replies in two
chats. Our capture is faithful; `TOOL_BLOCK_RE` (bridge/acp-tools.mjs:17) needs the closing fence, so `parseToolCall`
returns `none` and after MAX_BLOCKLESS_REPLIES the cut text becomes the final answer.

## Fix: parseToolCall
1. The last closed block wins as now.
2. Else the last `muse-tool` opener without a closing fence: scan the JSON tracking strings (with escapes) and depth.
   Closes at depth 0 → JSON; the rest (minus an optional fence) joins `thought`. Ends outside a string with depth > 0 →
   append the missing `}`/`]` in order. Ends inside a string → `{kind:"error", error:"muse-tool block was cut off …"}`.
3. A closed-block match that does not parse (a ``` inside a JSON string) falls back to the scanner.
4. Version 0.3.4 (package.json, package-lock.json, version.ts).
5. New tests/acp-tools-unclosed.test.mjs + tests/fixtures/muse-unclosed-replies.json (from /tmp/muse-unclosed/real-replies.json).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseToolCall } from "../bridge/acp-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const realReplies = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "muse-unclosed-replies.json"), "utf8"));

test("parseToolCall: five real Muse replies without a closing fence are bash calls", () => {
  const commands = [
    "cd sources/serp && grep -n '^#' pages/1.md | head -20; echo '---'; grep -n 'перевод' pages/1.md | head; echo '---tail---'; sed -n '640,681p' pages/1.md | head -30",
    "find / -maxdepth 6 -name 'competitors*.md' 2>/dev/null | head -20; echo '---'; ls -la research/reports/",
    "ls -la research/reports/ 2>&1 | head -30",
    "cd sources/serp && grep -n -i 'неусыпаем' pages/5.md | head; echo '==='; grep -n -i 'неусыпаем' pages/6.md | head; echo '==='; grep -n '^#' pages/5.md pages/6.md pages/8.md | head -30",
    "cd sources/serp && grep -n -i 'неусыпаем' pages/5.md | head",
  ];
  assert.equal(realReplies.length, 5);
  for (const [i, text] of realReplies.entries()) {
    const r = parseToolCall(text);
    assert.equal(r.kind, "call", `reply ${i}`);
    assert.equal(r.name, "bash", `reply ${i}`);
    assert.equal(r.args.command, commands[i], `reply ${i}`);
  }
});

test("parseToolCall: complete JSON with glued text after it, no fence", () => {
  const r = parseToolCall('```muse-tool\n{"tool":"write_file","args":{"path":"a.md","content":"x}y ```z"}}Тест связи: короткий вызов.');
  assert.equal(r.kind, "call");
  assert.equal(r.name, "write_file");
  assert.equal(r.args.content, "x}y ```z");
  assert.match(r.thought, /Тест связи/);
});

test("parseToolCall: a closed block still wins and text before it is thought", () => {
  const r = parseToolCall('Читаю.\n```muse-tool\n{"tool":"read_file","args":{"path":"b.md"}}\n```');
  assert.equal(r.kind, "call");
  assert.equal(r.name, "read_file");
  assert.equal(r.args.path, "b.md");
  assert.equal(r.thought, "Читаю.");
});

test("parseToolCall: a block cut inside a string returns a muse-tool error", () => {
  const r = parseToolCall('```muse-tool\n{"tool":"bash","args":{"command":"ls -la res');
  assert.equal(r.kind, "error");
  assert.equal(r.name, "muse-tool");
  assert.match(r.error, /muse-tool block was cut off/);
});

test("parseToolCall: a reply with no muse-tool opener is none", () => {
  const r = parseToolCall("Готово, файл записан.");
  assert.equal(r.kind, "none");
  assert.equal(r.text, "Готово, файл записан.");
});

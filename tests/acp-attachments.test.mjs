import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extractBbContext, promptText } from "../bridge/acp-prompt.mjs";

function tmpDir() {
  return fs.mkdtempSync("/tmp/muse-attach-test-");
}

test("promptText inlines a text file under its name in a ~~~ fence", () => {
  const dir = tmpDir();
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, "# Notes\nhello\n");
  const text = promptText([
    { type: "text", text: "Прочитай вложение" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "notes.md" },
  ]);
  assert.equal(
    text,
    "Прочитай вложение\n\n[Attached file: notes.md]\n~~~\n# Notes\nhello\n\n~~~",
  );
});

test("promptText keeps ``` inside the attached file intact", () => {
  const dir = tmpDir();
  const file = path.join(dir, "sample.md");
  fs.writeFileSync(file, "before\n```js\nconst x = 1;\n```\nafter\n");
  const text = promptText([
    { type: "text", text: "see file" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "sample.md" },
  ]);
  assert.equal(
    text,
    "see file\n\n[Attached file: sample.md]\n~~~\nbefore\n```js\nconst x = 1;\n```\nafter\n\n~~~",
  );
});

test("promptText gives the not-sent line for a binary file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "photo.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
  const text = promptText([
    { type: "text", text: "look" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "photo.png", mimeType: "image/png" },
  ]);
  assert.equal(
    text,
    "look\n\n[Attached file: photo.png (image/png, not sent: Muse gets only text files for now)]",
  );
});

test("promptText cuts a file at 200000 characters with the truncation note", () => {
  const dir = tmpDir();
  const file = path.join(dir, "long.txt");
  const original = "a".repeat(200010);
  fs.writeFileSync(file, original);
  const text = promptText([{ type: "resource_link", uri: pathToFileURL(file).href, name: "long.txt" }]);
  const kept = "a".repeat(200000);
  assert.equal(
    text,
    `[Attached file: long.txt]\n~~~\n${kept}\n~~~\n…(file truncated: 200000 of 200010 characters)`,
  );
});

test("promptText still strips BB system blocks when a file is attached", () => {
  const dir = tmpDir();
  const file = path.join(dir, "n.md");
  fs.writeFileSync(file, "ok\n");
  const text = promptText([
    { type: "text", text: "<system_instructions>secret</system_instructions>hi" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "n.md" },
  ]);
  assert.equal(text, "hi\n\n[Attached file: n.md]\n~~~\nok\n\n~~~");
});

test("extractBbContext ignores resource_link blocks", () => {
  const dir = tmpDir();
  const file = path.join(dir, "n.md");
  fs.writeFileSync(file, "SHOULD-NOT-BE-CONTEXT\n");
  const sys = `<system_instructions>\nContents of /p/AGENTS.md (project instructions, checked into the codebase):\nKeep this rule.\n</system_instructions>\n`;
  const withFile = [
    { type: "text", text: `${sys}go` },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "n.md" },
  ];
  const withoutFile = [{ type: "text", text: `${sys}go` }];
  assert.equal(extractBbContext(withFile), extractBbContext(withoutFile));
  assert.equal(extractBbContext(withFile).includes("SHOULD-NOT-BE-CONTEXT"), false);
});

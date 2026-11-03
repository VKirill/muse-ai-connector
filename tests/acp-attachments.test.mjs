import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { collectPrompt, extractBbContext } from "../bridge/acp-prompt.mjs";

function tmpDir() {
  return fs.mkdtempSync("/tmp/muse-attach-test-");
}

function decode(att) {
  return Buffer.from(att.data_base64, "base64").toString("utf8");
}

test("collectPrompt sends a text file as a Muse attachment with a marker line", () => {
  const dir = tmpDir();
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, "# Notes\nhello\n");
  const { text, attachments } = collectPrompt([
    { type: "text", text: "Прочитай вложение" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "notes.md" },
  ]);
  assert.equal(text, "Прочитай вложение\n\n[Attached file: notes.md — sent as an attachment]");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].type, "file");
  assert.equal(attachments[0].mime_type, "text/markdown");
  assert.equal(attachments[0].filename, "notes.md");
  assert.equal(decode(attachments[0]), "# Notes\nhello\n");
});

test("collectPrompt keeps ``` inside the attached file intact in the attachment body", () => {
  const dir = tmpDir();
  const file = path.join(dir, "sample.md");
  const body = "before\n```js\nconst x = 1;\n```\nafter\n";
  fs.writeFileSync(file, body);
  const { text, attachments } = collectPrompt([
    { type: "text", text: "see file" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "sample.md" },
  ]);
  assert.equal(text, "see file\n\n[Attached file: sample.md — sent as an attachment]");
  assert.equal(attachments.length, 1);
  assert.equal(decode(attachments[0]), body);
});

test("collectPrompt sends a binary file as an attachment", () => {
  const dir = tmpDir();
  const file = path.join(dir, "photo.png");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  fs.writeFileSync(file, png);
  const { text, attachments } = collectPrompt([
    { type: "text", text: "look" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "photo.png", mimeType: "image/png" },
  ]);
  assert.equal(text, "look\n\n[Attached file: photo.png — sent as an attachment]");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].type, "image");
  assert.equal(attachments[0].mime_type, "image/png");
  assert.equal(attachments[0].filename, "photo.png");
});

test("collectPrompt sends an embedded text resource as an attachment", () => {
  const { text, attachments } = collectPrompt([
    { type: "text", text: "hi" },
    {
      type: "resource",
      resource: { uri: "file:///tmp/a.txt", mimeType: "text/plain", text: "body\n" },
      name: "a.txt",
    },
  ]);
  assert.equal(text, "hi\n\n[Attached file: a.txt — sent as an attachment]");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].type, "file");
  assert.equal(attachments[0].mime_type, "text/plain");
  assert.equal(decode(attachments[0]), "body\n");
});

test("collectPrompt inlines a text file over 10 MB truncated with the note", () => {
  const dir = tmpDir();
  const file = path.join(dir, "long.txt");
  const original = "a".repeat(10 * 1024 * 1024 + 10);
  fs.writeFileSync(file, original);
  const { text, attachments } = collectPrompt([
    { type: "resource_link", uri: pathToFileURL(file).href, name: "long.txt" },
  ]);
  const kept = "a".repeat(200000);
  assert.equal(
    text,
    `[Attached file: long.txt]\n~~~\n${kept}\n~~~\n…(file truncated: 200000 of ${original.length} characters)`,
  );
  assert.equal(attachments.length, 0);
});

test("collectPrompt gives the not-sent line for a binary over 10 MB", () => {
  const dir = tmpDir();
  const file = path.join(dir, "big.bin");
  fs.writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1, 0xff));
  const { text, attachments } = collectPrompt([
    { type: "resource_link", uri: pathToFileURL(file).href, name: "big.bin", mimeType: "application/octet-stream" },
  ]);
  assert.equal(text, "[Attached file: big.bin (over 10 MB, not sent)]");
  assert.equal(attachments.length, 0);
});

test("collectPrompt still strips BB system blocks when a file is attached", () => {
  const dir = tmpDir();
  const file = path.join(dir, "n.md");
  fs.writeFileSync(file, "ok\n");
  const { text, attachments } = collectPrompt([
    { type: "text", text: "<system_instructions>secret</system_instructions>hi" },
    { type: "resource_link", uri: pathToFileURL(file).href, name: "n.md" },
  ]);
  assert.equal(text, "hi\n\n[Attached file: n.md — sent as an attachment]");
  assert.equal(attachments.length, 1);
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

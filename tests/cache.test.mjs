import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findUserMessage, parseChatList, parseTranscript, replyState } from "../bridge/cache.mjs";
import { profileDir } from "../bridge/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const transcript = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "side-transcript.json"), "utf8"));
const chatList = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "side-chat-list.json"), "utf8"));

test("parseTranscript returns messages in messageIds order with model Muse Spark", () => {
  const parsed = parseTranscript(transcript);
  assert.equal(parsed.chatId, "3dfece7e-0301-47cb-8bf8-50383cde4a96");
  assert.equal(parsed.revision, 2);
  assert.equal(parsed.hasMore, false);
  assert.deepEqual(
    parsed.messages.map((m) => m.id),
    transcript.messageIds,
  );
  for (const message of parsed.messages) {
    assert.equal(typeof message.id, "string");
    assert.equal(typeof message.role, "string");
    assert.equal(typeof message.content, "string");
    assert.equal(typeof message.streaming, "boolean");
    assert.ok("createdAt" in message);
    assert.ok("model" in message);
  }
  const assistants = parsed.messages.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 2);
  for (const message of assistants) {
    assert.equal(message.model, "Muse Spark");
    assert.equal(message.streaming, false);
  }
  assert.equal(parsed.messages[0].role, "user");
  assert.equal(parsed.messages[0].content, "Test from connector: reply with the single word PONG.");
  assert.equal(parsed.messages[1].content, "PONG");
});

test("parseTranscript throws when schemaVersion is 5", () => {
  assert.throws(
    () => parseTranscript({ ...transcript, schemaVersion: 5 }),
    (err) => err instanceof Error && /schemaVersion/.test(err.message) && /5/.test(err.message),
  );
});

test("replyState is pending when there is no assistant after the user message", () => {
  const messages = [
    { id: "u1", role: "user", content: "hello", streaming: false, createdAt: "2026-11-02T22:00:00.000Z", model: null },
  ];
  assert.deepEqual(replyState(messages, "u1", false), { state: "pending", text: "" });
});

test("replyState is streaming when isTextStreaming is true", () => {
  const messages = [
    { id: "u1", role: "user", content: "hello", streaming: false, createdAt: "2026-11-02T22:00:00.000Z", model: null },
    { id: "a1", role: "assistant", content: "hel", streaming: true, createdAt: "2026-11-02T22:00:01.000Z", model: "Muse Spark" },
  ];
  assert.deepEqual(replyState(messages, "u1", false), { state: "streaming", text: "hel" });
});

test("replyState is streaming when busy is true", () => {
  const messages = [
    { id: "u1", role: "user", content: "hello", streaming: false, createdAt: "2026-11-02T22:00:00.000Z", model: null },
    { id: "a1", role: "assistant", content: "hi", streaming: false, createdAt: "2026-11-02T22:00:01.000Z", model: "Muse Spark" },
  ];
  assert.deepEqual(replyState(messages, "u1", true), { state: "streaming", text: "hi" });
});

test("replyState is done with the assistant text otherwise", () => {
  const parsed = parseTranscript(transcript);
  assert.deepEqual(replyState(parsed.messages, "user-msg-pong", false), { state: "done", text: "PONG" });
  assert.deepEqual(replyState(parsed.messages, "user-msg-42", false), { state: "done", text: "42" });
});

test("findUserMessage returns the newest matching user message at or after sentAfterIso", () => {
  const messages = [
    { id: "old", role: "user", content: "ping", streaming: false, createdAt: "2026-11-02T21:00:00.000Z", model: null },
    { id: "mid", role: "user", content: "ping", streaming: false, createdAt: "2026-11-02T22:00:00.000Z", model: null },
    { id: "a", role: "assistant", content: "pong", streaming: false, createdAt: "2026-11-02T22:00:01.000Z", model: "Muse Spark" },
  ];
  assert.equal(findUserMessage(messages, "ping", "2026-11-02T21:30:00.000Z").id, "mid");
});

test("parseChatList returns session fields newest updatedAt first", () => {
  const chats = parseChatList(chatList);
  assert.equal(chats.length, 2);
  assert.deepEqual(
    chats.map((c) => c.id),
    ["3dfece7e-0301-47cb-8bf8-50383cde4a96", "aaaaaaaa-1111-4111-8111-111111111111"],
  );
  const newest = chats[0];
  assert.equal(newest.id, "3dfece7e-0301-47cb-8bf8-50383cde4a96");
  assert.equal(newest.title, "Reply with PONG");
  assert.equal(newest.snippet, "42");
  assert.equal(newest.updatedAt, 1762120002000);
  assert.equal(newest.archived, false);
  assert.equal(newest.pinned, false);
  assert.equal(chats[1].pinned, true);
});

test("profileDir uses MUSE_BRIDGE_HOME when set", () => {
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = "/tmp/muse-bridge-home-test";
  try {
    assert.equal(profileDir("acc1"), "/tmp/muse-bridge-home-test/profiles/acc1");
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildPrompt, isDone, relayLoop, relayOnce, sendArgs } from "../bench/deepswe/relay.mjs";

test("buildPrompt names the ssh target, the task text and DONE", () => {
  const prompt = buildPrompt({
    host: "100.73.123.79",
    port: 2222,
    user: "muse",
    instruction: "Fix the parser crash",
  });
  assert.match(prompt, /muse@100\.73\.123\.79/);
  assert.match(prompt, /2222/);
  assert.match(prompt, /Fix the parser crash/);
  assert.match(prompt, /DONE/);
});

test("isDone accepts a trailing DONE and rejects unfinished replies", () => {
  for (const text of ["All good. DONE", "DONE.", "**DONE**", "Summary...\nDONE"]) {
    assert.ok(isDone(text), text);
  }
  for (const text of ["working on it", "not done yet", "", "  \n  ", "UNDONE"]) {
    assert.ok(!isDone(text), text);
  }
});

test("relayOnce continues in the same chat until DONE, then writes done", async () => {
  const answers = ["working on it", "still working", "fixed. DONE"];
  const sent = [];
  const dones = [];
  const results = await relayOnce({
    listQueue: async () => [{ session: "s1", instruction: "Fix X" }],
    send: async ({ chatId, text }) => {
      sent.push({ chatId, text });
      return { chatId: chatId ?? "chat-1", text: answers.shift() };
    },
    writeDone: async (session, result) => dones.push({ session, result }),
    maxContinues: 8,
  });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { session: "s1", chatId: "chat-1", turns: 3, status: "done" });
  assert.equal(sent.length, 3);
  assert.equal(sent[0].chatId, undefined);
  assert.equal(sent[1].chatId, "chat-1");
  assert.equal(sent[2].chatId, "chat-1");
  assert.match(sent[0].text, /Fix X/);
  assert.equal(dones.length, 1);
  assert.equal(dones[0].session, "s1");
  assert.equal(dones[0].result.status, "done");
  assert.equal(dones[0].result.summary, "fixed. DONE");
});

test("sendArgs passes --timeout from MUSE_RELAY_REPLY_TIMEOUT_SEC (default 5400)", () => {
  const def = sendArgs({ text: "hello" });
  assert.deepEqual(def.slice(1, 5), ["send", "--json", "--timeout", "5400"]);

  process.env.MUSE_RELAY_REPLY_TIMEOUT_SEC = "900";
  try {
    const args = sendArgs({ chatId: "chat-9", text: "hi" });
    assert.ok(args.includes("--timeout"));
    assert.equal(args[args.indexOf("--timeout") + 1], "900");
    assert.ok(args.includes("--chat"));
    assert.equal(args[args.indexOf("--chat") + 1], "chat-9");
    assert.equal(args[args.length - 1], "hi");
  } finally {
    delete process.env.MUSE_RELAY_REPLY_TIMEOUT_SEC;
  }
});

test("relayOnce gives up after maxContinues", async () => {
  const dones = [];
  let calls = 0;
  const results = await relayOnce({
    listQueue: async () => [{ session: "s2", instruction: "Fix Y" }],
    send: async ({ chatId }) => {
      calls += 1;
      return { chatId: chatId ?? "c", text: "not done yet" };
    },
    writeDone: async (session, result) => dones.push({ session, result }),
    maxContinues: 2,
  });

  assert.equal(calls, 3);
  assert.equal(results[0].status, "gave_up");
  assert.equal(results[0].turns, 3);
  assert.equal(dones[0].result.status, "gave_up");
});

test("relayLoop logs round_error on a busy account and writes done next round", async () => {
  const dones = [];
  const logs = [];
  let round = 0;
  const outcome = await relayLoop({
    listQueue: async () => {
      round += 1;
      return [{ session: "s3", instruction: "Fix Z" }];
    },
    send: async ({ chatId }) => {
      if (round === 1) throw new Error("All Muse accounts are busy");
      return { chatId: chatId ?? "c", text: "fixed. DONE" };
    },
    writeDone: async (session, result) => dones.push({ session, round, result }),
    log: (entry) => logs.push(entry),
    sleep: async () => {
      if (round === 2) throw new Error("stop test loop");
    },
  }).then(
    () => null,
    (err) => err,
  );

  assert.equal(outcome?.message, "stop test loop");
  assert.equal(round, 2);
  assert.equal(logs[0].event, "round_error");
  assert.match(logs[0].error, /All Muse accounts are busy/);
  assert.equal(dones.length, 1);
  assert.equal(dones[0].session, "s3");
  assert.equal(dones[0].round, 2);
  assert.equal(dones[0].result.status, "done");
});

import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { createStreamDecoder, decodeBody } from "../bridge/protocol/ndjson.mjs";

test("decodeBody parses a zstd body without a content-encoding header", () => {
  const payload = { sessions: [{ id: "a" }] };
  const packed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  assert.deepEqual(decodeBody([packed], undefined), payload);
});

test("decodeBody parses a zstd body named by the header and split across chunks", () => {
  const payload = { ok: true, result: { sessions: [] } };
  const packed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  assert.deepEqual(decodeBody([packed.subarray(0, 8), packed.subarray(8)], "zstd"), payload);
});

test("decodeBody parses plain JSON without a content-encoding header", () => {
  assert.deepEqual(decodeBody([Buffer.from('{"ok":1}')], undefined), { ok: 1 });
});

test("createStreamDecoder emits events from a zstd stream without a header", async () => {
  const compressed = zlib.zstdCompressSync(Buffer.from('{"a":1}\n{"b":2}\n'));
  const decoder = createStreamDecoder();
  const events = [];
  decoder.onEvent((event) => events.push(event));
  decoder.push(compressed.subarray(0, 3));
  decoder.push(compressed.subarray(3, 9));
  decoder.push(compressed.subarray(9));
  await decoder.flush();
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("createStreamDecoder emits events from a plain NDJSON stream", async () => {
  const decoder = createStreamDecoder();
  const events = [];
  decoder.onEvent((event) => events.push(event));
  decoder.push(Buffer.from('{"a":1}\n{"b'));
  decoder.push(Buffer.from('":2}'));
  await decoder.flush();
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { createStreamDecoder, decodeBody } from "../bridge/protocol/ndjson.mjs";

test("createStreamDecoder yields JSON lines from a zstd stream split across chunks", async () => {
  const compressed = zlib.zstdCompressSync(Buffer.from('{"a":1}\n{"b":2}\n'));
  const decoder = createStreamDecoder();
  const events = [];
  decoder.onEvent((event) => events.push(event));
  decoder.push(compressed.subarray(0, 5));
  decoder.push(compressed.subarray(5));
  await decoder.flush();
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("decodeBody inflates a zstd JSON body", () => {
  const payload = { ok: true, result: { sessions: [] } };
  const compressed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  assert.deepEqual(decodeBody([compressed.subarray(0, 8), compressed.subarray(8)], "zstd"), payload);
});

test("decodeBody returns JSON when content-encoding is absent", () => {
  assert.deepEqual(decodeBody([Buffer.from('{"presence":"active"}')], ""), { presence: "active" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame, encodeRequest, encodeResponse } from "../bridge/protocol/envelope.mjs";

test("encodeRequest roundtrips method, path, headers, body and stream id", () => {
  const bytes = encodeRequest({
    id: 7n,
    streamId: 35,
    method: "POST",
    path: "/api/ping",
    headers: [["x-app-id", "hatch-web"]],
    body: Buffer.from('{"presence":"active"}'),
  });
  const back = decodeFrame(bytes);
  assert.equal(back.id, 7);
  assert.equal(back.request.method, "POST");
  assert.equal(back.request.path, "/api/ping");
  assert.equal(back.request.streamId, 35);
  assert.deepEqual(back.request.headers, [["x-app-id", "hatch-web"]]);
  assert.equal(Buffer.from(back.request.body).toString(), '{"presence":"active"}');
  assert.equal(back.request.end, true);
});

test("encodeResponse roundtrips a status head and a data chunk that closes the stream", () => {
  const head = encodeResponse({ streamId: 36, status: 200, headers: [["content-encoding", "zstd"]] });
  const decodedHead = decodeFrame(head).response;
  assert.equal(decodedHead.streamId, 36);
  assert.equal(decodedHead.status, 200);
  assert.deepEqual(decodedHead.headers, [["content-encoding", "zstd"]]);

  const data = encodeResponse({ streamId: 36, chunk: Buffer.from("abc"), end: true });
  const decodedData = decodeFrame(data).response;
  assert.equal(decodedData.streamId, 36);
  assert.equal(Buffer.from(decodedData.chunk).toString(), "abc");
  assert.equal(decodedData.end, true);
});

test("decodeFrame skips unknown protobuf fields", () => {
  const frame = Buffer.from(encodeRequest({ id: 1, streamId: 2, method: "GET", path: "/x" }));
  const extra = Buffer.from([0x52, 0x03, 0x61, 0x62, 0x63]);
  const back = decodeFrame(Buffer.concat([frame, extra]));
  assert.equal(back.request.method, "GET");
  assert.equal(back.request.path, "/x");
});

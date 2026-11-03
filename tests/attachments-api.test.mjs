import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chatStreamBody } from "../bridge/protocol/api.mjs";
import { decodeFrame, encodeBodyChunk } from "../bridge/protocol/envelope.mjs";
import { BODY_CHUNK_LIMIT, connectGateway, parseBootstrapFromHtml } from "../bridge/protocol/gateway.mjs";
import { createHandshake } from "../bridge/protocol/noise.mjs";

const flightHtml = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "muse-flight.html"),
  "utf8",
);

test("chatStreamBody with attachments uses items and omits message", () => {
  const att = [
    { type: "image", mime_type: "image/png", data_base64: "QUJD", filename: "a.png" },
    { type: "file", mime_type: "application/pdf", data_base64: "REVG", filename: "b.pdf" },
  ];
  const body = chatStreamBody({ text: "hi", sessionId: "s", nodeId: "n", timezone: "UTC", attachments: att });
  assert.equal(body.message, undefined);
  assert.deepEqual(body.items, [...att, { type: "text", text: "hi" }]);
});

test("chatStreamBody without attachments keeps the message field", () => {
  const body = chatStreamBody({ text: "hi", sessionId: "s", nodeId: "n", timezone: "UTC" });
  assert.equal(body.message, "hi");
  assert.equal(body.items, undefined);
});

test("encodeBodyChunk writes the hatch body-chunk frame", () => {
  const f = Buffer.from(encodeBodyChunk({ id: 7n, streamId: 3, chunk: Buffer.from("xyz"), end: true }));
  const want = Buffer.from("080710001801220d120b080322070a0378797a1001", "hex");
  assert.equal(f.toString("hex"), want.toString("hex"));
});

test("a 120 KiB request body is a head with end=0 plus three bodyChunk frames", async () => {
  const { encodeResponse } = await import("../bridge/protocol/envelope.mjs");
  const frames = [];
  const listeners = new Map();
  const responder = createHandshake({ initiator: false });
  const ws = {
    binaryType: "",
    readyState: 1,
    sent: 0,
    respSend: null,
    respRecv: null,
    emit(name, ev) {
      for (const cb of listeners.get(name) ?? []) cb(ev);
    },
    addEventListener(name, cb) {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    removeEventListener(name, cb) {
      listeners.set(name, (listeners.get(name) ?? []).filter((x) => x !== cb));
    },
    send(data) {
      queueMicrotask(() => {
        ws.sent += 1;
        const bytes = new Uint8Array(Buffer.from(data));
        if (ws.sent === 1) {
          responder.readMessage(bytes);
          ws.emit("message", { data: responder.writeMessage() });
          return;
        }
        if (ws.sent === 2) {
          responder.readMessage(bytes);
          [ws.respSend, ws.respRecv] = responder.split();
          return;
        }
        const frame = decodeFrame(ws.respRecv.decrypt(bytes));
        frames.push(frame);
        if (frame.request?.chunk != null && frame.request.end) {
          ws.emit("message", {
            data: ws.respSend.encrypt(
              encodeResponse({
                streamId: frame.request.streamId,
                status: 200,
                headers: [["content-type", "application/json"]],
                chunk: Buffer.from(JSON.stringify({ ok: true })),
                end: true,
              }),
            ),
          });
        }
      });
    },
    close() {
      ws.readyState = 4;
      ws.emit("close", {});
    },
  };
  assert.ok(parseBootstrapFromHtml(flightHtml));
  const gw = await connectGateway({
    cookies: [],
    fetchImpl: async (url) =>
      String(url).replace(/\/$/, "") === "https://muse.ai"
        ? new Response(flightHtml, { status: 200, headers: { "content-type": "text/html" } })
        : new Response('{"status":"ok"}', { status: 200, headers: { "content-type": "application/json" } }),
    socketFactory: () => ws,
  });
  const body = Buffer.alloc(120 * 1024, 0x61);
  const res = await gw.request({ method: "POST", path: "/chat/stream", body });
  assert.equal(res.status, 200);
  assert.equal(frames.length, 4);
  assert.equal(frames[0].request.end, false);
  assert.equal(frames[0].request.body.length, 0);
  assert.equal(frames[0].request.chunk, undefined);
  const sizes = frames.slice(1).map((f) => f.request.chunk.length);
  assert.deepEqual(sizes, [BODY_CHUNK_LIMIT, BODY_CHUNK_LIMIT, body.length - 2 * BODY_CHUNK_LIMIT]);
  assert.equal(frames[1].request.end, false);
  assert.equal(frames[2].request.end, false);
  assert.equal(frames[3].request.end, true);
  gw.close();
});

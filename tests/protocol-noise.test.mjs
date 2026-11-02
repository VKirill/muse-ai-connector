import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_NAME, createHandshake } from "../bridge/protocol/noise.mjs";

const vector = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "noise-xx-25519-aesgcm-sha256.json"), "utf8"),
);

function hex(text) {
  return Buffer.from(text, "hex");
}

test("PROTOCOL_NAME is Noise_XX_25519_AESGCM_SHA256", () => {
  assert.equal(PROTOCOL_NAME, "Noise_XX_25519_AESGCM_SHA256");
});

test("initiator and responder complete an in-process handshake and transport roundtrip", () => {
  const initiator = createHandshake({ initiator: true });
  const responder = createHandshake({ initiator: false });
  responder.readMessage(initiator.writeMessage());
  initiator.readMessage(responder.writeMessage());
  responder.readMessage(initiator.writeMessage());
  const [initSend] = initiator.split();
  const [, respRecv] = responder.split();
  assert.equal(Buffer.from(respRecv.decrypt(initSend.encrypt(Buffer.from("hello")))).toString(), "hello");
  assert.deepEqual(initiator.getHandshakeHash(), responder.getHandshakeHash());
});

test("official cacophony Noise_XX_25519_AESGCM_SHA256 vector matches handshake hash and ciphertexts", () => {
  assert.equal(vector.protocol_name, PROTOCOL_NAME);
  const initiator = createHandshake({
    initiator: true,
    prologue: hex(vector.init_prologue),
    staticKey: hex(vector.init_static),
    ephemeralKey: hex(vector.init_ephemeral),
  });
  const responder = createHandshake({
    initiator: false,
    prologue: hex(vector.resp_prologue),
    staticKey: hex(vector.resp_static),
    ephemeralKey: hex(vector.resp_ephemeral),
  });

  const handshake = vector.messages.slice(0, 3);
  const m1 = initiator.writeMessage(hex(handshake[0].payload));
  assert.equal(Buffer.from(m1).toString("hex"), handshake[0].ciphertext);
  assert.equal(Buffer.from(responder.readMessage(m1)).toString("hex"), handshake[0].payload);

  const m2 = responder.writeMessage(hex(handshake[1].payload));
  assert.equal(Buffer.from(m2).toString("hex"), handshake[1].ciphertext);
  assert.equal(Buffer.from(initiator.readMessage(m2)).toString("hex"), handshake[1].payload);

  const m3 = initiator.writeMessage(hex(handshake[2].payload));
  assert.equal(Buffer.from(m3).toString("hex"), handshake[2].ciphertext);
  assert.equal(Buffer.from(responder.readMessage(m3)).toString("hex"), handshake[2].payload);

  assert.equal(Buffer.from(initiator.getHandshakeHash()).toString("hex"), vector.handshake_hash);
  assert.equal(Buffer.from(responder.getHandshakeHash()).toString("hex"), vector.handshake_hash);

  const [initSend, initRecv] = initiator.split();
  const [respSend, respRecv] = responder.split();
  // Cacophony vectors keep alternating by absolute message index: after a 3-message
  // XX handshake the first transport (index 3) is sent by the responder.
  const t1 = respSend.encrypt(hex(vector.messages[3].payload));
  assert.equal(Buffer.from(t1).toString("hex"), vector.messages[3].ciphertext);
  assert.equal(Buffer.from(initRecv.decrypt(t1)).toString("hex"), vector.messages[3].payload);

  const t2 = initSend.encrypt(hex(vector.messages[4].payload));
  assert.equal(Buffer.from(t2).toString("hex"), vector.messages[4].ciphertext);
  assert.equal(Buffer.from(respRecv.decrypt(t2)).toString("hex"), vector.messages[4].payload);

  const t3 = respSend.encrypt(hex(vector.messages[5].payload));
  assert.equal(Buffer.from(t3).toString("hex"), vector.messages[5].ciphertext);
  assert.equal(Buffer.from(initRecv.decrypt(t3)).toString("hex"), vector.messages[5].payload);
});

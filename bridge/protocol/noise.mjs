import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto";

export const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";

const HASHLEN = 32;
const DHLEN = 32;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const XX = [
  { fromInitiator: true, tokens: ["e"] },
  { fromInitiator: false, tokens: ["e", "ee", "s", "es"] },
  { fromInitiator: true, tokens: ["s", "se"] },
];

function buf(value) {
  if (value == null) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function hash(data) {
  return createHash("sha256").update(data).digest();
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function hkdf(chainingKey, ikm, n) {
  const tempKey = hmac(chainingKey, ikm);
  const out = [];
  let last = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    last = hmac(tempKey, Buffer.concat([last, Buffer.from([i])]));
    out.push(last);
  }
  return out;
}

function privateKeyObject(raw) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, buf(raw)]), format: "der", type: "pkcs8" });
}

function publicKeyObject(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, buf(raw)]), format: "der", type: "spki" });
}

function publicFromPrivate(raw) {
  const der = createPublicKey(privateKeyObject(raw)).export({ type: "spki", format: "der" });
  return der.subarray(der.length - DHLEN);
}

function generateDh() {
  const pair = generateKeyPairSync("x25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-DHLEN);
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-DHLEN);
  return { privateKey, publicKey };
}

function dh(privateRaw, publicRaw) {
  return diffieHellman({ privateKey: privateKeyObject(privateRaw), publicKey: publicKeyObject(publicRaw) });
}

function nonceBytes(n) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(n, 4);
  return nonce;
}

function createCipherState(key) {
  let k = key ? buf(key) : null;
  let n = 0n;
  return {
    encrypt(plaintext, ad) {
      if (!k) throw new Error("cipher has no key");
      const aad = buf(ad);
      const cipher = createCipheriv("aes-256-gcm", k, nonceBytes(n));
      if (aad.length) cipher.setAAD(aad);
      const pt = buf(plaintext);
      const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
      n += 1n;
      return new Uint8Array(ct);
    },
    decrypt(ciphertext, ad) {
      if (!k) throw new Error("cipher has no key");
      const aad = buf(ad);
      const data = buf(ciphertext);
      const tag = data.subarray(data.length - 16);
      const enc = data.subarray(0, data.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", k, nonceBytes(n));
      if (aad.length) decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(enc), decipher.final()]);
      n += 1n;
      return new Uint8Array(pt);
    },
  };
}

function initializeHash(prologue) {
  const name = Buffer.from(PROTOCOL_NAME, "utf8");
  let h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : hash(name);
  let ck = Buffer.from(h);
  h = hash(Buffer.concat([h, buf(prologue)]));
  return { h, ck, k: null, n: 0n };
}

export function createHandshake({ initiator, prologue, staticKey, ephemeralKey } = {}) {
  const isInitiator = Boolean(initiator);
  const staticPair = staticKey
    ? { privateKey: buf(staticKey), publicKey: publicFromPrivate(staticKey) }
    : generateDh();
  let ephemeral = ephemeralKey
    ? { privateKey: buf(ephemeralKey), publicKey: publicFromPrivate(ephemeralKey) }
    : null;
  let remoteEphemeral = null;
  let remoteStatic = null;
  const sym = initializeHash(prologue);
  let messageIndex = 0;
  let splitCiphers = null;

  function mixHash(data) {
    sym.h = hash(Buffer.concat([sym.h, buf(data)]));
  }

  function mixKey(ikm) {
    const [ck, tempK] = hkdf(sym.ck, buf(ikm), 2);
    sym.ck = ck;
    sym.k = tempK;
    sym.n = 0n;
  }

  function encryptWithAd(plaintext) {
    if (!sym.k) {
      mixHash(plaintext);
      return buf(plaintext);
    }
    const cipher = createCipheriv("aes-256-gcm", sym.k, nonceBytes(sym.n));
    cipher.setAAD(sym.h);
    const pt = buf(plaintext);
    const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
    sym.n += 1n;
    mixHash(ct);
    return ct;
  }

  function decryptWithAd(ciphertext) {
    const data = buf(ciphertext);
    if (!sym.k) {
      mixHash(data);
      return data;
    }
    const tag = data.subarray(data.length - 16);
    const enc = data.subarray(0, data.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", sym.k, nonceBytes(sym.n));
    decipher.setAAD(sym.h);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(enc), decipher.final()]);
    sym.n += 1n;
    mixHash(data);
    return pt;
  }

  function applyTokens(tokens, buffer, writing) {
    let offset = 0;
    const out = [];
    for (const token of tokens) {
      if (token === "e") {
        if (writing) {
          if (!ephemeral) ephemeral = generateDh();
          mixHash(ephemeral.publicKey);
          out.push(ephemeral.publicKey);
        } else {
          remoteEphemeral = buffer.subarray(offset, offset + DHLEN);
          offset += DHLEN;
          mixHash(remoteEphemeral);
        }
      } else if (token === "s") {
        if (writing) {
          out.push(encryptWithAd(staticPair.publicKey));
        } else {
          const hasKey = Boolean(sym.k);
          const size = DHLEN + (hasKey ? 16 : 0);
          const piece = buffer.subarray(offset, offset + size);
          offset += size;
          remoteStatic = decryptWithAd(piece);
        }
      } else if (token === "ee") {
        mixKey(dh(ephemeral.privateKey, remoteEphemeral));
      } else if (token === "es") {
        mixKey(isInitiator ? dh(ephemeral.privateKey, remoteStatic) : dh(staticPair.privateKey, remoteEphemeral));
      } else if (token === "se") {
        mixKey(isInitiator ? dh(staticPair.privateKey, remoteEphemeral) : dh(ephemeral.privateKey, remoteStatic));
      } else {
        throw new Error(`unsupported Noise token ${token}`);
      }
    }
    return { offset, out };
  }

  function nextPattern(writing) {
    if (messageIndex >= XX.length) throw new Error("handshake already finished");
    const pattern = XX[messageIndex];
    if (pattern.fromInitiator !== (writing ? isInitiator : !isInitiator)) {
      throw new Error(writing ? "not this party's turn to write" : "not this party's turn to read");
    }
    return pattern;
  }

  return {
    writeMessage(payload) {
      const pattern = nextPattern(true);
      const { out } = applyTokens(pattern.tokens, Buffer.alloc(0), true);
      out.push(encryptWithAd(payload ?? Buffer.alloc(0)));
      messageIndex += 1;
      return new Uint8Array(Buffer.concat(out));
    },
    readMessage(bytes) {
      const pattern = nextPattern(false);
      const buffer = buf(bytes);
      const { offset } = applyTokens(pattern.tokens, buffer, false);
      const payload = decryptWithAd(buffer.subarray(offset));
      messageIndex += 1;
      return new Uint8Array(payload);
    },
    split() {
      if (messageIndex !== XX.length) throw new Error("handshake is incomplete");
      if (!splitCiphers) {
        const [k1, k2] = hkdf(sym.ck, Buffer.alloc(0), 2);
        const c1 = createCipherState(k1);
        const c2 = createCipherState(k2);
        splitCiphers = isInitiator ? [c1, c2] : [c2, c1];
      }
      return splitCiphers;
    },
    getHandshakeHash() {
      return new Uint8Array(sym.h);
    },
    remoteStaticPublicKey() {
      return remoteStatic ? new Uint8Array(remoteStatic) : null;
    },
  };
}

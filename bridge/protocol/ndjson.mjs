import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

function packed(chunks) {
  return Buffer.concat((chunks ?? []).map((chunk) => Buffer.from(chunk)));
}

function isZstd(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
}

export function decodeBody(chunks, contentEncoding) {
  const raw = packed(chunks);
  const encoding = String(contentEncoding ?? "").toLowerCase();
  const body = encoding.includes("zstd") || isZstd(raw) ? zlib.zstdDecompressSync(raw) : raw;
  const text = body.toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text);
}

export function createStreamDecoder() {
  const listeners = [];
  const pending = [];
  let inflate = null;
  let plain = false;
  let buffered = 0;
  let text = "";

  function emit(event) {
    for (const cb of listeners) cb(event);
  }

  function emitLines(final = false) {
    let idx;
    while ((idx = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, idx);
      text = text.slice(idx + 1);
      if (line.length) emit(JSON.parse(line));
    }
    if (final && text.trim().length) {
      emit(JSON.parse(text));
      text = "";
    }
  }

  function onText(chunk) {
    text += Buffer.from(chunk).toString("utf8");
    emitLines();
  }

  function open() {
    const head = Buffer.concat(pending);
    pending.length = 0;
    if (isZstd(head)) {
      inflate = zlib.createZstdDecompress();
      inflate.on("data", onText);
      if (head.length) inflate.write(head);
    } else {
      plain = true;
      onText(head);
    }
  }

  return {
    onEvent(cb) {
      listeners.push(cb);
    },
    push(chunk) {
      const buf = Buffer.from(chunk);
      if (inflate) inflate.write(buf);
      else if (plain) onText(buf);
      else {
        pending.push(buf);
        buffered += buf.length;
        if (buffered >= 4) open();
      }
    },
    flush() {
      return new Promise((resolve, reject) => {
        if (!inflate && !plain) open();
        if (plain) {
          emitLines(true);
          resolve();
          return;
        }
        inflate.once("error", reject);
        inflate.once("end", () => {
          emitLines(true);
          resolve();
        });
        inflate.end();
      });
    },
  };
}

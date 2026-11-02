import zlib from "node:zlib";

function packed(chunks) {
  return Buffer.concat((chunks ?? []).map((chunk) => Buffer.from(chunk)));
}

export function decodeBody(chunks, contentEncoding) {
  const raw = packed(chunks);
  const encoding = String(contentEncoding ?? "").toLowerCase();
  const body = encoding.includes("zstd") ? zlib.zstdDecompressSync(raw) : raw;
  const text = body.toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text);
}

export function createStreamDecoder() {
  const inflate = zlib.createZstdDecompress();
  let text = "";
  const listeners = [];

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

  inflate.on("data", (chunk) => {
    text += Buffer.from(chunk).toString("utf8");
    emitLines();
  });

  return {
    onEvent(cb) {
      listeners.push(cb);
    },
    push(chunk) {
      inflate.write(Buffer.from(chunk));
    },
    flush() {
      return new Promise((resolve, reject) => {
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

function asBytes(value) {
  if (value == null) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function writeVarint(value) {
  let n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new Error(`negative varint: ${n}`);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function tag(field, wire) {
  return writeVarint((BigInt(field) << 3n) | BigInt(wire));
}

function fieldVarint(field, value) {
  return Buffer.concat([tag(field, 0), writeVarint(value)]);
}

function fieldBytes(field, bytes) {
  const payload = asBytes(bytes);
  return Buffer.concat([tag(field, 2), writeVarint(payload.length), payload]);
}

function fieldString(field, text) {
  return fieldBytes(field, Buffer.from(String(text ?? ""), "utf8"));
}

function encodeHeaders(headers) {
  return (headers ?? []).map(([name, value]) => fieldBytes(3, Buffer.concat([fieldString(1, name), fieldString(2, value)])));
}

export function encodeRequest({ id, streamId, method, path, headers, body, end = true } = {}) {
  const frameId = id == null ? randomId() : id;
  const http = Buffer.concat([
    fieldString(1, method ?? ""),
    fieldString(2, path ?? ""),
    ...encodeHeaders(headers),
    ...(asBytes(body).length ? [fieldBytes(4, body)] : []),
    ...(end ? [fieldVarint(5, 1)] : [fieldVarint(5, 0)]),
  ]);
  const request = Buffer.concat([fieldVarint(1, streamId ?? 0), fieldBytes(2, http)]);
  const bodyMsg = fieldBytes(2, request);
  return new Uint8Array(
    Buffer.concat([fieldVarint(1, frameId), fieldVarint(2, 0), fieldVarint(3, 1), fieldBytes(4, bodyMsg)]),
  );
}

export function encodeResponse({ streamId, status, headers, chunk, end } = {}) {
  const parts = [fieldVarint(1, streamId ?? 0)];
  if (status != null || headers) {
    const head = Buffer.concat([fieldVarint(1, status ?? 0), ...encodeHeaders(headers)]);
    parts.push(fieldBytes(3, head));
  }
  if (chunk != null || end != null) {
    const data = Buffer.concat([
      ...(chunk != null ? [fieldBytes(1, chunk)] : []),
      ...(end != null ? [fieldVarint(2, end ? 1 : 0)] : []),
    ]);
    parts.push(fieldBytes(4, data));
  }
  return new Uint8Array(Buffer.concat([fieldVarint(1, 0), fieldVarint(2, 0), fieldVarint(3, 1), fieldBytes(4, fieldBytes(1, Buffer.concat(parts)))]));
}

function randomId() {
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256);
  buf[0] &= 0x7f;
  return buf.readBigUInt64BE();
}

function readVarint(buf, offset) {
  let n = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    n |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: n, offset: i };
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

function skipField(buf, offset, wire) {
  if (wire === 0) return readVarint(buf, offset).offset;
  if (wire === 1) return offset + 8;
  if (wire === 5) return offset + 4;
  if (wire === 2) {
    const len = readVarint(buf, offset);
    return len.offset + Number(len.value);
  }
  throw new Error(`unknown wire type ${wire}`);
}

function readFields(bytes) {
  const buf = asBytes(bytes);
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    offset = key.offset;
    if (wire === 0) {
      const v = readVarint(buf, offset);
      fields.push({ field, wire, value: v.value });
      offset = v.offset;
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      const start = len.offset;
      const end = start + Number(len.value);
      fields.push({ field, wire, value: buf.subarray(start, end) });
      offset = end;
    } else {
      offset = skipField(buf, offset, wire);
    }
  }
  return fields;
}

function asNumber(value) {
  if (value == null) return undefined;
  const n = typeof value === "bigint" ? value : BigInt(value);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

function decodeHeaders(fields) {
  return fields
    .filter((f) => f.field === 3 && f.wire === 2)
    .map((f) => {
      const inner = readFields(f.value);
      const name = inner.find((x) => x.field === 1)?.value;
      const value = inner.find((x) => x.field === 2)?.value;
      return [asBytes(name).toString("utf8"), asBytes(value).toString("utf8")];
    });
}

function decodeHttp(bytes) {
  const fields = readFields(bytes);
  const method = asBytes(fields.find((f) => f.field === 1)?.value).toString("utf8");
  const path = asBytes(fields.find((f) => f.field === 2)?.value).toString("utf8");
  const bodyField = fields.find((f) => f.field === 4);
  const endField = fields.find((f) => f.field === 5);
  return {
    method,
    path,
    headers: decodeHeaders(fields),
    body: bodyField ? new Uint8Array(asBytes(bodyField.value)) : new Uint8Array(),
    end: endField ? asNumber(endField.value) === 1 : false,
  };
}

function decodeRequest(bytes) {
  const fields = readFields(bytes);
  const streamId = asNumber(fields.find((f) => f.field === 1)?.value) ?? 0;
  const dataField = fields.find((f) => f.field === 4);
  if (dataField && !fields.find((f) => f.field === 2)) {
    const data = readFields(dataField.value);
    const chunk = data.find((f) => f.field === 1);
    const end = data.find((f) => f.field === 2);
    return {
      streamId,
      method: "",
      path: "",
      headers: [],
      body: new Uint8Array(),
      chunk: chunk ? new Uint8Array(asBytes(chunk.value)) : new Uint8Array(),
      end: end ? asNumber(end.value) === 1 : false,
    };
  }
  const httpField = fields.find((f) => f.field === 2);
  const http = httpField ? decodeHttp(httpField.value) : { method: "", path: "", headers: [], body: new Uint8Array(), end: false };
  return { streamId, ...http };
}

export function encodeBodyChunk({ id, streamId, chunk, end } = {}) {
  const frameId = id == null ? randomId() : id;
  const data = Buffer.concat([fieldBytes(1, chunk ?? Buffer.alloc(0)), fieldVarint(2, end ? 1 : 0)]);
  const msg = Buffer.concat([fieldVarint(1, streamId ?? 0), fieldBytes(4, data)]);
  return new Uint8Array(Buffer.concat([fieldVarint(1, frameId), fieldVarint(2, 0), fieldVarint(3, 1), fieldBytes(4, fieldBytes(2, msg))]));
}

function decodeResponse(bytes) {
  const fields = readFields(bytes);
  const response = { streamId: asNumber(fields.find((f) => f.field === 1)?.value) ?? 0 };
  const headField = fields.find((f) => f.field === 3);
  if (headField) {
    const head = readFields(headField.value);
    response.status = asNumber(head.find((f) => f.field === 1)?.value);
    response.headers = decodeHeaders(head);
  }
  const dataField = fields.find((f) => f.field === 4);
  if (dataField) {
    const data = readFields(dataField.value);
    const chunk = data.find((f) => f.field === 1);
    if (chunk) response.chunk = new Uint8Array(asBytes(chunk.value));
    const end = data.find((f) => f.field === 2);
    if (end) response.end = asNumber(end.value) === 1;
  }
  return response;
}

export function decodeFrame(bytes) {
  const fields = readFields(bytes);
  const id = asNumber(fields.find((f) => f.field === 1)?.value) ?? 0;
  const bodyField = fields.find((f) => f.field === 4);
  const result = { id };
  if (!bodyField) return result;
  const body = readFields(bodyField.value);
  const req = body.find((f) => f.field === 2);
  const res = body.find((f) => f.field === 1);
  if (req) result.request = decodeRequest(req.value);
  if (res) result.response = decodeResponse(res.value);
  return result;
}

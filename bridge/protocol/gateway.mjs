import { randomUUID } from "node:crypto";
import { cookieHeader } from "../cookies.mjs";
import { decodeFrame, encodeRequest } from "./envelope.mjs";
import { createHandshake } from "./noise.mjs";
import { createStreamDecoder, decodeBody } from "./ndjson.mjs";

const MUSE_ORIGIN = "https://muse.ai";
const DEFAULT_WS = "wss://hatch.metaaivm.com/v1/noise";
const APP_ID = "hatch-web";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function authError(status) {
  const err = new Error("Muse API unauthorized");
  err.code = "auth_failed";
  err.status = status;
  return err;
}

function deadSocketError() {
  const err = new Error("Muse gateway socket closed");
  err.code = "gateway_closed";
  return err;
}

/**
 * @param {{
 *   base: string,
 *   vmId: string,
 *   authToken: string,
 *   appId?: string,
 *   requestId: string,
 *   notaryToken?: string,
 * }} opts
 */
export function buildGatewayUrl({ base, vmId, authToken, appId, requestId, notaryToken }) {
  const url = new URL(base);
  url.searchParams.set("vm_id", vmId);
  url.searchParams.set("auth_token", authToken);
  url.searchParams.set("app_id", appId ?? APP_ID);
  url.searchParams.set("request_id", requestId);
  if (notaryToken) url.searchParams.set("notary_token", notaryToken);
  return url.toString();
}

function jsonOrThrow(res, payload) {
  if (res.status === 401 || res.status === 403) throw authError(res.status);
  if (!res.ok) {
    const err = new Error(`Muse bootstrap failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return undefined;
}

function parseJsonAt(text, start) {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function flightChunks(html) {
  const chunks = [];
  const re = /__next_f\.push\(\[\s*\d+\s*,\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(html))) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`));
    } catch {
      chunks.push(match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
    }
  }
  return chunks;
}

function contextFromFlightText(text) {
  const marker = text.indexOf("ef:");
  const start = text.indexOf("{", marker >= 0 ? marker : 0);
  if (start < 0) return null;
  return parseJsonAt(text, start);
}

function pickVm(ctx) {
  const vms = ctx?.cvmMigrationInventorySnapshot?.vms;
  if (!Array.isArray(vms) || vms.length === 0) return null;
  const named = ctx.vmName ? vms.find((vm) => vm.vmName === ctx.vmName) : null;
  const running = vms.find((vm) => vm.vmState === "RUNNING");
  return named ?? running ?? vms[0];
}

/**
 * @param {string} html
 * @returns {{ vmId: string, vmName?: string, gatewayUrl: string, authToken: string, notaryToken?: string, backendAuthStatus?: string } | null}
 */
export function parseBootstrapFromHtml(html) {
  if (!html) return null;
  const chunks = flightChunks(html);
  const text = chunks.length > 0 ? chunks.join("\n") : String(html).replace(/\\"/g, '"');
  const ctx = contextFromFlightText(text);
  if (!ctx || typeof ctx !== "object") return null;
  const authToken = pick(ctx, "authToken", "auth_token");
  if (!authToken) return null;
  const vm = pickVm(ctx);
  const vmId = vm?.vmId ?? pick(ctx, "vmId", "vm_id");
  const gatewayUrl = pick(ctx, "gatewayUrl", "gateway_url") ?? vm?.gatewayUrl;
  if (!vmId || !gatewayUrl) return null;
  return {
    vmId,
    vmName: ctx.vmName ?? vm?.vmName,
    gatewayUrl,
    authToken,
    notaryToken: pick(ctx, "noiseNotaryToken", "notary_token", "notaryToken"),
    backendAuthStatus: ctx.backendAuthStatus,
  };
}

function cookieHdr(cookies) {
  const header = cookieHeader(cookies ?? [], `${MUSE_ORIGIN}/`);
  return header || undefined;
}

function apiHeaders(cookies) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: MUSE_ORIGIN,
    Referer: `${MUSE_ORIGIN}/`,
    "User-Agent": CHROME_UA,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "x-app-id": APP_ID,
  };
  const cookie = cookieHdr(cookies);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function assignmentFromToken(payload) {
  const ctx = payload?.gatewayContext ?? payload?.context ?? payload;
  const vmId = pick(ctx, "vmId", "vm_id") ?? pick(ctx?.vmAssignment, "vmId", "vm_id");
  const gatewayUrl = pick(ctx, "gatewayUrl", "gateway_url") ?? DEFAULT_WS;
  const authToken = pick(ctx, "authToken", "auth_token");
  const notaryToken = pick(ctx, "noiseNotaryToken", "notary_token", "notaryToken");
  if (!vmId || !authToken) return null;
  return { vmId, gatewayUrl, authToken, notaryToken, vmName: pick(ctx, "vmName", "vm_name") };
}

async function postApi(fetchImpl, path, cookies, body) {
  const res = await fetchImpl(`${MUSE_ORIGIN}${path}`, {
    method: "POST",
    headers: apiHeaders(cookies),
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw authError(res.status);
  return res;
}

export async function bootstrapHttps({ cookies, fetchImpl = globalThis.fetch } = {}) {
  const pageHeaders = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": CHROME_UA,
  };
  const cookie = cookieHdr(cookies);
  if (cookie) pageHeaders.Cookie = cookie;

  const pageRes = await fetchImpl(`${MUSE_ORIGIN}/`, { method: "GET", headers: pageHeaders });
  if (pageRes.status === 401 || pageRes.status === 403) throw authError(pageRes.status);
  const html = await pageRes.text();
  let ctx = parseBootstrapFromHtml(html);
  if (ctx?.backendAuthStatus && ctx.backendAuthStatus !== "authenticated") {
    throw authError(403);
  }

  if (!ctx?.authToken) {
    const tokenRes = await postApi(fetchImpl, "/api/hatch/token", cookies, {});
    ctx = assignmentFromToken(jsonOrThrow(tokenRes, await readJson(tokenRes)));
  }

  if (!ctx?.vmId || !ctx?.authToken) {
    const err = new Error("Muse bootstrap did not return a VM assignment");
    err.status = 403;
    throw err;
  }

  await postApi(fetchImpl, "/api/hatch/vm/wake", cookies, {
    vm_id: ctx.vmId,
    retry_count: 0,
    connect_attempt_id: randomUUID(),
  });
  await postApi(fetchImpl, "/api/hatch/stateful-sharing", cookies, {});

  return {
    gatewayUrl: ctx.gatewayUrl ?? DEFAULT_WS,
    vmId: ctx.vmId,
    vmName: ctx.vmName,
    authToken: ctx.authToken,
    notaryToken: ctx.notaryToken,
  };
}

function waitEvent(target, name) {
  return new Promise((resolve, reject) => {
    const onOk = (ev) => {
      target.removeEventListener?.("error", onErr);
      resolve(ev);
    };
    const onErr = (ev) => {
      target.removeEventListener?.(name, onOk);
      reject(ev?.error ?? ev ?? new Error("WebSocket error"));
    };
    target.addEventListener(name, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
  });
}

async function handshake(ws) {
  if (ws.readyState !== 1) await waitEvent(ws, "open");
  const hs = createHandshake({ initiator: true });
  ws.send(hs.writeMessage());
  const msg2 = await waitEvent(ws, "message");
  hs.readMessage(Buffer.from(msg2.data));
  ws.send(hs.writeMessage());
  process.stderr.write("Noise server identity not verified\n");
  return hs.split();
}

function headerList(headers) {
  const extra = headers ?? [];
  if (Array.isArray(extra)) return extra;
  return Object.entries(extra);
}

function defaultHeaders(headers, hasBody) {
  const list = [
    ["x-request-id", randomUUID()],
    ["x-app-id", APP_ID],
    ["Accept-Language", "en-US"],
    ["Accept-Encoding", "zstd"],
    ...headerList(headers),
  ];
  if (hasBody && !list.some(([name]) => name.toLowerCase() === "content-type")) {
    list.push(["Content-Type", "application/json"]);
  }
  return list;
}

function headerValue(headers, name) {
  const want = name.toLowerCase();
  for (const [key, value] of headers ?? []) {
    if (String(key).toLowerCase() === want) return value;
  }
  return "";
}

function encodeBody(body) {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function openTunnel(ws, sendCipher, recvCipher) {
  let nextStreamId = 1;
  const pending = new Map();
  const pushHandlers = [];
  let closed = false;

  function failAll(err) {
    for (const stream of pending.values()) stream.reject(err);
    pending.clear();
  }

  function handlePlain(bytes) {
    const frame = decodeFrame(bytes);
    if (frame.response) {
      const stream = pending.get(frame.response.streamId);
      if (!stream) return;
      if (frame.response.status != null) {
        stream.status = frame.response.status;
        stream.resHeaders = frame.response.headers ?? [];
      }
      if (frame.response.chunk) stream.onChunk?.(frame.response.chunk);
      if (frame.response.end) {
        pending.delete(frame.response.streamId);
        stream.resolve({
          status: stream.status,
          headers: stream.resHeaders,
          chunks: stream.chunks,
        });
      }
      return;
    }
    if (frame.request) {
      for (const cb of pushHandlers) cb(frame.request);
    }
  }

  ws.addEventListener("message", (ev) => {
    try {
      handlePlain(recvCipher.decrypt(Buffer.from(ev.data)));
    } catch (err) {
      failAll(err);
    }
  });
  ws.addEventListener("close", () => {
    closed = true;
    failAll(deadSocketError());
  });

  function sendRequest({ method, path, headers, body, onChunk }) {
    if (closed || ws.readyState !== 1) return Promise.reject(deadSocketError());
    const streamId = nextStreamId++;
    const payload = encodeBody(body);
    const chunks = [];
    const result = new Promise((resolve, reject) => {
      pending.set(streamId, {
        resolve,
        reject,
        onChunk: (chunk) => {
          chunks.push(chunk);
          onChunk?.(chunk);
        },
        chunks,
        status: 0,
        resHeaders: [],
      });
    });
    ws.send(
      sendCipher.encrypt(
        encodeRequest({
          streamId,
          method,
          path,
          headers: defaultHeaders(headers, payload != null),
          body: payload,
        }),
      ),
    );
    return result;
  }

  return {
    closed: () => closed,
    onEvent(handler) {
      pushHandlers.push(handler);
    },
    close() {
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      failAll(deadSocketError());
    },
    async request({ method, path, headers, body } = {}) {
      const result = await sendRequest({ method, path, headers, body });
      if (result.status === 401 || result.status === 403) throw authError(result.status);
      return {
        status: result.status,
        headers: result.headers,
        json() {
          return decodeBody(result.chunks, headerValue(result.headers, "content-encoding"));
        },
      };
    },
    stream({ method, path, headers, body } = {}, onEvent) {
      const decoder = createStreamDecoder();
      let stopped = false;
      decoder.onEvent((event) => {
        if (!stopped) onEvent?.(event);
      });
      let stop;
      const finished = new Promise((resolve, reject) => {
        stop = () => {
          stopped = true;
          resolve();
        };
        sendRequest({
          method,
          path,
          headers,
          body,
          onChunk: (chunk) => {
            if (!stopped) decoder.push(chunk);
          },
        })
          .then(async () => {
            if (!stopped) await decoder.flush();
            resolve();
          })
          .catch((err) => {
            if (stopped) resolve();
            else reject(err);
          });
      });
      return {
        stop,
        finished,
      };
    },
  };
}

async function openSocket(url, socketFactory) {
  const ws = socketFactory ? socketFactory(url) : new WebSocket(url);
  const [sendCipher, recvCipher] = await handshake(ws);
  return openTunnel(ws, sendCipher, recvCipher);
}

/**
 * @param {{ cookies: object[], fetchImpl?: typeof fetch, socketFactory?: (url: string) => WebSocket }} opts
 */
export async function connectGateway({ cookies, fetchImpl, socketFactory } = {}) {
  let retried = false;
  let tunnel = null;

  async function connect() {
    const ctx = await bootstrapHttps({ cookies, fetchImpl });
    const url = buildGatewayUrl({
      base: ctx.gatewayUrl,
      vmId: ctx.vmId,
      authToken: ctx.authToken,
      appId: APP_ID,
      requestId: randomUUID(),
      notaryToken: ctx.notaryToken,
    });
    tunnel = await openSocket(url, socketFactory);
    return tunnel;
  }

  async function reconnect() {
    try {
      tunnel?.close();
    } catch {
      /* ignore */
    }
    return connect();
  }

  async function withReconnect(fn) {
    try {
      return await fn(tunnel);
    } catch (err) {
      if (retried || err?.code === "auth_failed") throw err;
      retried = true;
      tunnel = await reconnect();
      return fn(tunnel);
    }
  }

  tunnel = await connect();

  return {
    onEvent(handler) {
      tunnel.onEvent(handler);
    },
    close() {
      tunnel.close();
    },
    request(opts) {
      return withReconnect((t) => t.request(opts));
    },
    stream(opts, onEvent) {
      return withReconnect((t) => t.stream(opts, onEvent));
    },
  };
}

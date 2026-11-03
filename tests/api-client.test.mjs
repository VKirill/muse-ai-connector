import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { saveCookies } from "../bridge/cookies.mjs";
import { chatStreamBody, createMuseClient, openTransport, resolveTransport } from "../bridge/protocol/api.mjs";
import { decodeFrame, encodeResponse } from "../bridge/protocol/envelope.mjs";
import { bootstrapHttps, buildGatewayUrl, parseBootstrapFromHtml } from "../bridge/protocol/gateway.mjs";
import { createStreamDecoder } from "../bridge/protocol/ndjson.mjs";

const flightHtml = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "muse-flight.html"),
  "utf8",
);

async function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-api-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

test("buildGatewayUrl sets vm_id, auth_token, app_id, request_id and optional notary_token", () => {
  const u = new URL(
    buildGatewayUrl({
      base: "wss://hatch.metaaivm.com/v1/noise",
      vmId: "vm1",
      authToken: "s0:t",
      appId: "hatch-web",
      requestId: "r1",
      notaryToken: "n1",
    }),
  );
  assert.equal(u.searchParams.get("vm_id"), "vm1");
  assert.equal(u.searchParams.get("auth_token"), "s0:t");
  assert.equal(u.searchParams.get("app_id"), "hatch-web");
  assert.equal(u.searchParams.get("request_id"), "r1");
  assert.equal(u.searchParams.get("notary_token"), "n1");
});

test("chatStreamBody includes message, session, node and delta_stream", () => {
  const body = chatStreamBody({ text: "hi", sessionId: "s1", nodeId: "n1", timezone: "Europe/Madrid" });
  assert.equal(body.message, "hi");
  assert.equal(body.session_id, "s1");
  assert.equal(body.node_id, "n1");
  assert.equal(body.timezone, "Europe/Madrid");
  assert.ok(body.capabilities.includes("delta_stream"));
});

test("resolveTransport defaults to api and switches on flag or MUSE_TRANSPORT", () => {
  assert.equal(resolveTransport({}), "api");
  assert.equal(resolveTransport({ flag: "browser" }), "browser");
  assert.equal(resolveTransport({ env: { MUSE_TRANSPORT: "browser" } }), "browser");
  assert.equal(resolveTransport({ flag: "api", env: { MUSE_TRANSPORT: "browser" } }), "api");
});

test("parseBootstrapFromHtml reads vm context from escaped Next flight HTML", () => {
  const parsed = parseBootstrapFromHtml(flightHtml);
  assert.equal(parsed.vmId, "vm-123");
  assert.equal(parsed.vmName, "name-1");
  assert.equal(parsed.gatewayUrl, "wss://gw.example/");
  assert.equal(parsed.authToken, "s0:abc");
  assert.equal(parsed.notaryToken, "nt-1");
});

test("bootstrapHttps uses the page flight context and sends Origin/Referer on /api/ calls", async () => {
  const seen = [];
  const fakeFetch = async (url, opts = {}) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    });
    if (String(url).replace(/\/$/, "") === "https://muse.ai") {
      return new Response(flightHtml, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response('{"status":"ok"}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const boot = await bootstrapHttps({ cookies: [], fetchImpl: fakeFetch });
  assert.equal(boot.vmId, "vm-123");
  assert.equal(boot.authToken, "s0:abc");
  assert.equal(boot.notaryToken, "nt-1");
  const apiCalls = seen.filter((s) => s.url.includes("/api/"));
  assert.ok(apiCalls.length > 0);
  for (const call of apiCalls) {
    assert.equal(call.headers.origin, "https://muse.ai");
    assert.equal(String(call.headers.referer ?? "").startsWith("https://muse.ai"), true);
  }
  assert.equal(
    seen.some((s) => s.url.replace(/\/$/, "") === "https://muse.ai/api/hatch/token"),
    false,
  );
});

test("openTransport browser calls the fake browser driver and not the gateway", async () => {
  let gateway = false;
  let browser = false;
  const client = await openTransport({
    accountId: "acc1",
    transport: "browser",
    drivers: {
      createMuseClient: async () => {
        gateway = true;
        return { close: async () => {} };
      },
      openSession: async () => {
        browser = true;
        return { close: async () => {} };
      },
    },
  });
  assert.equal(browser, true);
  assert.equal(gateway, false);
  await client.close();
});

function jsonRes(payload, status = 200) {
  return {
    status,
    headers: [["content-type", "application/json"]],
    json: async () => payload,
  };
}

function replayEvents(events, onEvent) {
  const ndjson = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const compressed = zlib.zstdCompressSync(Buffer.from(ndjson));
  const frame = encodeResponse({
    streamId: 4,
    status: 200,
    headers: [
      ["content-encoding", "zstd"],
      ["content-type", "application/x-ndjson"],
    ],
    chunk: compressed,
    end: true,
  });
  const decoded = decodeFrame(frame).response;
  const decoder = createStreamDecoder();
  decoder.onEvent(onEvent);
  decoder.push(decoded.chunk);
  return decoder.flush();
}

function createFakeGateway() {
  const requests = [];
  return {
    requests,
    async request({ method, path, body }) {
      requests.push({ method, path, body });
      if (path === "/api/nodes/register") {
        return jsonRes({ node_id: body.node_id, status: "registered" });
      }
      if (path === "/api/ping") {
        return jsonRes({ presence: "active" });
      }
      if (path === "/chat/stream") {
        return jsonRes({
          channel: "main",
          is_thread: true,
          message_id: "user-1",
          session_id: body.session_id,
        });
      }
      if (path.startsWith("/chat/history")) {
        return jsonRes({
          ok: true,
          result: {
            channel: "all",
            chat_events: [
              { event_name: "message.user", message_id: "user-1", display_text: "hi" },
              { event_name: "message.assistant", message_id: "asst-1", display_text: "hello world" },
            ],
          },
        });
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    stream(_opts, onEvent) {
      const events = [
        { type: "res", payload: { subscribed: true } },
        { type: "event", event: "text.delta", payload: { delta: "hello " } },
        { type: "event", event: "text.delta", payload: { delta: "world" } },
        { type: "event", event: "agent.status", payload: { activity_code: "working" } },
        { type: "event", event: "task.status", payload: { status: "running" } },
        { type: "event", event: "task.status", payload: { status: "completed" } },
        { type: "event", event: "agent.status", payload: { activity_code: "idle" } },
      ];
      let stop;
      const finished = new Promise((resolve, reject) => {
        stop = resolve;
        replayEvents(events, onEvent).then(resolve, reject);
      });
      return { stop, finished };
    },
    close() {},
  };
}

test("createMuseClient send streams deltas through envelope frames and returns chat text", async () => {
  await withHome(async () => {
    saveCookies("acc1", [
      {
        name: "hatch_sess",
        value: "x",
        domain: ".muse.ai",
        path: "/",
        expires: 2_000_000_000,
        secure: true,
      },
    ]);
    const gateway = createFakeGateway();
    const client = await createMuseClient({ accountId: "acc1", gateway });
    const deltas = [];
    const result = await client.send({
      text: "hi",
      onDelta: (suffix) => deltas.push(suffix),
    });
    assert.deepEqual(deltas, ["hello ", "world"]);
    assert.equal(typeof result.chatId, "string");
    assert.ok(result.chatId);
    assert.equal(result.messageId, "asst-1");
    assert.equal(result.text, "hello world");
    assert.ok(gateway.requests.some((r) => r.path === "/api/nodes/register"));
    assert.ok(gateway.requests.some((r) => r.path === "/chat/stream"));
    await client.close();
  });
});

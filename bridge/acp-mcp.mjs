import { spawn } from "node:child_process";

const START_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const PROTOCOL_VERSION = "2025-06-18";

function rpcError(method, error) {
  const err = new Error(error?.message || `${method} failed`);
  err.code = error?.code ?? "mcp_error";
  return err;
}

function timeoutAfter(ms, what) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function contentText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === "text" ? c.text : `[${c?.type ?? "?"}]`)).join("\n");
  }
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}

function initParams() {
  return { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "muse-acp", version: "1" } };
}

function startStdio(spec) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const e of Array.isArray(spec.env) ? spec.env : []) {
      if (e && typeof e.name === "string") env[e.name] = String(e.value ?? "");
    }
    const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args.map(String) : [], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const pending = new Map();
    let seq = 0;
    let buf = "";
    let dead = false;
    const fail = (err) => {
      dead = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    const request = (method, params, timeoutMs) => {
      const id = `mcp-${++seq}`;
      const t = timeoutAfter(timeoutMs, `${spec.name}:${method}`);
      return Promise.race([
        t.promise,
        new Promise((res, rej) => {
          pending.set(id, {
            resolve: (v) => {
              t.cancel();
              res(v);
            },
            reject: (e) => {
              t.cancel();
              rej(e);
            },
          });
          send({ id, method, params });
        }),
      ]);
    };
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(rpcError("request", msg.error));
          else p.resolve(msg.result);
        } else if (msg.method !== undefined && msg.id !== undefined) {
          send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
        }
      }
    });
    child.on("error", (err) => {
      if (dead) return;
      fail(err);
      reject(new Error(`${spec.name}: cannot start ${spec.command}: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      if (dead) return;
      const err = new Error(`${spec.name}: exited (${code ?? signal})`);
      fail(err);
      reject(err);
    });
    (async () => {
      await request("initialize", initParams(), START_TIMEOUT_MS);
      send({ method: "notifications/initialized" });
      const listed = await request("tools/list", {}, START_TIMEOUT_MS);
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      resolve({
        name: spec.name,
        tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} })),
        call: async (toolName, args) => {
          const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, CALL_TIMEOUT_MS);
          return { text: contentText(res), isError: !!res?.isError };
        },
        close: () => fail(new Error("closed")),
      });
    })().catch((err) => {
      fail(err);
      reject(new Error(`${spec.name}: ${err.message}`));
    });
  });
}

function sseJsonMessages(body) {
  const out = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* keep looking */
    }
  }
  return out;
}

function startHttp(spec) {
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const h of Array.isArray(spec.headers) ? spec.headers : []) {
    if (h && typeof h.name === "string") base[h.name.toLowerCase()] = String(h.value ?? "");
  }
  let seq = 0;
  let mcpSessionId = null;
  const post = async (payload, { notification = false, timeoutMs = CALL_TIMEOUT_MS } = {}) => {
    const headers = { ...base };
    if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
    const res = await fetch(spec.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) mcpSessionId = sid;
    if (notification) {
      await res.body?.cancel().catch(() => {});
      return {};
    }
    if (!res.ok) throw new Error(`${spec.name}: HTTP ${res.status}`);
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const messages = contentType.includes("text/event-stream") || body.trimStart().startsWith("data:") || body.trimStart().startsWith("event:")
      ? sseJsonMessages(body)
      : [JSON.parse(body)];
    const reply = messages.find((m) => m && m.id === payload.id) ?? messages.find((m) => m && (m.result !== undefined || m.error !== undefined));
    if (!reply) throw new Error(`${spec.name}: no JSON-RPC reply`);
    if (reply.error) throw rpcError(payload.method, reply.error);
    return reply.result;
  };
  return (async () => {
    await post({ id: `mcp-${++seq}`, method: "initialize", params: initParams() }, { timeoutMs: START_TIMEOUT_MS });
    await post({ method: "notifications/initialized" }, { notification: true, timeoutMs: START_TIMEOUT_MS });
    const listed = await post({ id: `mcp-${++seq}`, method: "tools/list", params: {} }, { timeoutMs: START_TIMEOUT_MS });
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return {
      name: spec.name,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} })),
      call: async (toolName, args) => {
        const res = await post({ id: `mcp-${++seq}`, method: "tools/call", params: { name: toolName, arguments: args ?? {} } });
        return { text: contentText(res), isError: !!res?.isError };
      },
      close: () => {},
    };
  })();
}

function startOne(spec) {
  if (!spec || typeof spec.name !== "string" || !spec.name) throw new Error("mcp server without a name");
  if (spec.command) return startStdio(spec);
  if (spec.url || spec.type === "http") return startHttp(spec);
  throw new Error(`${spec.name}: neither command nor url given`);
}

/**
 * Starts every MCP server from session/new params in parallel; failed ones are
 * skipped with a stderr line. Returns [{name, tools, call, close}].
 */
export async function startMcpServers(servers, { log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const settled = await Promise.all(list.map((spec) => startOne(spec).then((c) => ({ client: c }), (err) => ({ err, spec }))));
  const clients = [];
  for (const s of settled) {
    if (s.client) clients.push(s.client);
    else log(`mcp server ${s.spec?.name ?? "?"} skipped: ${s.err?.message || s.err}`);
  }
  return clients;
}

/** Maps "mcp__<server>__<tool>" -> {client, toolName, description, inputSchema}. */
export function buildMcpIndex(clients) {
  const index = new Map();
  for (const client of clients ?? []) {
    for (const tool of client.tools ?? []) {
      index.set(`mcp__${client.name}__${tool.name}`, { client, ...tool });
    }
  }
  return index;
}

export function describeMcpTool(index, name) {
  const entry = index.get(name);
  if (!entry) return null;
  return { name, description: entry.description, inputSchema: entry.inputSchema };
}

export async function callMcpTool(index, name, args) {
  const entry = index.get(name);
  if (!entry) return { ok: false, output: `unknown tool: ${name}` };
  try {
    const res = await entry.client.call(entry.name, args);
    return { ok: !res.isError, output: res.text };
  } catch (err) {
    return { ok: false, output: String(err?.message || err) };
  }
}

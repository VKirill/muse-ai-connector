import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A gateway that answers the WebSocket upgrade with 502 (live 2026-11-27: "gateway dial
// failed: 502 Bad Gateway"). The child process must reject with the dial error and exit
// cleanly; before the fix ws.close() on the CONNECTING socket raised an unhandled
// 'error' event ("WebSocket was closed before the connection was established").
const child = `
import http from "node:http";
import WebSocket from "ws";
process.env.MUSE_BRIDGE_HOME = "/tmp";
const { connectGateway, defaultSocketFactory } = await import(${JSON.stringify(path.join(root, "bridge/protocol/gateway.mjs"))});
const server = http.createServer();
server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 502 Bad Gateway\\r\\nContent-Length: 0\\r\\n\\r\\n"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const vm = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const page = '<script>self.__next_f.push([1,' + JSON.stringify("7c:" + JSON.stringify({ gatewayUrl: "wss://" + vm + ".metaaivm.com/", vmId: vm, vmName: vm, authToken: "tok", backendAuthStatus: "authenticated" })) + '])</script>';
const fetchImpl = async (url) => String(url).replace(/\\/$/, "") === "https://muse.ai" ? new Response(page, { status: 200 }) : new Response("{}", { status: 200 });
try {
  await connectGateway({ cookies: [], fetchImpl, socketFactory: () => defaultSocketFactory("ws://127.0.0.1:" + port + "/") });
  console.log("RESULT connected");
} catch (err) {
  console.log("RESULT " + err.code + " " + err.message);
}
await new Promise((r) => setTimeout(r, 300));
server.close();
console.log("EXIT clean");
`;

test("a gateway dial refused with 502 rejects with gateway_dial_failed and does not crash the process", () => {
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", child], { cwd: root, encoding: "utf8", timeout: 20_000 });
  assert.match(out.stdout, /RESULT gateway_dial_failed gateway dial failed: 502/);
  assert.match(out.stdout, /EXIT clean/, `process crashed: ${out.stderr.slice(-400)}`);
  assert.equal(out.status, 0);
});

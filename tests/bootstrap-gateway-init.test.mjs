import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

process.env.MUSE_BRIDGE_HOME = fs.mkdtempSync("/tmp/muse-boot-init-");

const { bootstrapHttps, parseBootstrapFromHtml } = await import("../bridge/protocol/gateway.mjs");

const VM_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GATEWAY = `wss://${VM_ID}.metaaivm.com/`;

// Shape of muse.ai/ seen on 2026-11-27 for account main: the first context row is an
// indeterminate summary without a VM, the cached context has no token, and only
// window.__HATCH_GATEWAY_INIT__ carries the token, without a vmId.
function pageWithGatewayInitFirst() {
  const rows = [
    `115:${JSON.stringify({ backendAuthStatus: "indeterminate", initialServerData: { cvmEligibility: "$undefined" } })}`,
    `116:${JSON.stringify({ gatewayUrl: GATEWAY, vmName: VM_ID, authToken: null, backendAuthStatus: "indeterminate", vmAssignment: "assigned", vmId: VM_ID, vmStateSource: "cache" })}`,
    `11c:T7fe,window.__HATCH_GATEWAY_INIT__=${JSON.stringify({ version: 1, gatewayUrl: GATEWAY, vmName: VM_ID, authToken: "muse-secret-edge-tok" })}`,
  ];
  return rows.map((row) => `<script>self.__next_f.push([1,${JSON.stringify(row)}])</script>`).join("");
}

test("a page whose token context has no vmId still yields the VM from its gateway URL", () => {
  const ctx = parseBootstrapFromHtml(pageWithGatewayInitFirst());
  assert.ok(ctx, "parseBootstrapFromHtml returned null");
  assert.equal(ctx.vmId, VM_ID);
  assert.equal(ctx.gatewayUrl, GATEWAY);
  assert.equal(ctx.authToken, "muse-secret-edge-tok");
});

test("bootstrap on that page wakes the VM and never posts an empty token request", async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url).replace(/\/$/, "");
    seen.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    if (u === "https://muse.ai") return new Response(pageWithGatewayInitFirst(), { status: 200 });
    if (u.endsWith("/api/hatch/token")) return new Response('{"error":"Missing vmAddress"}', { status: 400 });
    return new Response('{"status":"ok"}', { status: 200 });
  };
  const boot = await bootstrapHttps({ cookies: [], fetchImpl });
  assert.equal(boot.vmId, VM_ID);
  assert.equal(seen.filter((s) => s.url.endsWith("/api/hatch/token") && !s.body?.vmAddress).length, 0);
  const wake = seen.find((s) => s.url.endsWith("/api/hatch/vm/wake"));
  assert.equal(wake?.body?.vm_id, VM_ID);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

process.env.MUSE_BRIDGE_HOME = fs.mkdtempSync("/tmp/muse-boot-");

const { bootstrapHttps } = await import("../bridge/protocol/gateway.mjs");

const VM_CTX = {
  cvmMigrationInventorySnapshot: {
    vms: [
      {
        vmId: "vm-9",
        vmName: "name-9",
        gatewayUrl: "wss://vm-9.metaaivm.com/",
        vmState: "RUNNING",
      },
    ],
  },
  gatewayUrl: "wss://vm-9.metaaivm.com/",
  vmName: "name-9",
  vmId: "vm-9",
};

function flightPage(ctx) {
  const row = `7c:${JSON.stringify(ctx)}`.replace(/"/g, '\\"');
  return `<script>self.__next_f.push([1,"${row}"])</script>`;
}

function museFetch({ html, token } = {}) {
  const reply = token ?? { status: 200, payload: { token: "tok-914", notary_token: "nt-575" } };
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url).replace(/\/$/, "");
    seen.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    if (u === "https://muse.ai") {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (u.endsWith("/api/hatch/token")) {
      return new Response(JSON.stringify(reply.payload), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response('{"status":"ok"}', { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}

test("indeterminate page posts vmAddress/vmName/force_refresh and uses token answer", async () => {
  const html = flightPage({ ...VM_CTX, authToken: "short", backendAuthStatus: "indeterminate" });
  const { seen, fetchImpl } = museFetch({ html });
  const boot = await bootstrapHttps({ cookies: [], fetchImpl });
  const call = seen.find((s) => s.url.endsWith("/api/hatch/token"));
  assert.ok(call);
  assert.deepEqual(call.body, {
    vmAddress: "wss://vm-9.metaaivm.com/",
    vmName: "name-9",
    force_refresh: true,
  });
  assert.equal(boot.authToken, "tok-914");
  assert.equal(boot.notaryToken, "nt-575");
  assert.equal(boot.vmId, "vm-9");
  assert.equal(boot.vmName, "name-9");
  assert.equal(boot.vmGatewayUrl, "wss://vm-9.metaaivm.com/");
});

test("page without authToken still requests a socket token with vmAddress", async () => {
  const html = flightPage({ ...VM_CTX, backendAuthStatus: "indeterminate" });
  const { seen, fetchImpl } = museFetch({ html });
  const boot = await bootstrapHttps({ cookies: [], fetchImpl });
  const call = seen.find((s) => s.url.endsWith("/api/hatch/token"));
  assert.ok(call);
  assert.deepEqual(call.body, {
    vmAddress: "wss://vm-9.metaaivm.com/",
    vmName: "name-9",
    force_refresh: true,
  });
  assert.equal(boot.authToken, "tok-914");
  assert.equal(boot.notaryToken, "nt-575");
});

test("explicit unauthenticated page throws 403 without calling the token endpoint", async () => {
  const html = flightPage({ ...VM_CTX, authToken: "x", backendAuthStatus: "unauthenticated" });
  const { seen, fetchImpl } = museFetch({ html });
  await assert.rejects(bootstrapHttps({ cookies: [], fetchImpl }), (err) => {
    assert.equal(err.code, "auth_failed");
    assert.equal(err.status, 403);
    return true;
  });
  assert.equal(
    seen.some((s) => s.url.endsWith("/api/hatch/token")),
    false,
  );
});

test("token endpoint 400 surfaces Muse bootstrap failed", async () => {
  const html = flightPage({ ...VM_CTX, authToken: "short", backendAuthStatus: "indeterminate" });
  const { fetchImpl } = museFetch({
    html,
    token: { status: 400, payload: { error: "Missing vmAddress" } },
  });
  await assert.rejects(bootstrapHttps({ cookies: [], fetchImpl }), (err) => {
    assert.equal(err.message, "Muse bootstrap failed (400)");
    assert.equal(err.status, 400);
    return true;
  });
});

test("token answer with legacy assignment fields still bootstraps", async () => {
  const { seen, fetchImpl } = museFetch({
    html: "<html><body>no flight data</body></html>",
    token: {
      status: 200,
      payload: {
        gatewayContext: {
          vmId: "vm-old",
          vmName: "name-old",
          gatewayUrl: "wss://old.example/",
          authToken: "s0:old",
          noiseNotaryToken: "nt-old",
        },
      },
    },
  });
  const boot = await bootstrapHttps({ cookies: [], fetchImpl });
  const call = seen.find((s) => s.url.endsWith("/api/hatch/token"));
  assert.deepEqual(call.body, {});
  assert.equal(boot.vmId, "vm-old");
  assert.equal(boot.vmName, "name-old");
  assert.equal(boot.authToken, "s0:old");
  assert.equal(boot.notaryToken, "nt-old");
  assert.equal(boot.vmGatewayUrl, "wss://old.example/");
});

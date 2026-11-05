import assert from "node:assert/strict";
import test from "node:test";
import plugin, {
  HOST_CHECK_TIMEOUT_MS,
  HOST_INSTALL_TIMEOUT_MS,
  HOST_LOGIN_TIMEOUT_MS,
  HOST_USAGE_TIMEOUT_MS,
} from "../server.ts";

function boot() {
  const calls = [];
  const status = {
    platform: "darwin",
    chromeFound: true,
    chromePath: "/c",
    bridgeFound: true,
    bridgeVersion: "x",
    agentFound: true,
    runtime: { installed: true, dev: false, version: "x" },
    accounts: [],
    problems: [],
  };
  let handlers = null;
  const bb = {
    settings: { define: () => ({ get: async () => ({}) }) },
    hosts: {
      experimental_client: () => ({
        call: async (method, _input, opts) => {
          calls.push({ method, timeoutMs: opts?.timeoutMs });
          if (method === "exportAccount") return { id: "a", label: "a", cookies: [] };
          if (method === "importAccount") return { ok: true, error: null };
          if (method === "usage") return { accounts: [] };
          return status;
        },
        experimental_onWorkerExit: () => () => {},
      }),
    },
    sdk: { hosts: { list: async () => [{ id: "h1", name: "H1", status: "connected" }] } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    background: { service() {} },
    providers: { register() {}, experimental_contributeEnv() {} },
    rpc: { register: (_c, h) => { handlers = h; } },
  };
  plugin(bb);
  assert.ok(handlers, "rpc handlers registered");
  return { calls, status, handlers };
}

test("reloginAccount and addAccount pass timeoutMs above ADD_TIMEOUT_MS", async () => {
  const { calls, status, handlers } = boot();
  status.accounts = [];
  await handlers.reloginAccount({ hostId: "h1", id: "a" });
  const relogin = calls.find((c) => c.method === "reloginAccount");
  assert.equal(relogin.timeoutMs, HOST_LOGIN_TIMEOUT_MS);
  assert.ok(relogin.timeoutMs > 660000);

  calls.length = 0;
  await handlers.addAccount({ hostId: "h1", label: "a" });
  const add = calls.find((c) => c.method === "addAccount");
  assert.equal(add.timeoutMs, HOST_LOGIN_TIMEOUT_MS);
  assert.ok(add.timeoutMs > 660000);
});

test("checkAccounts passes timeoutMs above CHECK_TIMEOUT_MS", async () => {
  const { calls, status, handlers } = boot();
  status.accounts = [];
  await handlers.checkAccounts({ hostId: "h1" });
  const check = calls.find((c) => c.method === "checkAccounts");
  assert.equal(check.timeoutMs, HOST_CHECK_TIMEOUT_MS);
  assert.ok(check.timeoutMs > 120000);
});

test("installRuntime passes timeoutMs above 5 min", async () => {
  const { calls, status, handlers } = boot();
  status.accounts = [];
  await handlers.installRuntime({ hostId: "h1" });
  const install = calls.find((c) => c.method === "installRuntime");
  assert.equal(install.timeoutMs, HOST_INSTALL_TIMEOUT_MS);
  assert.ok(install.timeoutMs > 300000);
});

test("usage passes timeoutMs above USAGE_TIMEOUT_MS", async () => {
  const { calls, status, handlers } = boot();
  status.accounts = [{ id: "a", label: "a", status: "signed_in", locked: false, lastUsedAt: "", lastCheckedAt: "" }];
  await handlers.usage({});
  const usage = calls.find((c) => c.method === "usage");
  assert.equal(usage.timeoutMs, HOST_USAGE_TIMEOUT_MS);
  assert.ok(usage.timeoutMs > 45000);
  assert.ok(usage.timeoutMs > 44000);
});

import assert from "node:assert/strict";
import test from "node:test";
import { syncAcrossHosts } from "../bridge/hub-sync.mjs";

function fixture(boom = new Set()) {
  const calls = [];
  const call = async (method, input, { hostId }) => {
    calls.push({ method, hostId, input });
    if (method === "exportAccount") return { id: input.id, label: "Main", cookies: [{ name: "sid", value: "SECRET-V" }] };
    if (method === "importAccount") {
      if (boom.has(hostId)) throw new Error("boom");
      return { ok: true };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { calls, call };
}

const hosts = [
  { hostId: "h1", connected: true, runtime: true },
  { hostId: "h2", connected: true, runtime: true },
  { hostId: "h3", connected: true, runtime: true },
  { hostId: "h4", connected: false, runtime: true },
  { hostId: "h5", connected: true, runtime: false },
];

test("exports from the source and imports on every other connected host with a runtime", async () => {
  const { calls, call } = fixture(new Set(["h3"]));
  const res = await syncAcrossHosts({ sourceHostId: "h1", accountId: "main", hosts, call });
  const imports = calls.filter((c) => c.method === "importAccount");
  assert.deepEqual(
    imports.map((c) => c.hostId).sort(),
    ["h2", "h3"],
  );
  assert.equal(imports[0].input.cookies[0].value, "SECRET-V");
  assert.equal(imports[0].input.label, "Main");
  assert.equal(imports[0].input.id, "main");

  const byHost = Object.fromEntries(res.map((r) => [r.hostId, r]));
  assert.equal(byHost.h2.ok, true);
  assert.equal(byHost.h3.ok, false);
  assert.match(byHost.h3.error, /boom/);
  assert.equal(res.length, 2);
  assert.ok(!res.some((r) => r.hostId === "h1" || r.hostId === "h4" || r.hostId === "h5"));
});

test("all hosts succeed when nothing fails", async () => {
  const { call } = fixture();
  const res = await syncAcrossHosts({ sourceHostId: "h1", accountId: "main", hosts: hosts.slice(0, 3), call });
  assert.deepEqual(
    res.map((r) => r.ok),
    [true, true],
  );
});

test("a failing export rejects before any import call", async () => {
  const calls = [];
  const call = async (method, input, { hostId }) => {
    calls.push({ method, hostId });
    throw new Error("no cookies");
  };
  await assert.rejects(() => syncAcrossHosts({ sourceHostId: "h1", accountId: "main", hosts, call }), /no cookies/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "exportAccount");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { addAccount, listAccounts, setStatus } from "../bridge/accounts.mjs";
import { saveCookies } from "../bridge/cookies.mjs";

async function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-check-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

function sink() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

const statusOf = (id) => listAccounts().find((a) => a.id === id)?.status;

test("accounts check marks an account signed_out when the API bootstrap refuses it", () =>
  withHome(async () => {
    const { cmdAccountsCheck } = await import("../bin/musebridge.mjs");
    addAccount("main");
    setStatus("main", "signed_in");
    saveCookies("main", [{ name: "s", value: "x", domain: ".muse.ai", path: "/" }]);
    const out = sink();
    await cmdAccountsCheck(["main"], {
      stdout: out,
      createMuseClient: async () => {
        const err = new Error("Muse bootstrap failed (400)");
        err.code = "auth_failed";
        err.status = 400;
        throw err;
      },
    });
    assert.equal(statusOf("main"), "signed_out");
    assert.deepEqual(out.lines, ["main\tsigned_out\n"]);
  }));

test("accounts check marks signed_in only after a real ping, and leaves the status on a transient error", () =>
  withHome(async () => {
    const { cmdAccountsCheck } = await import("../bin/musebridge.mjs");
    addAccount("a");
    addAccount("b");
    setStatus("b", "signed_out");
    for (const id of ["a", "b"]) saveCookies(id, [{ name: "s", value: id, domain: ".muse.ai", path: "/" }]);
    let closed = 0;
    const out = sink();
    await cmdAccountsCheck([], {
      stdout: out,
      createMuseClient: async ({ accountId }) => {
        if (accountId === "b") throw new Error("gateway dial failed: 503 Service Unavailable");
        return { isSignedIn: async () => true, close: async () => void (closed += 1) };
      },
    });
    assert.equal(statusOf("a"), "signed_in");
    assert.equal(statusOf("b"), "signed_out");
    assert.equal(closed, 1);
    assert.equal(out.lines[0], "a\tsigned_in\n");
    assert.match(out.lines[1], /^b\terror\t/);
  }));

test("accounts check marks a refused gateway dial unknown, like request rotation", () =>
  withHome(async () => {
    const { cmdAccountsCheck } = await import("../bin/musebridge.mjs");
    addAccount("c");
    setStatus("c", "signed_in");
    saveCookies("c", [{ name: "s", value: "c", domain: ".muse.ai", path: "/" }]);
    const out = sink();
    await cmdAccountsCheck(["c"], {
      stdout: out,
      createMuseClient: async () => {
        const err = new Error("gateway dial failed: 502 Bad Gateway");
        err.code = "gateway_dial_failed";
        throw err;
      },
    });
    assert.equal(statusOf("c"), "unknown");
    assert.match(out.lines[0], /^c\tunknown\t/);
  }));

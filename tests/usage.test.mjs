import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addAccount, setStatus } from "../bridge/accounts.mjs";
import { fetchAccountUsage } from "../bridge/usage.mjs";
import { cmdAccountsUsage } from "../bin/musebridge.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "musebridge.mjs");

const COOKIES = [{ name: "sid", value: "v", domain: ".muse.ai", path: "/" }];

const RSC_UNLIMITED =
  '0:{"a":"$@1","q":"","i":false}\n' +
  '1:{"success":true,"subscription":{"tier":{"tierId":"pro","name":"Muse Pro","tierCode":"PRO","isPaid":true,"rank":2},"usage":{"state":"UNLIMITED","percentUsed":null,"resetsAt":null,"quotaStatus":"UNLIMITED"},"statusSubtitle":"Unlimited plan","usageRowLabel":"Pro plan","usageRowValueLabel":"Unlimited","usageRowFooter":null,"billingSubtitle":null,"topupBalance":0,"topupTotal":0,"topupRowLabel":"Additional tokens","topupRowValueLabel":null,"topupEligible":false}}\n';

const RSC_METERED =
  '0:{"a":"$@1","q":"","i":false}\n' +
  '1:{"success":true,"subscription":{"tier":{"tierId":"hatch_free","name":"Muse Free","tierCode":"HATCH_FREE","isPaid":false,"rank":0},"usage":{"state":"METERED","percentUsed":28,"resetsAt":1794082412,"quotaStatus":"SUFFICIENT"},"statusSubtitle":"Weekly limit resets on Nov 7","usageRowLabel":"Free plan","usageRowValueLabel":"28% used","usageRowFooter":null,"billingSubtitle":null,"topupBalance":40000000,"topupTotal":40000000,"topupRowLabel":"Additional tokens","topupRowValueLabel":"0% used (1B tokens left)","topupEligible":false}}\n';


function rscFetch(text) {
  return async () => new Response(text, { status: 200, headers: { "content-type": "text/x-component" } });
}

function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-usage-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

async function captureStdout(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

test("UNLIMITED usage state parses to percentUsed null", async () => {
  const u = await fetchAccountUsage({
    accountId: "usage-unlimited",
    cookies: COOKIES,
    fetchImpl: rscFetch(RSC_UNLIMITED),
  });
  assert.equal(u.state, "UNLIMITED");
  assert.equal(u.percentUsed, null);
  assert.equal(u.plan, "Muse Pro");
  assert.equal(u.planCode, "PRO");
  assert.equal(u.isPaid, true);
  assert.equal(u.periodLabel, "Unlimited plan");
});

test("usage results are cached per account for 5 minutes unless cache: false", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(RSC_METERED, { status: 200 });
  };
  const opts = { accountId: "usage-cache", cookies: COOKIES, fetchImpl };
  const first = await fetchAccountUsage(opts);
  const second = await fetchAccountUsage(opts);
  assert.equal(calls, 1);
  assert.equal(second.percentUsed, first.percentUsed);
  await fetchAccountUsage({ ...opts, cache: false });
  assert.equal(calls, 2);
});

test("accounts usage --json prints {accounts:[{id,label,status,usage,error}]}", async () => {
  await withHome(async () => {
    addAccount("Main");
    setStatus("main", "signed_in");
    addAccount("Ghost");
    const usage = {
      plan: "Muse Free",
      planCode: "HATCH_FREE",
      isPaid: false,
      state: "METERED",
      percentUsed: 28,
      resetsAt: 1794082412,
      quotaStatus: "SUFFICIENT",
      periodLabel: "Weekly limit resets on Nov 7",
      extraTokensTotal: 40000000,
      extraTokensBalance: 40000000,
      extraTokensLeftLabel: "0% used (1B tokens left)",
      checkedAt: "2026-11-03T00:00:00.000Z",
    };
    const authErr = new Error("Muse API unauthorized");
    authErr.code = "auth_failed";
    const out = await captureStdout(() =>
      cmdAccountsUsage(["--json"], {
        fetchAccountUsage: async ({ accountId }) => {
          if (accountId === "ghost") throw authErr;
          return usage;
        },
      }),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.accounts.length, 2);
    assert.deepEqual(parsed.accounts[0], {
      id: "main",
      label: "Main",
      status: "signed_in",
      usage,
      error: null,
    });
    const ghost = parsed.accounts[1];
    assert.equal(ghost.id, "ghost");
    assert.equal(ghost.label, "Ghost");
    assert.equal(ghost.usage, null);
    assert.equal(ghost.error.code, "auth_failed");
  });
});

test("musebridge accounts usage --json on an empty registry prints accounts:[]", async () => {
  const home = fs.mkdtempSync("/tmp/muse-usage-cli-");
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, "accounts", "usage", "--json"],
      { env: { ...process.env, MUSE_BRIDGE_HOME: home }, encoding: "utf8" },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    );
  });
  assert.deepEqual(JSON.parse(stdout), { accounts: [] });
});

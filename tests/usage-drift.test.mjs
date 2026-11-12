import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_ACTION_ID } from "../bridge/usage.mjs";

const usageModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bridge", "usage.mjs");

const BUILTIN = DEFAULT_ACTION_ID;
const STALE = "40aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_ID = "40bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COOKIES = [{ name: "c", value: "v", domain: ".muse.ai", path: "/" }];

const RSC =
  '0:{"a":"$@1"}\n' +
  '1:{"success":true,"subscription":{"tier":{"name":"Muse Free","tierCode":"HATCH_FREE","isPaid":false},"usage":{"state":"METERED","percentUsed":29,"resetsAt":1794082412,"quotaStatus":"SUFFICIENT"},"statusSubtitle":"Weekly limit resets on Nov 7","topupBalance":1,"topupTotal":1,"topupRowValueLabel":"0% used"}}\n';

let seq = 0;
async function freshBridge() {
  const home = fs.mkdtempSync("/tmp/muse-usage-drift-");
  process.env.MUSE_BRIDGE_HOME = home;
  const mod = await import(`${usageModule}?case=${seq++}`);
  const cacheFile = path.join(home, "cache", "usage-action.json");
  return { home, mod, cacheFile };
}

function seedCache({ home, cacheFile }, actionId) {
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ actionId }));
}

function cachedId(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")).actionId;
  } catch {
    return undefined;
  }
}

function driftFetch(goodId, { chunkId = NEW_ID } = {}) {
  const actionCalls = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    const action = init.headers && init.headers["Next-Action"];
    if (action) {
      actionCalls.push(action);
      return action === goodId
        ? new Response(RSC, { status: 200 })
        : new Response("Conflict", { status: 409 });
    }
    if (url.includes(".js")) {
      return new Response(
        `(0,et.createServerReference)("${chunkId}",et.callServer,void 0,et.findSourceMapURL,"fetchSubscriptionAction")`,
        { status: 200 },
      );
    }
    return new Response('<script src="/_next/static/chunks/x1.js"></script>', { status: 200 });
  };
  return { actionCalls, fetchImpl };
}

test("a cached action id answering 409 falls back to the built-in id and leaves the cache", async () => {
  const ctx = await freshBridge();
  seedCache(ctx, STALE);
  const { actionCalls, fetchImpl } = driftFetch(BUILTIN);
  const usage = await ctx.mod.fetchAccountUsage({ cookies: COOKIES, fetchImpl, cache: false });
  assert.equal(usage.percentUsed, 29);
  assert.deepEqual(actionCalls, [STALE, BUILTIN]);
  assert.notEqual(cachedId(ctx.cacheFile), STALE);
});

test("when the cached and built-in ids both answer 409, the chunk script id is used and cached", async () => {
  const ctx = await freshBridge();
  seedCache(ctx, STALE);
  const { actionCalls, fetchImpl } = driftFetch(NEW_ID);
  const usage = await ctx.mod.fetchAccountUsage({ cookies: COOKIES, fetchImpl, cache: false });
  assert.equal(usage.percentUsed, 29);
  assert.deepEqual(actionCalls, [STALE, BUILTIN, NEW_ID]);
  assert.equal(cachedId(ctx.cacheFile), NEW_ID);
});

test("a cached id returning an unreadable 200 is treated as drift too", async () => {
  const ctx = await freshBridge();
  seedCache(ctx, STALE);
  const actionCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const action = init.headers && init.headers["Next-Action"];
    if (action) {
      actionCalls.push(action);
      return action === BUILTIN
        ? new Response(RSC, { status: 200 })
        : new Response('0:{"a":"$@1"}\n', { status: 200 });
    }
    return new Response("<html></html>", { status: 200 });
  };
  const usage = await ctx.mod.fetchAccountUsage({ cookies: COOKIES, fetchImpl, cache: false });
  assert.equal(usage.percentUsed, 29);
  assert.deepEqual(actionCalls, [STALE, BUILTIN]);
  assert.notEqual(cachedId(ctx.cacheFile), STALE);
});

test("when every candidate fails, rejects usage_unavailable with the last status and evicts the stale id", async () => {
  const ctx = await freshBridge();
  seedCache(ctx, STALE);
  const { actionCalls, fetchImpl } = driftFetch("40cccccccccccccccccccccccccccccccccccccc");
  await assert.rejects(
    () => ctx.mod.fetchAccountUsage({ cookies: COOKIES, fetchImpl, cache: false }),
    (err) => err.code === "usage_unavailable" && String(err.message).includes("409"),
  );
  assert.deepEqual(actionCalls, [STALE, BUILTIN, NEW_ID]);
  assert.notEqual(cachedId(ctx.cacheFile), STALE);
});

test("401 and 403 still reject with auth_failed", async () => {
  const ctx = await freshBridge();
  for (const status of [401, 403]) {
    const fetchImpl = async () => new Response("nope", { status });
    await assert.rejects(
      () => ctx.mod.fetchAccountUsage({ cookies: COOKIES, fetchImpl, cache: false }),
      (err) => err.code === "auth_failed",
    );
  }
});

test("discoverActionId follows lazy Turbopack modal chunks with dpl query param", async () => {
  const ctx = await freshBridge();
  const seenUrls = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    seenUrls.push(url);
    const action = init.headers && init.headers["Next-Action"];
    if (action) {
      return action === NEW_ID ? new Response(RSC, { status: 200 }) : new Response("Conflict", { status: 409 });
    }
    if (url.includes("lazy_modal.js")) {
      return new Response(
        `(0,a.createServerReference)("${NEW_ID}",a.callServer,void 0,a.findSourceMapURL,"fetchSubscriptionAction")`,
        { status: 200 },
      );
    }
    if (url.includes("entry.js")) {
      return new Response('s.v(t=>Promise.all(["static/chunks/lazy_modal.js"].map(t=>s.l(t))))', { status: 200 });
    }
    return new Response(
      '<html data-dpl-id="dpl_test123"><script src="/_next/static/chunks/entry.js?dpl=dpl_test123"></script></html>',
      { status: 200 },
    );
  };
  const usage = await ctx.mod.fetchAccountUsage({ cookies: COOKIES, fetchImpl, cache: false });
  assert.equal(usage.percentUsed, 29);
  assert.ok(seenUrls.includes("https://muse.ai/_next/static/chunks/lazy_modal.js?dpl=dpl_test123"));
  assert.equal(cachedId(ctx.cacheFile), NEW_ID);
});

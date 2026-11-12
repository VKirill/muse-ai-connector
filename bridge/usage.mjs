import fs from "node:fs";
import path from "node:path";
import { cookieHeader, loadCookies } from "./cookies.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";
import { bridgeHome } from "./paths.mjs";

const MUSE_ORIGIN = "https://muse.ai";
const USAGE_URL = `${MUSE_ORIGIN}/`;
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const DEFAULT_ACTION_ID = "40e0249eeae158685b6a8d0c3b203f53dd4f2c7d63";
const ACTION_BODY = '[{"includeAgreement":true}]';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CHUNK_BATCH_SIZE = 8;

const usageCache = new Map();
let rememberedActionId = null;
let inflightDiscovery = null;

function authError(status) {
  const err = new Error("Muse API unauthorized");
  err.code = "auth_failed";
  err.status = status;
  return err;
}

function unavailableError(message) {
  const err = new Error(message);
  err.code = "usage_unavailable";
  return err;
}

function actionIdPath() {
  return path.join(bridgeHome(), "cache", "usage-action.json");
}

function currentActionId() {
  if (rememberedActionId) return rememberedActionId;
  try {
    const saved = readJson(actionIdPath(), null);
    if (saved && typeof saved.actionId === "string" && saved.actionId) {
      rememberedActionId = saved.actionId;
    }
  } catch {
    /* unreadable cache; fall back to the known id */
  }
  return rememberedActionId ?? DEFAULT_ACTION_ID;
}

function rememberActionId(id) {
  rememberedActionId = id;
  try {
    writeJsonAtomic(actionIdPath(), { actionId: id });
  } catch {
    /* best effort */
  }
}

function forgetActionId(id) {
  if (rememberedActionId === id) rememberedActionId = null;
  try {
    const saved = readJson(actionIdPath(), null);
    if (saved && saved.actionId === id) fs.unlinkSync(actionIdPath());
  } catch {
    /* best effort */
  }
}

function usageHeaders(cookies, actionId) {
  const headers = {
    Accept: "text/x-component",
    "Content-Type": "text/plain;charset=UTF-8",
    "Next-Action": actionId,
    Origin: MUSE_ORIGIN,
    Referer: USAGE_URL,
    "User-Agent": CHROME_UA,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  const cookie = cookieHeader(cookies ?? [], USAGE_URL);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function postAction(fetchImpl, cookies, actionId) {
  return fetchImpl(USAGE_URL, {
    method: "POST",
    headers: usageHeaders(cookies, actionId),
    body: ACTION_BODY,
  });
}

function parseActionResult(text) {
  for (const line of String(text).split("\n")) {
    const match = /^\d+:(.*)$/.exec(line.trim());
    if (!match) continue;
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && (parsed.subscription || parsed.success === true)) {
      return parsed;
    }
  }
  return null;
}

async function readPayload(res) {
  if (res.status === 401 || res.status === 403) throw authError(res.status);
  if (!res.ok) return null;
  return parseActionResult(await res.text());
}

function extractSubscriptionActionId(js) {
  const match = /createServerReference\)\("([0-9a-fA-F]+)"[^)]*?"fetchSubscriptionAction"/.exec(js);
  return match ? match[1] : null;
}

function extractLazyChunkUrls(js, dplSuffix) {
  const out = [];
  for (const m of js.matchAll(/["']((?:\/_next\/)?static\/chunks\/[0-9a-zA-Z._-]+\.js)["']/g)) {
    const raw = m[1].startsWith("/_next/") ? m[1] : `/_next/${m[1]}`;
    out.push(`${MUSE_ORIGIN}${raw}${dplSuffix}`);
  }
  return out;
}

async function scanChunkUrls(fetchImpl, urls, visited, lazyOut, dplSuffix) {
  const queue = urls.filter((u) => {
    if (visited.has(u)) return false;
    visited.add(u);
    return true;
  });
  for (let i = 0; i < queue.length; i += CHUNK_BATCH_SIZE) {
    const batch = queue.slice(i, i + CHUNK_BATCH_SIZE);
    const texts = await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await fetchImpl(url, {
            method: "GET",
            headers: { "User-Agent": CHROME_UA, Referer: USAGE_URL },
          });
          return res.ok ? await res.text() : "";
        } catch {
          return "";
        }
      }),
    );
    for (const js of texts) {
      if (!js) continue;
      const hit = extractSubscriptionActionId(js);
      if (hit) return hit;
      if (lazyOut) {
        for (const lazyUrl of extractLazyChunkUrls(js, dplSuffix)) lazyOut.push(lazyUrl);
      }
    }
  }
  return null;
}

async function discoverActionIdUncached(fetchImpl, cookies) {
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": CHROME_UA,
    Referer: USAGE_URL,
  };
  const cookie = cookieHeader(cookies ?? [], USAGE_URL);
  if (cookie) headers.Cookie = cookie;
  const pageRes = await fetchImpl(USAGE_URL, { method: "GET", headers });
  if (pageRes.status === 401 || pageRes.status === 403) throw authError(pageRes.status);
  if (!pageRes.ok) return null;
  const html = await pageRes.text();
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/g)].map((m) =>
    m[1].startsWith("http") ? m[1] : `${MUSE_ORIGIN}${m[1]}`,
  );
  const dplFromHtml = /data-dpl-id=["']([^"']+)["']/.exec(html)?.[1];
  const dplFromSrc = srcs.map((s) => /[?&]dpl=([^&#"']+)/.exec(s)?.[1]).find(Boolean);
  const dplId = dplFromSrc ?? dplFromHtml ?? "";
  const dplSuffix = dplId ? `?dpl=${encodeURIComponent(dplId)}` : "";

  const visited = new Set();
  const lazyUrls = [];
  const directHit = await scanChunkUrls(fetchImpl, srcs, visited, lazyUrls, dplSuffix);
  if (directHit) return directHit;
  return scanChunkUrls(fetchImpl, lazyUrls, visited, null, dplSuffix);
}

async function discoverActionId(fetchImpl, cookies) {
  if (fetchImpl !== globalThis.fetch) return discoverActionIdUncached(fetchImpl, cookies);
  if (!inflightDiscovery) {
    inflightDiscovery = discoverActionIdUncached(fetchImpl, cookies).finally(() => {
      inflightDiscovery = null;
    });
  }
  return inflightDiscovery;
}

function mapUsage(payload) {
  const sub = payload?.subscription ?? {};
  const tier = sub.tier ?? {};
  const usage = sub.usage ?? {};
  return {
    plan: tier.name ?? null,
    planCode: tier.tierCode ?? null,
    isPaid: Boolean(tier.isPaid),
    state: usage.state ?? null,
    percentUsed: typeof usage.percentUsed === "number" ? usage.percentUsed : null,
    resetsAt: typeof usage.resetsAt === "number" ? usage.resetsAt : null,
    quotaStatus: usage.quotaStatus ?? null,
    periodLabel: sub.statusSubtitle ?? payload?.statusSubtitle ?? null,
    extraTokensTotal: sub.topupTotal ?? payload?.topupTotal ?? null,
    extraTokensBalance: sub.topupBalance ?? payload?.topupBalance ?? null,
    extraTokensLeftLabel: sub.topupRowValueLabel ?? payload?.topupRowValueLabel ?? null,
    checkedAt: new Date().toISOString(),
  };
}

async function* actionIdCandidates(fetchImpl, cookies) {
  const seen = new Set();
  for (const id of [currentActionId(), DEFAULT_ACTION_ID]) {
    if (seen.has(id)) continue;
    seen.add(id);
    yield id;
  }
  const discovered = await discoverActionId(fetchImpl, cookies);
  if (discovered && !seen.has(discovered)) yield discovered;
}

async function readUsage(fetchImpl, cookies) {
  let lastStatus = 0;
  let lastOk = false;
  for await (const actionId of actionIdCandidates(fetchImpl, cookies)) {
    const res = await postAction(fetchImpl, cookies, actionId);
    const payload = await readPayload(res);
    if (res.ok && payload) {
      if (actionId !== currentActionId()) rememberActionId(actionId);
      return mapUsage(payload);
    }
    forgetActionId(actionId);
    lastStatus = res.status;
    lastOk = res.ok;
  }
  if (lastStatus && !lastOk) throw unavailableError(`Muse usage request failed (${lastStatus})`);
  throw unavailableError("Muse usage response was not readable");
}

/**
 * Reads a Muse account's plan usage from the web app without opening Chrome.
 * @param {{ accountId?: string, cookies?: object[], fetchImpl?: typeof fetch, cache?: boolean }} [opts]
 */
export async function fetchAccountUsage({ accountId, cookies, fetchImpl = globalThis.fetch, cache = true } = {}) {
  const jar = cookies ?? loadCookies(accountId ?? "default");
  const key = accountId ?? "default";
  if (cache) {
    const hit = usageCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.usage;
  }
  const usage = await readUsage(fetchImpl, jar);
  if (cache) usageCache.set(key, { at: Date.now(), usage });
  return usage;
}

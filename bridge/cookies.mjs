import fs from "node:fs";
import path from "node:path";
import { bridgeHome } from "./paths.mjs";

/** @param {string} accountId */
export function cookiesPath(accountId) {
  return path.join(bridgeHome(), "accounts", accountId, "cookies.json");
}

/** @param {string} accountId */
export function nodeIdPath(accountId) {
  return path.join(bridgeHome(), "accounts", accountId, "node.json");
}

function ensureAccountDir(accountId) {
  const dir = path.dirname(cookiesPath(accountId));
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * @param {string} id
 * @param {object[]} cookies
 */
export function saveCookies(id, cookies) {
  ensureAccountDir(id);
  writePrivateJson(cookiesPath(id), cookies);
}

/** @param {string} id */
export function loadCookies(id) {
  const file = cookiesPath(id);
  if (!fs.existsSync(file)) {
    const err = new Error(`No cookies for account ${id}`);
    err.code = "missing_cookies";
    throw err;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function domainMatches(cookieDomain, host) {
  if (!cookieDomain) return false;
  const hostLc = host.toLowerCase();
  const raw = String(cookieDomain).toLowerCase();
  const domain = raw.replace(/^\./, "");
  if (hostLc === domain) return true;
  if (raw.startsWith(".")) return hostLc.endsWith(`.${domain}`);
  return false;
}

function pathMatches(cookiePath, pathname) {
  const p = cookiePath || "/";
  if (pathname === p) return true;
  if (p.endsWith("/")) return pathname.startsWith(p);
  return pathname.startsWith(`${p}/`) || pathname.startsWith(p);
}

function cookieMatches(cookie, url, nowSec) {
  const expires = cookie.expires;
  if (typeof expires === "number" && expires > 0 && expires < nowSec) return false;
  if (cookie.secure && url.protocol !== "https:") return false;
  if (!domainMatches(cookie.domain, url.hostname)) return false;
  if (!pathMatches(cookie.path, url.pathname || "/")) return false;
  return true;
}

/**
 * @param {object[]} cookies
 * @param {string} url
 */
export function cookieHeader(cookies, url) {
  const parsed = new URL(url);
  const nowSec = Date.now() / 1000;
  const parts = [];
  for (const cookie of cookies ?? []) {
    if (!cookie?.name || !cookieMatches(cookie, parsed, nowSec)) continue;
    parts.push(`${cookie.name}=${cookie.value ?? ""}`);
  }
  return parts.join("; ");
}

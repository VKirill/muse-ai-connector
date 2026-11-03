import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cookieHeader, cookiesPath, loadCookies, saveCookies } from "../bridge/cookies.mjs";

function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-cookies-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
    else process.env.MUSE_BRIDGE_HOME = prev;
  }
}

const sample = {
  name: "hatch_sess",
  value: "x",
  domain: ".muse.ai",
  path: "/",
  expires: 2_000_000_000,
  httpOnly: true,
  secure: true,
};

test("saveCookies writes 0600 file in a 0700 account directory", () => {
  withHome(() => {
    saveCookies("acc1", [sample]);
    const file = cookiesPath("acc1");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(loadCookies("acc1"), [sample]);
  });
});

test("cookieHeader includes a matching cookie and drops expired, foreign, or http-only-secure mismatches", () => {
  const cookies = [
    sample,
    { ...sample, name: "dead", expires: 1 },
    { ...sample, name: "other", domain: "example.com" },
    { ...sample, name: "auth", domain: "auth.meta.com", value: "y" },
  ];
  assert.match(cookieHeader(cookies, "https://muse.ai/api/hatch/token"), /hatch_sess=x/);
  assert.doesNotMatch(cookieHeader(cookies, "https://muse.ai/api/hatch/token"), /dead=/);
  assert.doesNotMatch(cookieHeader(cookies, "https://muse.ai/api/hatch/token"), /other=/);
  assert.equal(cookieHeader(cookies, "http://muse.ai/"), "");
  assert.match(cookieHeader(cookies, "https://auth.meta.com/"), /auth=y/);
});

test("loadCookies throws missing_cookies when the file is absent", () => {
  withHome(() => {
    assert.throws(() => loadCookies("missing"), (err) => err.code === "missing_cookies");
  });
});

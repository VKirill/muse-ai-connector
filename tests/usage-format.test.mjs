import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../version.ts";
import { formatExtraTokens, formatUsageReset } from "../usage-format.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nov9Sec = Date.UTC(2026, 10, 9, 12, 0, 0) / 1000;
const nov9Ms = Date.UTC(2026, 10, 9, 12, 0, 0);

test("formatUsageReset ru uses the numeric date and ignores Muse English", () => {
  const ru = formatUsageReset({ resetsAt: nov9Sec, periodLabel: "Weekly limit resets on Nov 9" }, "ru");
  assert.match(ru, /9 ноя/);
  assert.doesNotMatch(ru, /Weekly|resets|Nov/);
});

test("formatUsageReset en formats Nov 9", () => {
  const en = formatUsageReset({ resetsAt: nov9Sec, periodLabel: "Weekly limit resets on Nov 9" }, "en");
  assert.match(en, /Nov 9/);
});

test("formatUsageReset treats values above 1e12 as milliseconds", () => {
  const fromMs = formatUsageReset({ resetsAt: nov9Ms }, "en");
  const fromSec = formatUsageReset({ resetsAt: nov9Sec }, "en");
  assert.equal(fromMs, fromSec);
  assert.match(fromMs, /Nov 9/);
});

test("formatUsageReset en falls back to periodLabel without resetsAt", () => {
  assert.equal(formatUsageReset({ resetsAt: null, periodLabel: "Unlimited plan" }, "en"), "Unlimited plan");
  assert.equal(formatUsageReset({ resetsAt: null, periodLabel: "Unlimited plan" }, "ru"), "");
});

test("formatExtraTokens ru is used percent, not Muse English", () => {
  assert.equal(
    formatExtraTokens(
      { extraTokensBalance: 40000000, extraTokensTotal: 40000000, extraTokensLeftLabel: "0% used (1B tokens left)" },
      "ru",
    ),
    "0% использовано",
  );
});

test("formatExtraTokens en is used percent when totals are present", () => {
  assert.equal(
    formatExtraTokens({ extraTokensBalance: 20000000, extraTokensTotal: 40000000 }, "en"),
    "50% used",
  );
});

test("empty input returns empty strings", () => {
  assert.equal(formatUsageReset({ resetsAt: null, periodLabel: null }, "ru"), "");
  assert.equal(formatUsageReset(null, "en"), "");
  assert.equal(
    formatExtraTokens({ extraTokensBalance: null, extraTokensTotal: null, extraTokensLeftLabel: null }, "ru"),
    "",
  );
  assert.equal(formatExtraTokens({}, "en"), "");
});

test("version is 0.3.18", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(PLUGIN_VERSION, "0.3.18");
  assert.equal(pkg.version, "0.3.18");
});

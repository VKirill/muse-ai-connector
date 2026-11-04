import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.MUSE_BRIDGE_HOME = fs.mkdtempSync(path.join("/tmp", "muse-ui-scroll-"));
const { collectMergedUsage, USAGE_TIMEOUT_MS } = await import("../server.ts");
const css = fs.readFileSync(path.join(root, "app.css"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "app.tsx"), "utf8");

function rule(sel) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  return [...css.matchAll(re)].map((m) => m[1]).join("\n");
}

const host = (id, connected = true) => ({
  hostId: id,
  name: id,
  connected,
  error: null,
  status: {
    platform: "darwin",
    chromeFound: true,
    chromePath: null,
    bridgeFound: true,
    accounts: [
      { id: "a-" + id, label: "A " + id, status: "signed_in", locked: false, lastUsedAt: "", lastCheckedAt: "" },
    ],
  },
});

test(".muse-workspace scrolls inside the bounded .muse-layout", () => {
  const ws = rule(".muse-workspace");
  assert.match(ws, /overflow(-y)?\s*:\s*auto/, ".muse-workspace must scroll (overflow-y: auto)");
  assert.match(ws, /min-height\s*:\s*0/, ".muse-workspace needs min-height: 0 to scroll inside the grid");
  assert.match(ws, /padding\s*:/, ".muse-workspace needs an inner padding value");
  const layout = rule(".muse-layout");
  assert.match(layout, /(^|[^-])height\s*:/m, ".muse-layout must have a bounded height");
});

test("meter labels share nowrap and one min-width so bars end at the same x", () => {
  for (const sel of [".muse-meter-pct", ".muse-meter-label"]) {
    const body = rule(sel);
    assert.match(body, /white-space\s*:\s*nowrap/, `${sel} must not wrap`);
    assert.match(body, /min-width\s*:/, `${sel} must reserve a column width`);
  }
  const pctWidth = rule(".muse-meter-pct").match(/min-width\s*:\s*([^;]+)/)?.[1].trim();
  const labelWidth = rule(".muse-meter-label").match(/min-width\s*:\s*([^;]+)/)?.[1].trim();
  assert.equal(pctWidth, labelWidth);
});

test("collectMergedUsage gives up on a hung host within timeoutMs", async () => {
  const started = Date.now();
  const rows = await collectMergedUsage(
    [host("fast"), host("slow")],
    (hostId, id) =>
      hostId === "slow" ? new Promise(() => {}) : Promise.resolve({ accounts: [{ id, usage: null, error: null }] }),
    { timeoutMs: 200 },
  );
  const took = Date.now() - started;
  assert.ok(took < 3000, `collectMergedUsage must give up on a hung host (took ${took}ms)`);
  const slow = rows.find((r) => r.id === "a-slow");
  assert.equal(slow?.error?.code, "usage_timeout");
  assert.equal(rows.find((r) => r.id === "a-fast")?.error, null);
});

test("collectMergedUsage defaults to a 45 s timeout", () => {
  assert.equal(USAGE_TIMEOUT_MS, 45000);
});

test("AccountsPage marks every card unavailable when the usage call fails or times out", () => {
  assert.match(appSrc, /USAGE_TIMEOUT_MS = 45000/);
  assert.match(appSrc, /code:\s*"usage_timeout"/);
  assert.match(appSrc, /muse-meter-label/);
  const errorBranch = appSrc.slice(appSrc.indexOf("usage?.error"), appSrc.indexOf("!snapshot"));
  assert.match(errorBranch, /usageUnavailableLabel/);
  assert.match(errorBranch, /onRetry/);
});

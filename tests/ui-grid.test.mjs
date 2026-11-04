import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(root, "app.css"), "utf8");
const tsx = fs.readFileSync(path.join(root, "app.tsx"), "utf8");
const i18nSrc = fs.readFileSync(path.join(root, "i18n.ts"), "utf8");

const block = (sel) => {
  const re = new RegExp("(^|[\\s,}])" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "gm");
  return [...css.matchAll(re)].map((m) => m[2]).join("\n");
};
const px = (v) => {
  const m = String(v).match(/(\d+(?:\.\d+)?)(px|rem)/);
  return m ? (m[2] === "rem" ? +m[1] * 16 : +m[1]) : NaN;
};

test("spacing tokens replace BB's 4px --spacing", () => {
  assert.doesNotMatch(css, /var\(--spacing\b/);
  const tokens = Object.fromEntries([...css.matchAll(/(--muse-[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  assert.ok(px(tokens["--muse-gap"]) >= 12, "--muse-gap >= 12px");
  assert.ok(px(tokens["--muse-pad"]) >= 20, "--muse-pad >= 20px");
  assert.ok(px(tokens["--muse-card-pad"]) >= 16, "--muse-card-pad >= 16px");
});

test("workspace pads with --muse-pad and still scrolls; cards pad with --muse-card-pad", () => {
  const ws = block(".muse-workspace");
  assert.match(ws, /padding\s*:\s*var\(--muse-pad\)/);
  assert.match(ws, /overflow-y\s*:\s*auto/);
  assert.match(block(".muse-card"), /padding\s*:\s*var\(--muse-card-pad\)/);
});

test("every page renders inside .muse-content capped at 1080px", () => {
  assert.match(css, /\.muse-content\s*\{[^}]*max-width\s*:\s*1080px/);
  assert.match(tsx, /className="muse-content"/);
  const count = (tsx.match(/className="muse-content"/g) ?? []).length;
  assert.equal(count, 3, "Accounts, Machines and Add pages each render inside .muse-content");
});

test("add-account form is a .muse-form card with .muse-field rows", () => {
  assert.match(block(".muse-form"), /max-width\s*:\s*560px/);
  assert.match(block(".muse-field"), /flex-direction\s*:\s*column/);
  assert.match(tsx, /className="muse-card muse-form"/);
  const fields = (tsx.match(/className="muse-field"/g) ?? []).length;
  assert.equal(fields, 2, "machine select and label input each sit in a .muse-field");
  assert.match(tsx, /className="muse-field-label"/);
});

test("field label text exists in i18n en and ru", () => {
  const keys = [...i18nSrc.matchAll(/^\s*(accountLabel|pickMachine)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual([...keys].sort(), ["accountLabel", "accountLabel", "pickMachine", "pickMachine"]);
});

test("side nav has its own padding and a hairline border, top row at <=720px", () => {
  const nav = block(".muse-sidenav");
  assert.match(nav, /padding\s*:/);
  assert.match(nav, /border-right\s*:\s*1px solid var\(--muse-hairline\)/);
  const narrow = css.slice(css.indexOf("@media (max-width: 720px)"));
  assert.match(narrow, /flex-direction\s*:\s*row/);
  assert.match(narrow, /border-bottom\s*:\s*1px solid var\(--muse-hairline\)/);
});

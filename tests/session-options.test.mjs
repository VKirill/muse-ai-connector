import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUSY_TEXTS, COMPOSER_SELECTOR, launchOptions } from "../bridge/session.mjs";

const sessionSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bridge", "session.mjs"), "utf8");

test("launchOptions forces en-US and Chrome channel", () => {
  const headed = launchOptions({ headless: false });
  assert.equal(headed.channel, "chrome");
  assert.equal(headed.locale, "en-US");
  assert.equal(headed.headless, false);
  assert.ok(headed.args.includes("--lang=en-US"));
  const hidden = launchOptions({ headless: true });
  assert.equal(hidden.headless, true);
});

test("COMPOSER_SELECTOR is a textarea CSS selector", () => {
  assert.equal(typeof COMPOSER_SELECTOR, "string");
  assert.match(COMPOSER_SELECTOR, /textarea/);
});

test("BUSY_TEXTS includes is working", () => {
  assert.ok(Array.isArray(BUSY_TEXTS));
  assert.ok(BUSY_TEXTS.includes("is working"));
});

test("openSession launches with launchOptions and send uses COMPOSER_SELECTOR", () => {
  assert.match(sessionSrc, /launchPersistentContext\(\s*userDataDir\s*,\s*launchOptions\(\s*\{\s*headless\s*\}\s*\)\s*\)/);
  assert.match(sessionSrc, /page\.locator\(\s*COMPOSER_SELECTOR\s*\)/);
  assert.doesNotMatch(sessionSrc, /getByRole\(\s*"textbox"\s*,\s*\{\s*name:\s*"Message"/);
});

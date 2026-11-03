import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("PLUGIN_VERSION equals the package.json version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test("host.ts imports the compiled version and never reads package.json", () => {
  const host = fs.readFileSync(path.join(root, "host.ts"), "utf8");
  assert.match(host, /from\s+["']\.\/version(\.ts|\.js)?["']/);
  assert.doesNotMatch(host, /package\.json/);
  assert.doesNotMatch(host, /"0\.1\.0"/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

for (const name of ["app.tsx", "app.css"]) {
  test(`${name} contains no hex colour literal`, () => {
    const text = fs.readFileSync(path.join(root, name), "utf8");
    const hit = text.match(HEX);
    assert.equal(hit, null, `${name} contains ${hit?.[0] ?? ""}`);
  });
}

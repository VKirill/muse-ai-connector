import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "i18n.ts"), "utf8");

function objectKeys(ident) {
  const idx = src.search(new RegExp(`(?:const|export const) ${ident}\\b`));
  assert.ok(idx >= 0, `missing ${ident}`);
  const start = src.indexOf("{", idx);
  let depth = 0;
  let end = start;
  for (; end < src.length; end++) {
    const ch = src[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return [...src.slice(start + 1, end).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

test("en and ru key sets are equal", () => {
  const en = objectKeys("en");
  const ru = objectKeys("ru");
  assert.deepEqual([...en].sort(), [...ru].sort());
  assert.ok(en.length > 0);
});

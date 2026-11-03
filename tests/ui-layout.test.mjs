import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { detectLocale } from "../i18n.ts";
import { PLUGIN_VERSION } from "../version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LATIN_WORD = /[A-Za-z]{3,}/;

function fakeDoc({ lang = "en", pkLang = null, labels = [] } = {}) {
  return {
    documentElement: {
      lang,
      getAttribute: (n) => (n === "data-pk-lang" ? pkLang : null),
    },
    querySelectorAll: () => labels.map((l) => ({ getAttribute: () => l })),
  };
}

function withLocale(opts, fn) {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  const store = new Map();
  if (opts.ruEnabled === "off") store.set("bb-plugin-ru:enabled", "off");
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  globalThis.document = opts.noDocument ? undefined : fakeDoc(opts);
  try {
    return fn();
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
}

function objectKeys(src, marker) {
  const start = src.indexOf(marker);
  const brace = src.indexOf("{", start);
  let depth = 0;
  let end = brace;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(brace + 1, end);
  return [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]);
}

function stripJsxExpressions(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf("{", i);
    if (start < 0) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, start);
    let depth = 0;
    let j = start;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

test("detectLocale: html lang=ru gives ru", () => {
  assert.equal(withLocale({ lang: "ru" }, detectLocale), "ru");
});

test("detectLocale: lang=en with data-pk-lang=ru gives ru", () => {
  assert.equal(withLocale({ lang: "en", pkLang: "ru" }, detectLocale), "ru");
});

test("detectLocale: lang=en with Cyrillic sidebar aria-labels gives ru", () => {
  assert.equal(withLocale({ lang: "en", labels: ["Новый чат", "Поиск"] }, detectLocale), "ru");
});

test("detectLocale: Cyrillic sidebar with Russifier off gives en", () => {
  assert.equal(
    withLocale({ lang: "en", labels: ["Новый чат"], ruEnabled: "off" }, detectLocale),
    "en",
  );
});

test("detectLocale: plain English gives en", () => {
  assert.equal(withLocale({ lang: "en", labels: ["New chat"] }, detectLocale), "en");
});

test("detectLocale: no document gives en", () => {
  assert.equal(withLocale({ noDocument: true }, detectLocale), "en");
});

test("app.tsx visible JSX text and aria-label/title/placeholder literals come from t()", () => {
  const src = fs.readFileSync(path.join(root, "app.tsx"), "utf8");
  const stripped = stripJsxExpressions(src);
  const texts = [];
  const re = /<\/?[a-z][a-z0-9]*\b[^>]*>([^<]+)/g;
  let m;
  while ((m = re.exec(stripped))) {
    const text = m[1].replace(/\s+/g, " ").trim();
    if (text) texts.push(text);
  }
  const latinText = texts.filter((text) => LATIN_WORD.test(text));
  assert.deepEqual(latinText, []);
  const attrRe = /\b(?:aria-label|title|placeholder)\s*=\s*(["'])([^"']*)\1/g;
  const latinAttrs = [];
  while ((m = attrRe.exec(src))) {
    if (LATIN_WORD.test(m[2])) latinAttrs.push(m[2]);
  }
  assert.deepEqual(latinAttrs, []);
});

test("i18n en and ru dictionaries have the same key set", () => {
  const src = fs.readFileSync(path.join(root, "i18n.ts"), "utf8");
  const enKeys = objectKeys(src, "const en =");
  const ruKeys = objectKeys(src, "const ru:");
  assert.deepEqual([...enKeys].sort(), [...ruKeys].sort());
});

test("version 0.3.12 in package.json, package-lock.json and version.ts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, "0.3.12");
  assert.equal(lock.version, "0.3.12");
  assert.equal(lock.packages[""].version, "0.3.12");
  assert.equal(PLUGIN_VERSION, "0.3.12");
});

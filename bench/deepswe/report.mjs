#!/usr/bin/env node
// report.mjs — summarise a pier run's reward.json files into report.md.
// Usage: node report.mjs <run-dir>
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");

function* walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name === "reward.json") yield p;
  }
}

const rows = [];
for (const file of walk(dir)) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const reward =
    typeof data.reward === "number" ? data.reward : data.passed || data.pass ? 1 : 0;
  rows.push({
    task: data.task ?? data.task_id ?? data.instance_id ?? path.basename(path.dirname(file)),
    language: data.language ?? "",
    pass: reward >= 1,
    minutes:
      data.minutes ?? (data.duration_sec != null ? (data.duration_sec / 60).toFixed(1) : ""),
  });
}
rows.sort((a, b) => String(a.task).localeCompare(String(b.task)));

const passed = rows.filter((r) => r.pass).length;
const pct = rows.length ? ` (${((passed / rows.length) * 100).toFixed(0)}%)` : "";
const lines = [
  "# DeepSWE pilot report",
  "",
  `pass@1: ${passed}/${rows.length}${pct}`,
  "",
  "| task | language | result | minutes |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.task} | ${r.language} | ${r.pass ? "pass" : "fail"} | ${r.minutes} |`),
  "",
];

const out = path.join(dir, "report.md");
fs.writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out} — pass@1 ${passed}/${rows.length}`);

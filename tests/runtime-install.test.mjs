import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { devOverride, installRuntime, runtimeStatus } from "../bridge/runtime-install.mjs";

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join("/tmp", prefix));
}

function makeSource(marker = "No accounts") {
  const src = tmpdir("muse-rt-src-");
  fs.mkdirSync(path.join(src, "bin"), { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "muse-rt-fixture", version: "1.0.0" }));
  fs.writeFileSync(
    path.join(src, "bin", "musebridge.mjs"),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${marker}\n`)});\n`,
  );
  fs.writeFileSync(path.join(src, "bin", "muse-acp.mjs"), '#!/usr/bin/env node\nprocess.stdout.write("ACP\\n");\n');
  // entries the dir: copy must skip
  fs.mkdirSync(path.join(src, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "skip.txt"), "x");
  fs.mkdirSync(path.join(src, ".git"), { recursive: true });
  fs.writeFileSync(path.join(src, ".git", "skip.txt"), "x");
  fs.mkdirSync(path.join(src, "bench", "runs"), { recursive: true });
  fs.writeFileSync(path.join(src, "bench", "runs", "skip.txt"), "x");
  return src;
}

function fakeRun(calls, code = 0) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code, stdout: "", stderr: code === 0 ? "" : "npm error" };
  };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.MUSE_RUNTIME_DEV;
  return { ...env, ...extra };
}

const NPM_ARGS = ["install", "--omit=dev", "--no-audit", "--no-fund"];

test("installRuntime from dir: builds runtime/<v>, current link and working shims", async () => {
  const home = tmpdir("muse-rt-home-");
  const src = makeSource();
  const calls = [];
  const res = await installRuntime({ version: "1.2.3", home, source: `dir:${src}`, run: fakeRun(calls) });
  assert.equal(res.ok, true, res.error);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, NPM_ARGS);

  const rtDir = path.join(home, ".muse-bridge", "runtime");
  assert.equal(fs.readlinkSync(path.join(rtDir, "current")), "1.2.3");
  assert.ok(!fs.existsSync(path.join(rtDir, "1.2.3", "node_modules")));
  assert.ok(!fs.existsSync(path.join(rtDir, "1.2.3", ".git")));
  assert.ok(!fs.existsSync(path.join(rtDir, "1.2.3", "bench", "runs")));

  const shim = path.join(home, ".muse-bridge", "bin", "musebridge");
  fs.accessSync(shim, fs.constants.X_OK);
  fs.accessSync(path.join(home, ".muse-bridge", "bin", "muse-acp"), fs.constants.X_OK);
  assert.match(execFileSync(shim, [], { encoding: "utf8", env: cleanEnv() }), /No accounts/);

  const st = runtimeStatus({ home });
  assert.equal(st.installed, true);
  assert.equal(st.version, "1.2.3");
  assert.equal(st.dev, null);
});

test("reinstall of the same version is a no-op", async () => {
  const home = tmpdir("muse-rt-home-");
  const src = makeSource();
  const calls = [];
  await installRuntime({ version: "1.2.3", home, source: `dir:${src}`, run: fakeRun(calls) });
  const marker = path.join(home, ".muse-bridge", "runtime", "1.2.3", "marker.txt");
  fs.writeFileSync(marker, "keep");
  const res = await installRuntime({ version: "1.2.3", home, source: `dir:${src}`, run: fakeRun(calls) });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.alreadyInstalled, true);
  assert.equal(calls.length, 1);
  assert.ok(fs.existsSync(marker));
});

test("a failing npm install returns ok:false, leaves no build dir and keeps the old runtime", async () => {
  const home = tmpdir("muse-rt-home-");
  const src = makeSource();
  const ok = await installRuntime({ version: "1.0.0", home, source: `dir:${src}`, run: fakeRun([]) });
  assert.equal(ok.ok, true, ok.error);
  const res = await installRuntime({ version: "2.0.0", home, source: `dir:${src}`, run: fakeRun([], 1) });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /npm install failed/);
  const rtDir = path.join(home, ".muse-bridge", "runtime");
  assert.deepEqual(
    fs.readdirSync(rtDir).filter((e) => e !== "current"),
    ["1.0.0"],
  );
  assert.equal(fs.readlinkSync(path.join(rtDir, "current")), "1.0.0");
  assert.equal(runtimeStatus({ home }).version, "1.0.0");
});

test("only the last 2 versions are kept", async () => {
  const home = tmpdir("muse-rt-home-");
  const src = makeSource();
  const rtDir = path.join(home, ".muse-bridge", "runtime");
  const base = Date.now() / 1000;
  for (const [i, v] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
    const res = await installRuntime({ version: v, home, source: `dir:${src}`, run: fakeRun([]) });
    assert.equal(res.ok, true, res.error);
    const at = base - 100 + i;
    fs.utimesSync(path.join(rtDir, v), at, at);
  }
  const res = await installRuntime({ version: "4.0.0", home, source: `dir:${src}`, run: fakeRun([]) });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(
    fs.readdirSync(rtDir).filter((e) => e !== "current").sort(),
    ["3.0.0", "4.0.0"],
  );
});

test("a .dev file points the shims at the given checkout", async () => {
  const home = tmpdir("muse-rt-home-");
  const src = makeSource();
  const res = await installRuntime({ version: "1.0.0", home, source: `dir:${src}`, run: fakeRun([]) });
  assert.equal(res.ok, true, res.error);
  const dev = makeSource("DEV CHECKOUT");
  fs.writeFileSync(path.join(home, ".muse-bridge", "bin", ".dev"), `${dev}\n`);
  const shim = path.join(home, ".muse-bridge", "bin", "musebridge");
  assert.match(execFileSync(shim, [], { encoding: "utf8", env: cleanEnv() }), /DEV CHECKOUT/);
  assert.equal(runtimeStatus({ home }).dev, dev);
  assert.equal(devOverride(home, cleanEnv()), dev);
});

test("MUSE_RUNTIME_DEV points the shims at the given checkout", async () => {
  const home = tmpdir("muse-rt-home-");
  const src = makeSource();
  const res = await installRuntime({ version: "1.0.0", home, source: `dir:${src}`, run: fakeRun([]) });
  assert.equal(res.ok, true, res.error);
  const dev = makeSource("DEV ENV");
  const shim = path.join(home, ".muse-bridge", "bin", "musebridge");
  const env = cleanEnv({ MUSE_RUNTIME_DEV: dev });
  assert.match(execFileSync(shim, [], { encoding: "utf8", env }), /DEV ENV/);
  assert.equal(devOverride(home, env), dev);
});

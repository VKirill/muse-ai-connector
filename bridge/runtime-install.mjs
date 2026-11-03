// Self-install of the Muse runtime on a BB host: the plugin ships only host.mjs,
// so the host daemon builds ~/.muse-bridge/runtime/<version> itself and writes
// shims under ~/.muse-bridge/bin. Plain ESM, Node built-ins only (bundled into host.mjs).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const REPO = "VKirill/muse-ai-connector";
const TOOLS = ["musebridge", "muse-acp"];
const KEEP_VERSIONS = 2;
const EXCLUDE_TOP = new Set([".git", ".bb", "node_modules"]);

function bridgeDir(home) {
  return path.join(home, ".muse-bridge");
}

function runtimeDir(home) {
  return path.join(bridgeDir(home), "runtime");
}

function binDir(home) {
  return path.join(bridgeDir(home), "bin");
}

export function devOverride(home, env = process.env) {
  const fromEnv = typeof env.MUSE_RUNTIME_DEV === "string" ? env.MUSE_RUNTIME_DEV.trim() : "";
  if (fromEnv) return fromEnv;
  try {
    const fromFile = fs.readFileSync(path.join(binDir(home), ".dev"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* no .dev file */
  }
  return null;
}

export function runtimeStatus({ home } = {}) {
  const dir = runtimeDir(home);
  let version = null;
  let runtimePath = null;
  try {
    const resolved = path.resolve(dir, fs.readlinkSync(path.join(dir, "current")));
    if (fs.existsSync(path.join(resolved, "bin", "musebridge.mjs"))) {
      version = path.basename(resolved);
      runtimePath = resolved;
    }
  } catch {
    /* no current link or broken target */
  }
  return { installed: runtimePath !== null, version, path: runtimePath, dev: devOverride(home) };
}

async function defaultRun(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    return {
      code: typeof e?.code === "number" ? e.code : 1,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? e),
    };
  }
}

function npmCommand() {
  const beside = path.join(path.dirname(process.execPath), "npm");
  return fs.existsSync(beside) ? beside : "npm";
}

function makeWritable(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      fs.chmodSync(p, fs.statSync(p).mode | (e.isDirectory() ? 0o700 : 0o600));
      if (e.isDirectory()) makeWritable(p);
    } catch {
      /* best effort */
    }
  }
}

function copyDirSource(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (EXCLUDE_TOP.has(parts[0])) return false;
      if (parts[0] === "bench" && parts[1] === "runs") return false;
      return true;
    },
  });
}

async function fetchTarball(url, dest, run) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tgz = `${dest}.tar.gz`;
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  try {
    fs.mkdirSync(dest, { recursive: true });
    const r = await run("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1"]);
    if (r.code !== 0) throw new Error(`tar failed: ${String(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  } finally {
    fs.rmSync(tgz, { force: true });
  }
}

function shimText(tool, runtimePath) {
  const escaped = runtimePath.replace(/(["\\`$])/g, "\\$1");
  return `#!/bin/sh
# Shim for ${tool}: a dev checkout (.dev file or MUSE_RUNTIME_DEV) wins, else the installed runtime.
self=$0
while [ -h "$self" ]; do
  d=$(dirname "$self")
  self=$(readlink "$self")
  case $self in /*) ;; *) self=$d/$self ;; esac
done
here=$(cd "$(dirname "$self")" && pwd -P)
target="${escaped}"
if [ -n "$MUSE_RUNTIME_DEV" ]; then
  target=$MUSE_RUNTIME_DEV
elif [ -f "$here/.dev" ]; then
  IFS= read -r target < "$here/.dev"
fi
for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$(command -v node 2>/dev/null)"; do
  [ -n "$n" ] && [ -x "$n" ] && exec "$n" "$target/bin/${tool}.mjs" "$@"
done
echo "${tool}: node not found" >&2
exit 127
`;
}

function writeShims(home, runtimePath) {
  const dir = binDir(home);
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of TOOLS) {
    const file = path.join(dir, tool);
    fs.writeFileSync(file, shimText(tool, runtimePath), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
}

function pruneVersions(home) {
  const dir = runtimeDir(home);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const versions = [];
  for (const e of entries) {
    if (e.name.includes(".tmp-")) {
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
      continue;
    }
    if (!e.isDirectory()) continue;
    versions.push({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs });
  }
  versions.sort((a, b) => b.mtime - a.mtime);
  for (const v of versions.slice(KEEP_VERSIONS)) {
    fs.rmSync(path.join(dir, v.name), { recursive: true, force: true });
  }
}

/**
 * @param {{version: string, home: string, source?: string, run?: Function}} opts
 * source: "dir:<path>" copies a checkout; default is the codeload tarball of tag v<version>.
 * run: injectable exec (cmd, args, opts) -> {code, stdout, stderr}; used for tar and npm.
 */
export async function installRuntime({ version, home, source, run = defaultRun } = {}) {
  version = String(version ?? "").trim();
  if (!/^[\w][\w.-]*$/.test(version)) return { ok: false, version, path: null, error: `bad version "${version}"` };
  if (process.platform === "win32") return { ok: false, version, path: null, error: "Windows is not supported" };

  const status = runtimeStatus({ home });
  const dir = runtimeDir(home);
  const dest = path.join(dir, version);
  if (status.installed && status.version === version) {
    writeShims(home, dest);
    return { ok: true, version, path: dest, alreadyInstalled: true };
  }

  fs.mkdirSync(dir, { recursive: true });
  const build = path.join(dir, `${version}.tmp-${process.pid}`);
  fs.rmSync(build, { recursive: true, force: true });
  try {
    if (typeof source === "string" && source.startsWith("dir:")) {
      copyDirSource(source.slice(4), build);
    } else {
      const url = source ?? `https://codeload.github.com/${REPO}/tar.gz/refs/tags/v${version}`;
      await fetchTarball(url, build, run);
    }
    if (!fs.existsSync(path.join(build, "package.json"))) {
      throw new Error("source did not produce a checkout (no package.json)");
    }
    makeWritable(build);
    const npm = await run(npmCommand(), ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: build });
    if (npm.code !== 0) {
      const tail = String(npm.stderr || npm.stdout || "").trim().split("\n").slice(-5).join("\n");
      throw new Error(`npm install failed: ${tail.slice(0, 500)}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(build, dest);
  } catch (e) {
    fs.rmSync(build, { recursive: true, force: true });
    return { ok: false, version, path: status.path, error: String(e?.message ?? e) };
  }

  const current = path.join(dir, "current");
  fs.rmSync(current, { force: true });
  fs.symlinkSync(version, current, "dir");
  writeShims(home, dest);
  pruneVersions(home);
  return { ok: true, version, path: dest };
}

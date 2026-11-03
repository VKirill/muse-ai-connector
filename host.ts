import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
// @ts-ignore bridge/runtime-install.mjs is plain ESM bundled into host.mjs; it has no .d.ts
import { installRuntime, runtimeStatus } from "./bridge/runtime-install.mjs";
import { PLUGIN_VERSION } from "./version.js";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

const HOME = os.homedir();
const ADD_TIMEOUT_MS = 11 * 60 * 1000;
const CHECK_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 15_000;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
];

const accountRow = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["signed_in", "signed_out", "unknown"]),
  locked: z.boolean(),
  lastUsedAt: z.string(),
  lastCheckedAt: z.string(),
  busy: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
});

const usageSnapshot = z.object({
  plan: z.string().nullable().optional(),
  planCode: z.string().nullable().optional(),
  isPaid: z.boolean().optional(),
  state: z.string().nullable().optional(),
  percentUsed: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
  quotaStatus: z.string().nullable().optional(),
  periodLabel: z.string().nullable().optional(),
  extraTokensTotal: z.number().nullable().optional(),
  extraTokensBalance: z.number().nullable().optional(),
  extraTokensLeftLabel: z.string().nullable().optional(),
  checkedAt: z.string().optional(),
});

const usageError = z.object({
  code: z.string(),
  message: z.string(),
});

const usageAccount = z.object({
  id: z.string(),
  usage: usageSnapshot.nullable(),
  error: usageError.nullable(),
});

const runtimeState = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  dev: z.string().nullable(),
  installing: z.boolean(),
  error: z.string().nullable(),
});

const hostStatus = z.object({
  platform: z.string(),
  chromeFound: z.boolean(),
  chromePath: z.string().nullable(),
  bridgeFound: z.boolean(),
  bridgeVersion: z.string().nullable(),
  agentFound: z.boolean(),
  runtime: runtimeState,
  accounts: z.array(accountRow),
  problems: z.array(z.string()),
});
export type HostStatus = z.infer<typeof hostStatus>;

const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatus, experimental_retryable: true },
  addAccount: { input: z.object({ label: z.string() }).strict(), output: hostStatus },
  checkAccounts: { input: z.object({ id: z.string().optional() }).strict(), output: hostStatus },
  removeAccount: { input: z.object({ id: z.string(), purge: z.boolean() }).strict(), output: hostStatus },
  installRuntime: { input: z.object({}).strict(), output: hostStatus },
  exportAccount: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      id: z.string(),
      label: z.string(),
      cookies: z.array(z.record(z.string(), z.unknown())),
      maxParallel: z.number().int().min(1).max(50).optional(),
    }),
  },
  importAccount: {
    input: z
      .object({
        id: z.string(),
        label: z.string(),
        cookies: z.array(z.record(z.string(), z.unknown())),
        maxParallel: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
  usage: {
    input: z.object({ id: z.string().optional() }).strict(),
    output: z.object({ accounts: z.array(usageAccount) }),
  },
});

function findCommand(name: string): string | null {
  const dirs = [
    path.join(HOME, ".muse-bridge/bin"),
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(HOME, ".local/bin"),
    path.join(HOME, ".agents/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const d of dirs) {
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {
      /* try next dir */
    }
  }
  return null;
}

function chromePath(): string | null {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

function stderrTail(text: string, n = 8): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join("\n");
}

const runtime = {
  attempted: false,
  running: null as Promise<void> | null,
  error: null as string | null,
};

function runtimeInfo() {
  const st = runtimeStatus({ home: HOME });
  return {
    installed: st.installed,
    version: st.version,
    path: st.path,
    dev: st.dev,
    installing: runtime.running !== null,
    error: runtime.error,
  };
}

async function performInstall(version: string): Promise<void> {
  try {
    const res = await installRuntime({ version, home: HOME });
    runtime.error = res.ok ? null : (res.error ?? "runtime install failed");
  } catch (e) {
    runtime.error = e instanceof Error ? e.message : String(e);
  } finally {
    runtime.running = null;
  }
}

function ensureRuntime(): void {
  if (process.platform === "win32" || runtime.attempted || runtime.running) return;
  const st = runtimeStatus({ home: HOME });
  if (st.dev) return;
  if (st.installed && st.version === PLUGIN_VERSION) return;
  runtime.attempted = true;
  runtime.running = performInstall(PLUGIN_VERSION);
}

async function runBridge(args: string[], timeout: number, stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = findCommand("musebridge");
  if (!bin) return { ok: false, stdout: "", stderr: "musebridge is not on PATH" };
  const env = {
    ...process.env,
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".local/bin")].join(path.delimiter),
  };
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, encoding: "utf8", env }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const err = error as { stdout?: string; stderr?: string; message?: string };
      resolve({ ok: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? error) });
    });
    child.stdin?.end(stdin ?? "", "utf8");
  });
}

async function readStatus(extraProblems: string[] = []): Promise<HostStatus> {
  const problems = [...extraProblems];
  const chrome = chromePath();
  const bin = findCommand("musebridge");
  const agent = findCommand("muse-acp");
  const rt = runtimeInfo();
  const out: HostStatus = {
    platform: process.platform,
    chromeFound: chrome !== null,
    chromePath: chrome,
    bridgeFound: bin !== null,
    bridgeVersion: bin ? (rt.dev ? "dev" : (rt.version ?? PLUGIN_VERSION)) : null,
    agentFound: agent !== null,
    runtime: rt,
    accounts: [],
    problems,
  };
  if (process.platform === "win32") problems.push("Muse runtime self-install is not supported on Windows.");
  if (!chrome) problems.push("Google Chrome is required (channel chrome).");
  if (!bin) {
    problems.push("musebridge is not on PATH of the BB host daemon.");
    return out;
  }
  if (!agent) problems.push("muse-acp is not on PATH of the BB host daemon.");
  const listed = await runBridge(["accounts", "list", "--json"], LIST_TIMEOUT_MS);
  if (!listed.ok) {
    const tail = stderrTail(listed.stderr);
    problems.push(tail || "musebridge accounts list failed.");
    return out;
  }
  try {
    const parsed = accountRow.array().safeParse(JSON.parse(listed.stdout));
    if (!parsed.success) problems.push("musebridge accounts list --json was not an account array.");
    else out.accounts = parsed.data;
  } catch {
    problems.push("musebridge accounts list --json was not valid JSON.");
  }
  return out;
}

function failNote(result: { ok: boolean; stderr: string }, fallback: string): string[] {
  if (result.ok) return [];
  const tail = stderrTail(result.stderr);
  return [tail || fallback];
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: () => {
      ensureRuntime();
      return readStatus();
    },
    async installRuntime() {
      if (process.platform === "win32") return readStatus(["Muse runtime is not supported on Windows."]);
      runtime.attempted = true;
      if (!runtime.running) runtime.running = performInstall(PLUGIN_VERSION);
      await runtime.running;
      return readStatus();
    },
    async addAccount({ label }) {
      const result = await runBridge(["accounts", "add", label], ADD_TIMEOUT_MS);
      return readStatus(failNote(result, "musebridge accounts add failed."));
    },
    async checkAccounts({ id }) {
      const args = id ? ["accounts", "check", id] : ["accounts", "check"];
      const result = await runBridge(args, CHECK_TIMEOUT_MS);
      return readStatus(failNote(result, "musebridge accounts check failed."));
    },
    async removeAccount({ id, purge }) {
      const args = purge ? ["accounts", "remove", id, "--purge"] : ["accounts", "remove", id];
      const result = await runBridge(args, LIST_TIMEOUT_MS);
      return readStatus(failNote(result, "musebridge accounts remove failed."));
    },
    async exportAccount({ id }) {
      const result = await runBridge(["accounts", "export", id, "--json"], LIST_TIMEOUT_MS);
      if (!result.ok) throw new Error(stderrTail(result.stderr) || "musebridge accounts export failed.");
      const parsed = JSON.parse(result.stdout) as { id?: unknown; label?: unknown; cookies?: unknown; maxParallel?: unknown };
      const out: {
        id: string;
        label: string;
        cookies: Record<string, unknown>[];
        maxParallel?: number;
      } = {
        id: typeof parsed.id === "string" ? parsed.id : id,
        label: typeof parsed.label === "string" ? parsed.label : id,
        cookies: Array.isArray(parsed.cookies) ? (parsed.cookies as Record<string, unknown>[]) : [],
      };
      if (Number.isInteger(parsed.maxParallel) && (parsed.maxParallel as number) >= 1) {
        out.maxParallel = parsed.maxParallel as number;
      }
      return out;
    },
    async importAccount({ id, label, cookies, maxParallel }) {
      const payload: { id: string; label: string; cookies: Record<string, unknown>[]; maxParallel?: number } = {
        id,
        label,
        cookies,
      };
      if (typeof maxParallel === "number") payload.maxParallel = maxParallel;
      const result = await runBridge(["accounts", "import", id, "--label", label], LIST_TIMEOUT_MS, JSON.stringify(payload));
      return { ok: result.ok, error: result.ok ? null : stderrTail(result.stderr) || "musebridge accounts import failed." };
    },
    async usage({ id }) {
      const args = id ? ["accounts", "usage", id, "--json"] : ["accounts", "usage", "--json"];
      const result = await runBridge(args, CHECK_TIMEOUT_MS);
      if (!result.ok) throw new Error(stderrTail(result.stderr) || "musebridge accounts usage failed.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error("musebridge accounts usage --json was not valid JSON.");
      }
      const rows = (parsed as { accounts?: unknown })?.accounts;
      const checked = z.array(usageAccount).safeParse(
        Array.isArray(rows)
          ? rows.map((row) => {
              const r = row as { id?: unknown; usage?: unknown; error?: unknown };
              return {
                id: typeof r.id === "string" ? r.id : "",
                usage: r.usage ?? null,
                error: r.error ?? null,
              };
            })
          : rows,
      );
      if (!checked.success) throw new Error("musebridge accounts usage --json was not an account usage list.");
      return { accounts: checked.data };
    },
  },
});

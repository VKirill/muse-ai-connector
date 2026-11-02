import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

const run = promisify(execFile);
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
});

const hostStatus = z.object({
  platform: z.string(),
  chromeFound: z.boolean(),
  chromePath: z.string().nullable(),
  bridgeFound: z.boolean(),
  bridgeVersion: z.string().nullable(),
  agentFound: z.boolean(),
  accounts: z.array(accountRow),
  problems: z.array(z.string()),
});
export type HostStatus = z.infer<typeof hostStatus>;

const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatus, experimental_retryable: true },
  addAccount: { input: z.object({ label: z.string() }).strict(), output: hostStatus },
  checkAccounts: { input: z.object({ id: z.string().optional() }).strict(), output: hostStatus },
  removeAccount: { input: z.object({ id: z.string(), purge: z.boolean() }).strict(), output: hostStatus },
});

function findCommand(name: string): string | null {
  const dirs = [
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

function pluginVersion(): string {
  try {
    const file = fileURLToPath(new URL("./package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function chromePath(): string | null {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

function stderrTail(text: string, n = 8): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join("\n");
}

async function runBridge(args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = findCommand("musebridge");
  if (!bin) return { ok: false, stdout: "", stderr: "musebridge is not on PATH" };
  const env = {
    ...process.env,
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".local/bin")].join(path.delimiter),
  };
  try {
    const { stdout, stderr } = await run(bin, args, { timeout, encoding: "utf8", env });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? e) };
  }
}

async function readStatus(extraProblems: string[] = []): Promise<HostStatus> {
  const problems = [...extraProblems];
  const chrome = chromePath();
  const bin = findCommand("musebridge");
  const agent = findCommand("muse-acp");
  const out: HostStatus = {
    platform: process.platform,
    chromeFound: chrome !== null,
    chromePath: chrome,
    bridgeFound: bin !== null,
    bridgeVersion: bin ? pluginVersion() : null,
    agentFound: agent !== null,
    accounts: [],
    problems,
  };
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
    status: () => readStatus(),
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
  },
});

import type { BbPluginApi, JsonValue, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
// @ts-ignore bridge/hub-sync.mjs is plain ESM bundled into the plugin; it has no .d.ts
import { syncAcrossHosts } from "./bridge/hub-sync.mjs";
// @ts-ignore launch-spec.mjs is plain ESM bundled into the plugin; it has no .d.ts
import { museLaunchSpec } from "./launch-spec.mjs";

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
export type UsageSnapshot = z.infer<typeof usageSnapshot>;

const usageError = z.object({
  code: z.string(),
  message: z.string(),
});
export type UsageError = z.infer<typeof usageError>;

const usageAccount = z.object({
  id: z.string(),
  usage: usageSnapshot.nullable(),
  error: usageError.nullable(),
});

const mergedUsageAccount = z.object({
  id: z.string(),
  label: z.string(),
  usage: usageSnapshot.nullable(),
  error: usageError.nullable(),
  hosts: z.array(z.string()),
});
export type MergedUsageAccount = z.infer<typeof mergedUsageAccount>;

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

const hostEntry = z.object({
  hostId: z.string(),
  name: z.string(),
  connected: z.boolean(),
  status: hostStatus.nullable(),
  error: z.string().nullable(),
});
export type HostEntry = z.infer<typeof hostEntry>;

const cookieRow = z.record(z.string(), z.unknown());
const exportResult = z.object({ id: z.string(), label: z.string(), cookies: z.array(cookieRow) });
const importResult = z.object({ ok: z.boolean(), error: z.string().nullable() });
const syncRow = z.object({ accountId: z.string(), hostId: z.string(), ok: z.boolean(), error: z.string().nullable() });
export type SyncRow = z.infer<typeof syncRow>;

const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatus, experimental_retryable: true },
  addAccount: { input: z.object({ label: z.string() }).strict(), output: hostStatus },
  checkAccounts: { input: z.object({ id: z.string().optional() }).strict(), output: hostStatus },
  removeAccount: { input: z.object({ id: z.string(), purge: z.boolean() }).strict(), output: hostStatus },
  installRuntime: { input: z.object({}).strict(), output: hostStatus },
  exportAccount: { input: z.object({ id: z.string() }).strict(), output: exportResult },
  importAccount: {
    input: z.object({ id: z.string(), label: z.string(), cookies: z.array(cookieRow) }).strict(),
    output: importResult,
  },
  usage: {
    input: z.object({ id: z.string().optional() }).strict(),
    output: z.object({ accounts: z.array(usageAccount) }),
  },
});

export const rpcContract = defineRpcContract({
  hosts: { input: z.object({ hostId: z.string().optional() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  addAccount: { input: z.object({ hostId: z.string(), label: z.string() }).strict(), output: z.object({ hosts: z.array(hostEntry), synced: z.array(syncRow) }) },
  syncAccounts: { input: z.object({ hostId: z.string(), id: z.string().optional() }).strict(), output: z.object({ hosts: z.array(hostEntry), synced: z.array(syncRow) }) },
  checkAccounts: { input: z.object({ hostId: z.string(), id: z.string().optional() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  removeAccount: { input: z.object({ hostId: z.string(), id: z.string(), purge: z.boolean() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  installRuntime: { input: z.object({ hostId: z.string() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  usage: { input: z.object({}).strict(), output: z.object({ accounts: z.array(mergedUsageAccount) }) },
});

type HostUsageFetch = (
  hostId: string,
  id: string,
) => Promise<{ accounts: Array<{ id: string; usage: UsageSnapshot | null; error: UsageError | null }> }>;

export const USAGE_TIMEOUT_MS = 45000;

class UsageTimeoutError extends Error {
  constructor(ms: number) {
    super(`usage fetch timed out after ${ms} ms`);
    this.name = "UsageTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UsageTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function collectMergedUsage(
  hosts: HostEntry[],
  fetchUsage: HostUsageFetch,
  opts: { timeoutMs?: number } = {},
): Promise<MergedUsageAccount[]> {
  const timeoutMs = opts.timeoutMs ?? USAGE_TIMEOUT_MS;
  type Group = { label: string; hosts: string[]; sourceHostId: string | null };
  const groups = new Map<string, Group>();
  for (const host of hosts) {
    if (!host.status) continue;
    for (const account of host.status.accounts) {
      let group = groups.get(account.id);
      if (!group) {
        group = { label: account.label, hosts: [], sourceHostId: null };
        groups.set(account.id, group);
      }
      if (!group.hosts.includes(host.hostId)) group.hosts.push(host.hostId);
      if (!group.sourceHostId && host.connected && account.status === "signed_in") group.sourceHostId = host.hostId;
    }
  }
  return Promise.all(
    [...groups.entries()].map(async ([id, group]) => {
      if (!group.sourceHostId) {
        return { id, label: group.label, usage: null, error: null, hosts: group.hosts };
      }
      try {
        const result = await withTimeout(fetchUsage(group.sourceHostId, id), timeoutMs);
        const row = result.accounts.find((a) => a.id === id) ?? result.accounts[0];
        return {
          id,
          label: group.label,
          usage: row?.usage ?? null,
          error: row?.error ?? null,
          hosts: group.hosts,
        };
      } catch (e) {
        return {
          id,
          label: group.label,
          usage: null,
          error: {
            code: e instanceof UsageTimeoutError ? "usage_timeout" : "usage_unavailable",
            message: e instanceof Error ? e.message : String(e),
          },
          hosts: group.hosts,
        };
      }
    }),
  );
}

export const MUSE_PROVIDER_ID = "muse";
export const MUSE_AGENT_COMMAND = "muse-acp";

const SETTINGS = {
  agentCommand: {
    type: "string",
    label: "Agent command",
    description: "Command that starts the Muse agent on the host. Leave empty to use the runtime the plugin installs (~/.muse-bridge/bin/muse-acp); set an absolute path only to override it.",
    default: "",
  },
  headless: {
    type: "boolean",
    label: "Headless Chrome",
    description: "Run the Muse browser window hidden. Turn off to watch the Chrome profile while a chat runs.",
    default: true,
  },
  replyTimeoutSec: {
    type: "number",
    label: "Reply timeout (seconds)",
    description: "How long to wait for Muse to finish a reply.",
    experimental_schema: z.number().int().min(10).max(1800),
    default: 180,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define(SETTINGS);
  const host = bb.hosts.experimental_client({ contract: hostContract });

  // A host `status` call makes the host install its runtime when it is missing
  // or older than PLUGIN_VERSION. Warm every connected host at plugin start and
  // every 10 minutes so the runtime lands without the settings screen opening.
  const WARMUP_INTERVAL_MS = 10 * 60 * 1000;
  const warmRuntimes = async (): Promise<void> => {
    try {
      const listed = await bb.sdk.hosts.list();
      await Promise.all(
        listed
          .filter((h) => h.status === "connected")
          .map(async (h) => {
            try {
              await host.call("status", {}, { hostId: h.id });
            } catch (e) {
              bb.log.debug(`Muse runtime warm-up on ${h.name || h.id} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }),
      );
    } catch (e) {
      bb.log.debug(`Muse runtime warm-up failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  bb.background.service("runtime-warmup", {
    start(signal) {
      void warmRuntimes();
      const timer = setInterval(() => void warmRuntimes(), WARMUP_INTERVAL_MS);
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          resolve();
        }, { once: true });
      });
    },
  });

  const agentEnv = (v: Record<string, string | number | boolean | undefined>) => ({
    MUSE_HEADLESS: v.headless === false ? "0" : "1",
    MUSE_REPLY_TIMEOUT_SEC: String(Math.max(10, Math.floor(Number(v.replyTimeoutSec ?? 180)))),
  });

  bb.providers.register({
    id: MUSE_PROVIDER_ID,
    displayName: "Muse",
    icon: "./icons/muse.svg",
    family: "acp",
    strings: {
      signInHint: "Sign in to a Muse account in BB Settings → Plugins → Muse",
      expiredHint: "The Muse session expired. Sign in again in BB Settings → Plugins → Muse.",
      installUrl: "https://muse.ai/",
    },
    experimental_visibility: "installed",
    experimental_bridgeOptions: {
      acpLaunchSpec: museLaunchSpec("") as JsonValue,
    },
    deriveProviderOptions(ctx) {
      return {
        acpLaunchSpec: museLaunchSpec(String(ctx.settings.agentCommand ?? "")) as JsonValue,
      };
    },
    models: {
      scope: "host",
      fallback: [
        {
          id: "muse-spark",
          displayName: "Muse Spark",
          description: "Meta Muse personal assistant.",
          // Muse has no reasoning knob; BB levels are accepted and ignored by the agent.
          supportedReasoningEfforts: [
            { reasoningEffort: "none", description: "Standard" },
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "muse-image",
          displayName: "Muse Image",
          description: "Generate pictures with Muse. Optional leading form factor (16:9, 9:16, …).",
          supportedReasoningEfforts: [
            { reasoningEffort: "none", description: "Standard" },
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ],
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["none", "low", "medium", "high"],
    },
    reasoningLevels: [
      { id: "none", label: "Standard" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    composerActions: [],
  });

  bb.providers.experimental_contributeEnv(MUSE_PROVIDER_ID, async () => {
    const env = agentEnv(await settings.get());
    return Object.entries(env).map(([name, value]) => ({ name, value, reason: "Muse provider setting" }));
  });

  async function oneHost(hostId: string, call: (id: string) => Promise<z.infer<typeof hostStatus>>): Promise<{ hosts: HostEntry[] }> {
    const listed = await bb.sdk.hosts.list();
    const row = listed.find((h) => h.id === hostId);
    if (!row) return { hosts: [] };
    const connected = row.status === "connected";
    const name = row.name || row.id;
    if (!connected) return { hosts: [{ hostId: row.id, name, connected, status: null, error: null }] };
    try {
      const status = await call(row.id);
      return { hosts: [{ hostId: row.id, name, connected, status, error: null }] };
    } catch (e) {
      return { hosts: [{ hostId: row.id, name, connected, status: null, error: e instanceof Error ? e.message : String(e) }] };
    }
  }

  async function listHosts(hostId?: string): Promise<HostEntry[]> {
    const listed = await bb.sdk.hosts.list();
    const rows = listed.filter((h) => !hostId || h.id === hostId);
    const hosts: HostEntry[] = await Promise.all(
      rows.map(async (h): Promise<HostEntry> => {
        const connected = h.status === "connected";
        const name = h.name || h.id;
        if (!connected) return { hostId: h.id, name, connected, status: null, error: null };
        try {
          const status = await host.call("status", {}, { hostId: h.id });
          return { hostId: h.id, name, connected, status, error: null };
        } catch (e) {
          return { hostId: h.id, name, connected, status: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    hosts.sort((a, b) => Number(b.status?.chromeFound ?? false) - Number(a.status?.chromeFound ?? false));
    return hosts;
  }

  const callHost = (method: string, input: unknown, { hostId }: { hostId: string }): Promise<unknown> =>
    method === "exportAccount"
      ? host.call("exportAccount", input as { id: string }, { hostId })
      : host.call("importAccount", input as { id: string; label: string; cookies: Record<string, unknown>[] }, { hostId });

  const syncTargets = (entries: HostEntry[]) =>
    entries.map((h) => ({
      hostId: h.hostId,
      connected: h.connected,
      runtime: Boolean(h.status?.runtime?.installed || h.status?.runtime?.dev),
    }));

  async function syncFrom(sourceHostId: string, accountId: string, entries: HostEntry[]): Promise<SyncRow[]> {
    const targets = syncTargets(entries);
    try {
      const rows = (await syncAcrossHosts({ sourceHostId, accountId, hosts: targets, call: callHost })) as {
        hostId: string;
        ok: boolean;
        error?: string;
      }[];
      return rows.map((r) => ({ accountId, hostId: r.hostId, ok: r.ok, error: r.error ?? null }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return targets
        .filter((t) => t.hostId !== sourceHostId && t.connected && t.runtime)
        .map((t) => ({ accountId, hostId: t.hostId, ok: false, error }));
    }
  }

  bb.rpc.register(rpcContract, {
    async hosts({ hostId }) {
      return { hosts: await listHosts(hostId) };
    },
    async addAccount({ hostId, label }) {
      const answer = await oneHost(hostId, (id) => host.call("addAccount", { label }, { hostId: id }));
      const created = answer.hosts[0]?.status?.accounts?.filter((a) => a.label === label && a.status === "signed_in").pop();
      if (!created) return { ...answer, synced: [] as SyncRow[] };
      const entries = await listHosts();
      return { ...answer, synced: await syncFrom(hostId, created.id, entries) };
    },
    async syncAccounts({ hostId, id }) {
      const entries = await listHosts();
      const source = entries.find((h) => h.hostId === hostId);
      if (!source?.connected || !source.status) {
        return { hosts: source ? [source] : [], synced: [] as SyncRow[] };
      }
      const ids = id ? [id] : source.status.accounts.filter((a) => a.status === "signed_in").map((a) => a.id);
      const synced: SyncRow[] = [];
      for (const accountId of ids) synced.push(...(await syncFrom(hostId, accountId, entries)));
      return { hosts: entries, synced };
    },
    checkAccounts({ hostId, id }) {
      return oneHost(hostId, (hid) => host.call("checkAccounts", id ? { id } : {}, { hostId: hid }));
    },
    removeAccount({ hostId, id, purge }) {
      return oneHost(hostId, (hid) => host.call("removeAccount", { id, purge }, { hostId: hid }));
    },
    installRuntime({ hostId }) {
      return oneHost(hostId, (hid) => host.call("installRuntime", {}, { hostId: hid }));
    },
    async usage() {
      const hosts = await listHosts();
      const accounts = await collectMergedUsage(hosts, (hostId, id) => host.call("usage", { id }, { hostId }));
      return { accounts };
    },
  });
}

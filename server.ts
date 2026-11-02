import type { BbPluginApi, JsonValue, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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

const hostEntry = z.object({
  hostId: z.string(),
  name: z.string(),
  connected: z.boolean(),
  status: hostStatus.nullable(),
  error: z.string().nullable(),
});
export type HostEntry = z.infer<typeof hostEntry>;

const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatus, experimental_retryable: true },
  addAccount: { input: z.object({ label: z.string() }).strict(), output: hostStatus },
  checkAccounts: { input: z.object({ id: z.string().optional() }).strict(), output: hostStatus },
  removeAccount: { input: z.object({ id: z.string(), purge: z.boolean() }).strict(), output: hostStatus },
});

export const rpcContract = defineRpcContract({
  hosts: { input: z.object({ hostId: z.string().optional() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  addAccount: { input: z.object({ hostId: z.string(), label: z.string() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  checkAccounts: { input: z.object({ hostId: z.string(), id: z.string().optional() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
  removeAccount: { input: z.object({ hostId: z.string(), id: z.string(), purge: z.boolean() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
});

export const MUSE_PROVIDER_ID = "muse";
export const MUSE_AGENT_COMMAND = "muse-acp";

const SETTINGS = {
  agentCommand: {
    type: "string",
    label: "Agent command",
    description: "Command that starts the Muse agent on the host. Change it only if muse-acp is not on the host daemon's PATH (use an absolute path).",
    default: MUSE_AGENT_COMMAND,
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
      acpLaunchSpec: { displayName: "Muse", command: MUSE_AGENT_COMMAND, args: [], env: {} },
    },
    deriveProviderOptions(ctx) {
      const command = String(ctx.settings.agentCommand ?? "").trim() || MUSE_AGENT_COMMAND;
      return {
        acpLaunchSpec: {
          displayName: "Muse",
          command,
          args: [],
          env: {},
          permissionCli: { full: ["--bb-permission=full"], workspaceWrite: ["--bb-permission=accept-edits"] },
        } as JsonValue,
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

  bb.rpc.register(rpcContract, {
    async hosts({ hostId }) {
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
      return { hosts };
    },
    addAccount({ hostId, label }) {
      return oneHost(hostId, (id) => host.call("addAccount", { label }, { hostId: id }));
    },
    checkAccounts({ hostId, id }) {
      return oneHost(hostId, (hid) => host.call("checkAccounts", id ? { id } : {}, { hostId: hid }));
    },
    removeAccount({ hostId, id, purge }) {
      return oneHost(hostId, (hid) => host.call("removeAccount", { id, purge }, { hostId: hid }));
    },
  });
}

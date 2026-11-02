import type { BbPluginApi, JsonValue, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
          supportedReasoningEfforts: [{ reasoningEffort: "none", description: "Standard" }],
          defaultReasoningEffort: "none",
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
      reasoningLevels: ["none"],
    },
    reasoningLevels: [{ id: "none", label: "Standard" }],
    composerActions: [],
  });

  bb.providers.experimental_contributeEnv(MUSE_PROVIDER_ID, async () => {
    const env = agentEnv(await settings.get());
    return Object.entries(env).map(([name, value]) => ({ name, value, reason: "Muse provider setting" }));
  });
}

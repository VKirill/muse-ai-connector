import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

const hostContract = defineRpcContract({
  ping: { input: z.object({}).strict(), output: z.object({ ok: z.literal(true) }) },
});

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ping: () => ({ ok: true as const }),
  },
});

import os from "node:os";
import path from "node:path";

/** @returns {string} */
export function bridgeHome() {
  const override = process.env.MUSE_BRIDGE_HOME;
  if (override) return override;
  return path.join(os.homedir(), ".muse-bridge");
}

/**
 * @param {string} [accountId]
 * @returns {string}
 */
export function profileDir(accountId = "default") {
  return path.join(bridgeHome(), "profiles", accountId);
}

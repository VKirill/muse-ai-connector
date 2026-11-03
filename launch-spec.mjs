const PERMISSION_CLI = {
  full: ["--bb-permission=full"],
  workspaceWrite: ["--bb-permission=accept-edits"],
};

export function museLaunchSpec(agentCommand) {
  const command = String(agentCommand ?? "").trim();
  if (command) {
    return {
      displayName: "Muse",
      command,
      args: [],
      env: {},
      permissionCli: { ...PERMISSION_CLI, insertAfterArgs: 0 },
    };
  }
  return {
    displayName: "Muse",
    command: "/bin/sh",
    args: ["-c", 'exec "$HOME/.muse-bridge/bin/muse-acp" "$@"', "muse-acp"],
    env: {},
    permissionCli: { ...PERMISSION_CLI, insertAfterArgs: 3 },
  };
}

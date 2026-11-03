import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { museLaunchSpec } from "../launch-spec.mjs";

function applyPermissionCliArgs(spec, mode) {
  const extra = mode === "full" ? spec.permissionCli.full : spec.permissionCli.workspaceWrite;
  const at = Math.min(spec.permissionCli.insertAfterArgs ?? 0, spec.args.length);
  return [...spec.args.slice(0, at), ...extra, ...spec.args.slice(at)];
}

test("BB flag insertion hands --bb-permission flags to muse-acp through /bin/sh", () => {
  const home = mkdtempSync("/tmp/muse-launch-home.");
  mkdirSync(join(home, ".muse-bridge/bin"), { recursive: true });
  const fake = join(home, ".muse-bridge/bin/muse-acp");
  writeFileSync(fake, '#!/bin/sh\necho "ARGS:$*"\n');
  chmodSync(fake, 0o755);

  const spec = museLaunchSpec("");
  assert.equal(spec.command, "/bin/sh");
  assert.deepEqual(spec.args, ["-c", 'exec "$HOME/.muse-bridge/bin/muse-acp" "$@"', "muse-acp"]);
  assert.equal(spec.permissionCli.insertAfterArgs, 3);

  for (const mode of ["full", "workspaceWrite"]) {
    const argv = applyPermissionCliArgs(spec, mode);
    const out = execFileSync(spec.command, argv, {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const want = mode === "full" ? "--bb-permission=full" : "--bb-permission=accept-edits";
    assert.equal(out.trim(), `ARGS:${want}`);
  }
});

test("Agent command override gets the permission flag as its first argument", () => {
  const spec = museLaunchSpec("/opt/x/muse-acp");
  assert.equal(spec.command, "/opt/x/muse-acp");
  assert.deepEqual(spec.args, []);
  assert.equal(spec.permissionCli.insertAfterArgs, 0);
  assert.equal(applyPermissionCliArgs(spec, "full")[0], "--bb-permission=full");
  assert.equal(applyPermissionCliArgs(spec, "workspaceWrite")[0], "--bb-permission=accept-edits");
});

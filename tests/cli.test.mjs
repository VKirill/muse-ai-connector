import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "bin", "musebridge.mjs");

test("musebridge --help exits 0 and names doctor, chats, history, send, login", async () => {
  const { stdout, stderr } = await execFileP(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(stderr, "");
  for (const command of ["doctor", "chats", "history", "send", "login"]) {
    assert.match(stdout, new RegExp(command));
  }
});

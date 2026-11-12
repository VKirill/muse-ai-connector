import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { addAccount, listAccounts, setStatus } from "../bridge/accounts.mjs";
import {
  extractOtpFromImapFetch,
  loadCredentialsFromEnvCatalog,
  parseCredentialLines,
  resolveImapHost,
} from "../bridge/auto-login.mjs";
import { cmdAccountsAutoLogin } from "../bin/musebridge.mjs";

function withHome(fn) {
  const dir = fs.mkdtempSync("/tmp/muse-autologin-");
  const prev = process.env.MUSE_BRIDGE_HOME;
  process.env.MUSE_BRIDGE_HOME = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (prev === undefined) delete process.env.MUSE_BRIDGE_HOME;
      else process.env.MUSE_BRIDGE_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("resolveImapHost maps common mailbox providers and custom domains", () => {
  assert.equal(resolveImapHost("mail.com"), "imap.mail.com");
  assert.equal(resolveImapHost("", "alice@mail.com"), "imap.mail.com");
  assert.equal(resolveImapHost("outlook.com"), "outlook.office365.com");
  assert.equal(resolveImapHost("imap.custom.org"), "imap.custom.org");
  assert.equal(resolveImapHost("example.org"), "imap.example.org");
});

test("parseCredentialLines parses mailbox suffix and skips comments", () => {
  const input = [
    "# comment",
    "alice@mail.com PassOne mailbox: mail.com",
    "bob@gmx.com PassTwo",
    "-- trailing note in Russian",
  ].join("\n");
  assert.deepEqual(parseCredentialLines(input), [
    { email: "alice@mail.com", password: "PassOne", imapHost: "imap.mail.com" },
    { email: "bob@gmx.com", password: "PassTwo", imapHost: "imap.gmx.com" },
  ]);
});

test("extractOtpFromImapFetch picks newest OTP at or above minUid and ignores older UIDs", () => {
  const raw = [
    '* 4 FETCH (UID 4 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {45}',
    'Subject: Use code 111111 to log in',
    ' BODY[TEXT] {30}',
    'Login code 111111)',
    '* 5 FETCH (UID 5 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {45}',
    'Subject: Use code 842915 to log in',
    ' BODY[TEXT] {30}',
    'Login code 842915)',
    'a3 OK FETCH completed',
  ].join("\r\n");

  assert.deepEqual(extractOtpFromImapFetch(raw, 5), { maxUid: 5, code: "842915" });
  assert.deepEqual(extractOtpFromImapFetch(raw, 6), { maxUid: 5, code: null });
});

test("loadCredentialsFromEnvCatalog discovers MUSE_MAIL_* entries without leaking passwords", async () => {
  const calls = [];
  const fakeExec = async (_cmd, args) => {
    calls.push(args);
    if (args[1] === "list") {
      return {
        stdout: JSON.stringify([
          {
            name: "MUSE_MAIL_JOHN",
            kind: "login",
            service: "mail.com",
            maskedValue: "john@mail.com@https://www.mail.com/",
            tags: ["muse", "mail.com"],
          },
          {
            name: "UNRELATED_LOGIN",
            kind: "login",
            service: "other.com",
            maskedValue: "other@other.com@https://other.com",
            tags: null,
          },
        ]),
      };
    }
    return {
      stdout: JSON.stringify({
        name: "MUSE_MAIL_JOHN",
        access: { host: "mail.com", username: "john@mail.com", password: "SecretPassword1" },
      }),
    };
  };

  const creds = await loadCredentialsFromEnvCatalog([], { exec: fakeExec, includeTaggedMuse: true });
  assert.equal(creds.size, 1);
  assert.deepEqual(creds.get("john@mail.com"), {
    email: "john@mail.com",
    password: "SecretPassword1",
    imapHost: "imap.mail.com",
  });
  assert.equal(calls.length, 2);
});

test("cmdAccountsAutoLogin skips already signed-in accounts by default and registers newly discovered Muse logins", async () => {
  await withHome(async () => {
    const existing = addAccount("alice@mail.com");
    setStatus(existing.id, "signed_in");
    const signedOut = addAccount("bob@mail.com");
    setStatus(signedOut.id, "signed_out");

    const seen = [];
    let hubSynced = 0;

    await cmdAccountsAutoLogin(["--json"], {
      loadCredentialsFromEnvCatalog: async () =>
        new Map([
          ["alice@mail.com", { email: "alice@mail.com", password: "p1", imapHost: "imap.mail.com" }],
          ["bob@mail.com", { email: "bob@mail.com", password: "p2", imapHost: "imap.mail.com" }],
          ["newuser@mail.com", { email: "newuser@mail.com", password: "p3", imapHost: "imap.mail.com" }],
        ]),
      autoLoginAccount: async (opts) => {
        seen.push(opts.email);
        const acc = listAccounts().find((a) => a.label === opts.email) ?? addAccount(opts.email);
        setStatus(acc.id, "signed_in");
        return { id: acc.id, email: opts.email, status: "signed_in", cookiesCount: 8 };
      },
      syncBbHubAccounts: async () => {
        hubSynced += 1;
        return { synced: [] };
      },
    });

    assert.deepEqual(seen, ["bob@mail.com", "newuser@mail.com"]);
    assert.equal(hubSynced, 1);
  });
});

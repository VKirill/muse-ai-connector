#!/usr/bin/env node
import fs from "node:fs";
import {
  acquire,
  addAccount,
  busySlots,
  isLocked,
  listAccounts,
  maxParallelOf,
  pickAccount,
  removeAccount,
  setMaxParallel,
  setStatus,
  touch,
} from "../bridge/accounts.mjs";
import { saveCookies } from "../bridge/cookies.mjs";
import { openTransport, resolveTransport } from "../bridge/protocol/api.mjs";
import { chromeExecutable, openSession } from "../bridge/session.mjs";
import { profileDir } from "../bridge/paths.mjs";

const HELP = `Usage: musebridge <command>

Commands:
  doctor [--account <id>]   Check Chrome, the profile directory, and sign-in
  chats [--account <id>] [--transport api|browser] [--json]
                            List side chats
  history [--account <id>] [--transport api|browser] <chatId> [--json]
                            Show a chat transcript
  send [--account <id>] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>
                            Send a message and print the reply
  approve [--account <id>] --chat <id>
                            Answer pending approval cards (Always allow;
                            cards about money are left to you)
  accounts list [--json]    List Muse accounts
  accounts add <label>      Register an account and open a sign-in window
  accounts remove <id> [--purge]
                            Remove an account from the registry
  accounts check [<id>]     Refresh signed-in status
  accounts refresh <id>     Export cookies from the signed-in Chrome profile
  accounts set <id> --max-parallel <n>
                            Set how many chats the account serves at once (1..50)
  login                     Sign in (adds account default when none exist)
  --help                    Show this help
`;

function printHelp() {
  process.stdout.write(HELP);
}

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1];
  args.splice(i, 2);
  return value ?? null;
}

function resolveAccountId(flag) {
  if (flag) return flag;
  const accounts = listAccounts();
  const fallback = accounts.find((a) => a.id === "default") ?? accounts[0];
  return fallback?.id ?? "default";
}

async function withSession(opts, fn) {
  const session = await openSession(opts);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function exportAccountCookies(session, accountId) {
  if (typeof session.exportCookies !== "function") return;
  try {
    saveCookies(accountId, await session.exportCookies());
  } catch {
    process.stderr.write("Could not export cookies; API transport will fall back to browser.\n");
  }
}

async function withTransport(opts, fn) {
  const transport = resolveTransport({ flag: opts.transport, env: process.env });
  const session = await openTransport({
    accountId: opts.accountId,
    transport,
    drivers: {
      openSession: (openOpts) => openSession({ ...openOpts, headless: opts.headless }),
    },
  });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function requireSignedIn(session, accountId) {
  const ok = await session.isSignedIn();
  if (!ok) {
    if (accountId) {
      try {
        setStatus(accountId, "signed_out");
      } catch {
        /* account may not be registered yet */
      }
    }
    process.stderr.write("Not signed in to Muse. Run: musebridge accounts add <label>\n");
    process.exit(2);
  }
  if (accountId) {
    try {
      setStatus(accountId, "signed_in");
    } catch {
      /* ignore unregistered profile */
    }
  }
}

async function cmdDoctor(args) {
  const accountId = resolveAccountId(takeOption(args, "--account"));
  const chrome = chromeExecutable();
  const profile = profileDir(accountId);
  const profileExists = fs.existsSync(profile);
  process.stdout.write(`Chrome: ${chrome ? `found (${chrome})` : "not found"}\n`);
  process.stdout.write(`Account: ${accountId}\n`);
  process.stdout.write(`Profile: ${profileExists ? `exists (${profile})` : `missing (${profile})`}\n`);
  if (!chrome) {
    process.stderr.write("Google Chrome is required (channel chrome).\n");
    process.exit(1);
  }
  await withSession({ accountId, headless: true }, async (session) => {
    const signedIn = await session.isSignedIn();
    process.stdout.write(`Signed in: ${signedIn ? "yes" : "no"}\n`);
    if (listAccounts().some((a) => a.id === accountId)) {
      setStatus(accountId, signedIn ? "signed_in" : "signed_out");
    }
    if (!signedIn) process.exit(2);
  });
}

async function cmdChats(args) {
  const asJson = takeFlag(args, "--json");
  const accountId = resolveAccountId(takeOption(args, "--account"));
  const transport = takeOption(args, "--transport");
  await withTransport({ accountId, transport, headless: true }, async (session) => {
    await requireSignedIn(session, accountId);
    const chats = await session.listChats();
    if (asJson) {
      process.stdout.write(`${JSON.stringify(chats, null, 2)}\n`);
      return;
    }
    for (const chat of chats) {
      process.stdout.write(`${chat.id}\t${chat.title ?? ""}\t${chat.snippet ?? ""}\n`);
    }
  });
}

async function cmdHistory(args) {
  const asJson = takeFlag(args, "--json");
  const accountId = resolveAccountId(takeOption(args, "--account"));
  const transport = takeOption(args, "--transport");
  const chatId = args[0];
  if (!chatId) {
    process.stderr.write("Usage: musebridge history [--account <id>] [--transport api|browser] <chatId> [--json]\n");
    process.exit(1);
  }
  await withTransport({ accountId, transport, headless: true }, async (session) => {
    await requireSignedIn(session, accountId);
    const parsed = await session.history(chatId);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    }
    for (const message of parsed.messages) {
      process.stdout.write(`${message.role}: ${message.content}\n`);
    }
  });
}

async function cmdSend(args) {
  const asJson = takeFlag(args, "--json");
  const headed = takeFlag(args, "--headed");
  const chatId = takeOption(args, "--chat");
  const timeoutSec = takeOption(args, "--timeout");
  const accountFlag = takeOption(args, "--account");
  const transport = takeOption(args, "--transport");
  const text = args.join(" ").trim();
  if (!text) {
    process.stderr.write("Usage: musebridge send [--account <id>] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>\n");
    process.exit(1);
  }
  const timeoutMs = timeoutSec ? Math.max(1, Number(timeoutSec)) * 1000 : undefined;
  if (timeoutSec && !Number.isFinite(timeoutMs)) {
    process.stderr.write(`Bad --timeout value: ${timeoutSec}\n`);
    process.exit(1);
  }
  const accountId = accountFlag || pickAccount().id;
  const release = acquire(accountId, { owner: "musebridge-send" });
  try {
    touch(accountId);
    await withTransport({ accountId, transport, headless: !headed }, async (session) => {
      await requireSignedIn(session, accountId);
      const result = await session.send({
        chatId: chatId || undefined,
        text,
        timeoutMs,
        onDelta: asJson
          ? undefined
          : (suffix) => {
              process.stdout.write(suffix);
            },
      });
      if (!asJson) process.stdout.write("\n");
      else process.stdout.write(`${JSON.stringify({ chatId: result.chatId, messageId: result.messageId, text: result.text })}\n`);
    });
  } finally {
    release();
  }
}

async function cmdApprove(args) {
  const chatId = takeOption(args, "--chat");
  const accountFlag = takeOption(args, "--account");
  if (!chatId) {
    process.stderr.write("Usage: musebridge approve [--account <id>] --chat <id>\n");
    process.exit(1);
  }
  const accountId = accountFlag || pickAccount().id;
  const release = acquire(accountId, { owner: "musebridge-approve" });
  try {
    touch(accountId);
    await withSession({ accountId, headless: true }, async (session) => {
      await requireSignedIn(session, accountId);
      const handled = await session.approve(chatId);
      if (handled.length === 0) {
        process.stdout.write("No pending approval cards.\n");
        return;
      }
      for (const card of handled) {
        if (card.decision === "ask") {
          process.stdout.write(`left for you: ${card.title}\n`);
        } else {
          process.stdout.write(`always allow: ${card.title}\n`);
        }
      }
    });
  } finally {
    release();
  }
}

async function cmdAccountsAdd(args) {
  const label = args.join(" ").trim();
  if (!label) {
    process.stderr.write("Usage: musebridge accounts add <label>\n");
    process.exit(1);
  }
  const account = addAccount(label);
  process.stdout.write(`Registered ${account.id} (${account.label})\n`);
  await withSession({ accountId: account.id, headless: false }, async (session) => {
    const ok = await session.waitForSignIn();
    setStatus(account.id, ok ? "signed_in" : "signed_out");
    if (!ok) {
      process.stderr.write("Timed out waiting for Muse sign-in.\n");
      process.exit(2);
    }
    await exportAccountCookies(session, account.id);
    process.stdout.write(`Signed in as ${account.id}.\n`);
  });
}

async function cmdAccountsList(args) {
  const asJson = takeFlag(args, "--json");
  const accounts = listAccounts().map((account) => ({
    ...account,
    locked: isLocked(account.id),
    busy: busySlots(account.id),
    max: maxParallelOf(account.id),
  }));
  if (asJson) {
    process.stdout.write(`${JSON.stringify(accounts, null, 2)}\n`);
    return;
  }
  if (accounts.length === 0) {
    process.stdout.write("No accounts. Run: musebridge accounts add <label>\n");
    return;
  }
  for (const account of accounts) {
    process.stdout.write(`${account.id}\t${account.label}\t${account.status}\t${account.busy}/${account.max}\n`);
  }
}

async function cmdAccountsRemove(args) {
  const purge = takeFlag(args, "--purge");
  const id = args[0];
  if (!id) {
    process.stderr.write("Usage: musebridge accounts remove <id> [--purge]\n");
    process.exit(1);
  }
  removeAccount(id, { purge });
  process.stdout.write(`Removed ${id}${purge ? " (profile purged)" : ""}\n`);
}

async function cmdAccountsCheck(args) {
  const id = args[0];
  const targets = id ? listAccounts().filter((a) => a.id === id) : listAccounts();
  if (id && targets.length === 0) {
    process.stderr.write(`Unknown account: ${id}\n`);
    process.exit(1);
  }
  for (const account of targets) {
    await withSession({ accountId: account.id, headless: true }, async (session) => {
      const signedIn = await session.isSignedIn();
      setStatus(account.id, signedIn ? "signed_in" : "signed_out");
      process.stdout.write(`${account.id}\t${signedIn ? "signed_in" : "signed_out"}\n`);
    });
  }
}

async function cmdAccountsSet(args) {
  const raw = takeOption(args, "--max-parallel");
  const id = args[0];
  if (!id || raw === null) {
    process.stderr.write("Usage: musebridge accounts set <id> --max-parallel <n>\n");
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    process.stderr.write(`Bad --max-parallel value: ${raw} (expected an integer 1..50)\n`);
    process.exit(1);
  }
  setMaxParallel(id, n);
  process.stdout.write(`${id} maxParallel=${n}\n`);
}

async function cmdAccountsRefresh(args) {
  const id = args[0];
  if (!id) {
    process.stderr.write("Usage: musebridge accounts refresh <id>\n");
    process.exit(1);
  }
  await withSession({ accountId: id, headless: true }, async (session) => {
    await requireSignedIn(session, id);
    await exportAccountCookies(session, id);
    process.stdout.write(`Refreshed cookies for ${id}.\n`);
  });
}

async function cmdAccounts(args) {
  const sub = args.shift();
  switch (sub) {
    case "list":
      await cmdAccountsList(args);
      break;
    case "add":
      await cmdAccountsAdd(args);
      break;
    case "remove":
      await cmdAccountsRemove(args);
      break;
    case "check":
      await cmdAccountsCheck(args);
      break;
    case "refresh":
      await cmdAccountsRefresh(args);
      break;
    case "set":
      await cmdAccountsSet(args);
      break;
    default:
      process.stderr.write("Usage: musebridge accounts list|add|remove|check|refresh|set\n");
      process.exit(1);
  }
}

async function cmdLogin() {
  if (listAccounts().length === 0) {
    await cmdAccountsAdd(["default"]);
    return;
  }
  const accountId = resolveAccountId(null);
  await withSession({ accountId, headless: false }, async (session) => {
    const ok = await session.waitForSignIn();
    if (listAccounts().some((a) => a.id === accountId)) {
      setStatus(accountId, ok ? "signed_in" : "signed_out");
    }
    if (!ok) {
      process.stderr.write("Timed out waiting for Muse sign-in.\n");
      process.exit(2);
    }
    await exportAccountCookies(session, accountId);
    process.stdout.write("Signed in.\n");
  });
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args[0] === "-h") {
    printHelp();
    return;
  }
  const command = args.shift();
  switch (command) {
    case "doctor":
      await cmdDoctor(args);
      break;
    case "chats":
      await cmdChats(args);
      break;
    case "history":
      await cmdHistory(args);
      break;
    case "send":
      await cmdSend(args);
      break;
    case "approve":
      await cmdApprove(args);
      break;
    case "accounts":
      await cmdAccounts(args);
      break;
    case "login":
      await cmdLogin();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

main(process.argv).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});

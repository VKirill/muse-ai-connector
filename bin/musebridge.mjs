#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { cookiesPath, loadCookies, saveCookies } from "../bridge/cookies.mjs";
import { updateJson } from "../bridge/json-file.mjs";
import { bridgeHome, profileDir } from "../bridge/paths.mjs";
import { loadAttachmentFromPath } from "../bridge/acp-prompt.mjs";
import { extractImages, imagePrompt, saveImages } from "../bridge/images.mjs";
import { openTransport, resolveTransport } from "../bridge/protocol/api.mjs";
import { chromeExecutable, openSession } from "../bridge/session.mjs";
import { addTarget, listTargets, removeTarget, syncAccount, syncAll, syncIfTargets } from "../bridge/sync.mjs";
import {
  autoLoginAccount,
  loadCredentialsFromEnvCatalog,
  parseCredentialLines,
  syncBbHubAccounts,
} from "../bridge/auto-login.mjs";
import { fetchAccountUsage } from "../bridge/usage.mjs";

const HELP = `Usage: musebridge <command>

Commands:
  doctor [--account <id>]   Check Chrome, the profile directory, and sign-in
  chats [--account <id>] [--transport api|browser] [--json]
                            List side chats
  history [--account <id>] [--transport api|browser] <chatId> [--json]
                            Show a chat transcript
  send [--account <id>] [--chat <id>] [--attach <path>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>
                            Send a message and print the reply
  image [--account <id>] [--format W:H] [--out dir] [--chat <id>] [--attach <path>] [--timeout <sec>] [--transport api|browser] [--json] <prompt>
                            Generate a picture (default output ./muse-images).
                            First call returns chatId; pass --chat <id> to keep
                            editing in the same chat (--format still prefixes).
                            --attach sends a local picture or file with the prompt.
  approve [--account <id>] --chat <id>
                            Answer pending approval cards (Always allow;
                            cards about money are left to you)
  accounts list [--json]    List Muse accounts
  accounts add <label>      Register an account and open a sign-in window
  accounts login <id>       Open a sign-in window for an existing account
  accounts auto-login [<id>] [--force] [--headed] [--max-parallel <n>] [--batch <file|->] [--json]
                            Sign in automatically via email + IMAP OTP (Env Catalog or --batch)
  accounts remove <id> [--purge]
                            Remove an account from the registry
  accounts check [<id>]     Refresh signed-in status
  accounts usage [<id>] [--json]
                            Show plan usage for every account or one account
  accounts refresh <id>     Export cookies from the signed-in Chrome profile
  accounts import [<id>] [--label <label>]
                            Import a cookies JSON array or an export object from stdin
  accounts export <id> --json
                            Print {id, label, cookies} on stdout (host RPC only)
  accounts set <id> --max-parallel <n>
                            Set how many chats the account serves at once (1..50)
  sync targets add <name>   Add an ssh host that receives refreshed cookies
  sync targets remove <name>
                            Remove an ssh sync target
  sync targets list         Show the ssh sync targets
  sync [--account <id>]     Push saved cookies to every sync target
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

function takeRepeatOption(args, name) {
  const values = [];
  for (;;) {
    const i = args.indexOf(name);
    if (i < 0) break;
    values.push(args[i + 1]);
    args.splice(i, 2);
  }
  return values.filter((v) => v != null && v !== "");
}

function loadAttachFlags(args) {
  const paths = takeRepeatOption(args, "--attach");
  try {
    return paths.map((p) => loadAttachmentFromPath(p));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function ensureRegistered(id, label) {
  if (listAccounts().some((a) => a.id === id)) return;
  updateJson(path.join(bridgeHome(), "accounts.json"), { version: 1, accounts: [] }, (current) => {
    const accounts = Array.isArray(current?.accounts) ? current.accounts : [];
    if (!accounts.some((a) => a && a.id === id)) {
      const at = new Date().toISOString();
      accounts.push({
        id,
        label,
        profileDir: profileDir(id),
        status: "unknown",
        createdAt: at,
        lastUsedAt: at,
        lastCheckedAt: at,
      });
    }
    return { version: 1, accounts };
  });
}

function printSyncLine(r) {
  process.stdout.write(r.ok ? `${r.name} ${r.account} ok\n` : `${r.name} ${r.account} failed: ${r.error}\n`);
}

async function pushAfterCookies(id) {
  try {
    for (const r of await syncIfTargets(id)) printSyncLine(r);
  } catch (err) {
    process.stderr.write(`Cookie sync failed: ${err.message}\n`);
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

function openFakeImageTransport() {
  const histPath = process.env.MUSE_BRIDGE_FAKE_HISTORY;
  const mediaPath = process.env.MUSE_BRIDGE_FAKE_MEDIA;
  const sentPath = process.env.MUSE_BRIDGE_FAKE_SENT;
  const history = histPath ? JSON.parse(fs.readFileSync(histPath, "utf8")) : { result: { chat_events: [] } };
  const bytes = mediaPath ? fs.readFileSync(mediaPath) : Buffer.from("WEBPFAKE");
  return {
    isSignedIn: async () => true,
    async send({ text, attachments }) {
      if (sentPath) {
        const rec = { text };
        if (attachments?.length) {
          rec.attachments = attachments.map((a) => ({
            type: a.type,
            mime_type: a.mime_type,
            filename: a.filename,
            bytes: Buffer.from(a.data_base64 ?? "", "base64").length,
          }));
        }
        fs.appendFileSync(sentPath, `${JSON.stringify(rec)}\n`);
      }
      return { chatId: "fake-image-chat", text: "Here it is.", chatEventSeq: 0, history };
    },
    async fetchMedia() {
      return bytes;
    },
    close: async () => {},
  };
}

async function cmdImage(args) {
  const asJson = takeFlag(args, "--json");
  const format = takeOption(args, "--format");
  const outDir = takeOption(args, "--out") || path.resolve("muse-images");
  const chatId = takeOption(args, "--chat");
  const timeoutSec = takeOption(args, "--timeout");
  const accountFlag = takeOption(args, "--account");
  const transport = takeOption(args, "--transport");
  const attachments = loadAttachFlags(args);
  const prompt = args.join(" ").trim();
  if (!prompt) {
    process.stderr.write(
      "Usage: musebridge image [--account <id>] [--format W:H] [--out dir] [--chat <id>] [--attach <path>] [--timeout <sec>] [--transport api|browser] [--json] <prompt>\n" +
        "  First call returns chatId; pass --chat <id> to keep editing in the same chat.\n",
    );
    process.exit(1);
  }
  let text;
  try {
    text = chatId && !format ? prompt : imagePrompt(prompt, format || undefined);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const timeoutMs = timeoutSec ? Math.max(1, Number(timeoutSec)) * 1000 : undefined;
  if (timeoutSec && !Number.isFinite(timeoutMs)) {
    process.stderr.write(`Bad --timeout value: ${timeoutSec}\n`);
    process.exit(1);
  }
  const accountId = accountFlag || pickAccount().id;
  const release = acquire(accountId, { owner: "musebridge-image" });
  try {
    touch(accountId);
    const run = async (session) => {
      await requireSignedIn(session, accountId);
      if (typeof session.fetchMedia !== "function") {
        process.stderr.write("Image download needs the API transport.\n");
        process.exit(1);
      }
      const result = await session.send({
        chatId: chatId || undefined,
        text,
        attachments: attachments.length ? attachments : undefined,
        timeoutMs,
      });
      const hist = result.history ?? (typeof session.historyRaw === "function" ? await session.historyRaw(result.chatId) : null);
      const images = hist ? extractImages(hist, { sinceSeq: result.chatEventSeq ?? 0 }) : [];
      if (images.length === 0) {
        process.stderr.write("Muse answered without a picture\n");
        process.exit(1);
      }
      const saved = await saveImages(session, images, outDir);
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify({
            chatId: result.chatId,
            text: result.text,
            images: saved.map((img) => ({
              path: img.path,
              width: img.width,
              height: img.height,
              mime: img.mime,
              label: img.label,
            })),
          })}\n`,
        );
        return;
      }
      for (const img of saved) process.stdout.write(`${img.path}\n`);
    };
    if (process.env.MUSE_BRIDGE_FAKE === "1") {
      const session = openFakeImageTransport();
      try {
        await run(session);
      } finally {
        await session.close();
      }
      return;
    }
    await withTransport({ accountId, transport, headless: true }, run);
  } finally {
    release();
  }
}

async function cmdSend(args) {
  const asJson = takeFlag(args, "--json");
  const headed = takeFlag(args, "--headed");
  const chatId = takeOption(args, "--chat");
  const timeoutSec = takeOption(args, "--timeout");
  const accountFlag = takeOption(args, "--account");
  const transport = takeOption(args, "--transport");
  const attachments = loadAttachFlags(args);
  const text = args.join(" ").trim();
  if (!text) {
    process.stderr.write("Usage: musebridge send [--account <id>] [--chat <id>] [--attach <path>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>\n");
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
    const run = async (session) => {
      await requireSignedIn(session, accountId);
      const result = await session.send({
        chatId: chatId || undefined,
        text,
        attachments: attachments.length ? attachments : undefined,
        timeoutMs,
        onDelta: asJson
          ? undefined
          : (suffix) => {
              process.stdout.write(suffix);
            },
      });
      if (!asJson) process.stdout.write("\n");
      else process.stdout.write(`${JSON.stringify({ chatId: result.chatId, messageId: result.messageId, text: result.text })}\n`);
    };
    if (process.env.MUSE_BRIDGE_FAKE === "1") {
      const session = openFakeImageTransport();
      try {
        await run(session);
      } finally {
        await session.close();
      }
      return;
    }
    await withTransport({ accountId, transport, headless: !headed }, run);
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
  await pushAfterCookies(account.id);
}

async function cmdAccountsLogin(args) {
  const id = args[0];
  if (!id) {
    process.stderr.write("Usage: musebridge accounts login <id>\n");
    process.exit(1);
  }
  if (!listAccounts().some((account) => account.id === id)) {
    process.stderr.write(`Unknown account: ${id}\n`);
    process.exit(2);
  }
  await withSession({ accountId: id, headless: false }, async (session) => {
    const ok = await session.waitForSignIn();
    setStatus(id, ok ? "signed_in" : "signed_out");
    if (!ok) {
      process.stderr.write("Timed out waiting for Muse sign-in.\n");
      process.exit(2);
    }
    await exportAccountCookies(session, id);
    process.stdout.write(`Signed in as ${id}.\n`);
  });
  await pushAfterCookies(id);
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

export async function cmdAccountsRefresh(args, deps = {}) {
  const id = args[0];
  if (!id) {
    process.stderr.write("Usage: musebridge accounts refresh <id>\n");
    process.exit(1);
  }
  const open = deps.openSession ?? openSession;
  const session = await open({ accountId: id, headless: true });
  try {
    await requireSignedIn(session, id);
    await exportAccountCookies(session, id);
    process.stdout.write(`Refreshed cookies for ${id}.\n`);
  } finally {
    await session.close();
  }
  await pushAfterCookies(id);
}

async function cmdAccountsExport(args) {
  const asJson = takeFlag(args, "--json");
  const id = args[0];
  if (!id || !asJson) {
    process.stderr.write("Usage: musebridge accounts export <id> --json\n");
    process.exit(1);
  }
  const account = listAccounts().find((a) => a.id === id);
  if (!account) {
    process.stderr.write(`Unknown account: ${id}\n`);
    process.exit(1);
  }
  let cookies;
  try {
    cookies = loadCookies(id);
  } catch {
    process.stderr.write(`No cookies for ${id}\n`);
    process.exit(1);
  }
  const out = { id: account.id, label: account.label, cookies };
  if (Number.isInteger(account.maxParallel) && account.maxParallel >= 1) {
    out.maxParallel = account.maxParallel;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function cmdAccountsImport(args) {
  let label = takeOption(args, "--label");
  if (process.stdin.isTTY) {
    process.stderr.write("Expected a cookies JSON array on stdin.\n");
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = null;
  }
  let id = args[0];
  let cookies = payload;
  let maxParallel;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray(payload.cookies)) {
    cookies = payload.cookies;
    id = id ?? (typeof payload.id === "string" ? payload.id : undefined);
    label = label ?? (typeof payload.label === "string" ? payload.label : undefined);
    maxParallel = payload.maxParallel;
  }
  if (!id) {
    process.stderr.write("Usage: musebridge accounts import <id> [--label <label>]\n");
    process.exit(1);
  }
  if (!Array.isArray(cookies) || cookies.some((c) => !c || typeof c.name !== "string" || !("value" in c))) {
    process.stderr.write("Invalid cookies JSON on stdin: expected an array of {name, value, ...} objects.\n");
    process.exit(1);
  }
  saveCookies(id, cookies);
  ensureRegistered(id, label ?? id);
  if (maxParallel !== undefined) setMaxParallel(id, maxParallel);
  setStatus(id, "signed_in");
  process.stdout.write(`imported ${cookies.length} cookies for ${id}\n`);
}

function usageLine(row) {
  if (!row.usage) return `${row.id}\t${row.error?.message ?? "usage unavailable"}`;
  const u = row.usage;
  const parts = [u.plan ?? "unknown plan"];
  parts.push(u.percentUsed == null ? "unlimited" : `${u.percentUsed}% used`);
  if (u.periodLabel) parts.push(u.periodLabel);
  if (u.extraTokensLeftLabel) parts.push(`extra ${u.extraTokensLeftLabel}`);
  return `${row.id}\t${parts.join(" · ")}`;
}

export async function cmdAccountsUsage(args, deps = {}) {
  const asJson = takeFlag(args, "--json");
  const id = args[0];
  const readUsage = deps.fetchAccountUsage ?? fetchAccountUsage;
  const accounts = listAccounts();
  const targets = id ? accounts.filter((a) => a.id === id) : accounts;
  if (id && targets.length === 0) {
    process.stderr.write(`Unknown account: ${id}\n`);
    process.exit(1);
  }
  const rows = [];
  for (const account of targets) {
    const row = { id: account.id, label: account.label, status: account.status, usage: null, error: null };
    try {
      row.usage = await readUsage({ accountId: account.id });
    } catch (err) {
      row.error = { code: err?.code ?? "usage_unavailable", message: String(err?.message ?? err) };
    }
    rows.push(row);
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ accounts: rows }, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${usageLine(row)}\n`);
  }
}

async function cmdSyncTargets(args) {
  const sub = args.shift();
  switch (sub) {
    case "add": {
      const name = args[0];
      if (!name) {
        process.stderr.write("Usage: musebridge sync targets add <name>\n");
        process.exit(1);
      }
      addTarget(name);
      process.stdout.write(`added sync target ${name}\n`);
      break;
    }
    case "remove": {
      const name = args[0];
      if (!name) {
        process.stderr.write("Usage: musebridge sync targets remove <name>\n");
        process.exit(1);
      }
      if (!listTargets().some((t) => t.name === name)) {
        process.stderr.write(`Unknown sync target: ${name}\n`);
        process.exit(1);
      }
      removeTarget(name);
      process.stdout.write(`removed sync target ${name}\n`);
      break;
    }
    case "list": {
      const targets = listTargets();
      if (targets.length === 0) {
        process.stdout.write("No sync targets.\n");
        break;
      }
      for (const t of targets) process.stdout.write(`${t.name}\n`);
      break;
    }
    default:
      process.stderr.write("Usage: musebridge sync targets add|remove|list <name>\n");
      process.exit(1);
  }
}

async function cmdSync(args) {
  if (args[0] === "targets") {
    await cmdSyncTargets(args.slice(1));
    return;
  }
  const accountFlag = takeOption(args, "--account");
  if (listTargets().length === 0) {
    process.stderr.write("No sync targets. Run: musebridge sync targets add <name>\n");
    process.exit(1);
  }
  let results;
  if (accountFlag) {
    if (!fs.existsSync(cookiesPath(accountFlag))) {
      process.stderr.write(`No cookies for ${accountFlag}\n`);
      process.exit(1);
    }
    results = (await syncAccount(accountFlag)).map((r) => ({ account: accountFlag, ...r }));
  } else {
    results = await syncAll();
  }
  if (results.length === 0) {
    process.stdout.write("Nothing to sync: no signed-in accounts with cookies.\n");
    return;
  }
  let ok = 0;
  for (const r of results) {
    printSyncLine(r);
    if (r.ok) ok += 1;
  }
  if (ok === 0) process.exit(1);
}

export async function cmdAccountsAutoLogin(args, deps = {}) {
  const asJson = takeFlag(args, "--json");
  const force = takeFlag(args, "--force");
  const headed = takeFlag(args, "--headed");
  const passwordStdin = takeFlag(args, "--password-stdin");
  const batchSource = takeOption(args, "--batch");
  const emailOpt = takeOption(args, "--email");
  const imapHostOpt = takeOption(args, "--imap-host");
  const maxParallelRaw = takeOption(args, "--max-parallel");
  const idArg = args[0] ?? null;

  let maxParallel;
  if (maxParallelRaw !== null) {
    maxParallel = Number(maxParallelRaw);
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 50) {
      process.stderr.write(`Bad --max-parallel value: ${maxParallelRaw} (expected an integer 1..50)\n`);
      process.exit(1);
    }
  }

  const runOne = deps.autoLoginAccount ?? autoLoginAccount;
  const loadCatalog = deps.loadCredentialsFromEnvCatalog ?? loadCredentialsFromEnvCatalog;
  const hubSync = deps.syncBbHubAccounts ?? syncBbHubAccounts;

  /** @type {Array<{ accountId?: string, email: string, password: string, imapHost?: string }>} */
  const jobs = [];

  if (batchSource) {
    const raw = batchSource === "-" ? await readStdin() : fs.readFileSync(batchSource, "utf8");
    for (const item of parseCredentialLines(raw)) {
      jobs.push({
        email: item.email,
        password: item.password,
        imapHost: imapHostOpt || item.imapHost,
      });
    }
    if (jobs.length === 0) {
      process.stderr.write("No valid `<email> <password>` lines found in --batch input.\n");
      process.exit(1);
    }
  } else if (emailOpt) {
    const password = passwordStdin ? (await readStdin()).trim() : String(process.env.MUSE_IMAP_PASSWORD ?? "").trim();
    if (!password) {
      process.stderr.write("Pass --password-stdin or set MUSE_IMAP_PASSWORD with --email.\n");
      process.exit(1);
    }
    jobs.push({ accountId: idArg ?? undefined, email: emailOpt, password, imapHost: imapHostOpt ?? undefined });
  } else {
    const all = listAccounts();
    if (idArg) {
      const targets = all.filter((a) => a.id === idArg || a.label.toLowerCase() === idArg.toLowerCase());
      if (targets.length === 0) {
        process.stderr.write(`Unknown account: ${idArg}\n`);
        process.exit(1);
      }
      const catalog = await loadCatalog(targets.map((a) => a.label));
      for (const acc of targets) {
        const cred = catalog.get(acc.label.trim().toLowerCase());
        jobs.push({
          accountId: acc.id,
          email: cred?.email ?? acc.label,
          password: cred?.password ?? "",
          imapHost: imapHostOpt || cred?.imapHost,
        });
      }
    } else {
      const emailAccounts = all.filter((a) => a.label.includes("@"));
      const catalog = await loadCatalog(
        emailAccounts.map((a) => a.label),
        { includeTaggedMuse: true },
      );
      const knownEmails = new Set(emailAccounts.map((a) => a.label.trim().toLowerCase()));
      for (const acc of emailAccounts) {
        if (!force && acc.status === "signed_in") continue;
        const cred = catalog.get(acc.label.trim().toLowerCase());
        jobs.push({
          accountId: acc.id,
          email: cred?.email ?? acc.label,
          password: cred?.password ?? "",
          imapHost: imapHostOpt || cred?.imapHost,
        });
      }
      for (const [key, cred] of catalog.entries()) {
        if (knownEmails.has(key)) continue;
        jobs.push({
          email: cred.email,
          password: cred.password,
          imapHost: imapHostOpt || cred.imapHost,
        });
      }
      if (jobs.length === 0) {
        if (asJson) process.stdout.write(`${JSON.stringify({ accounts: [], syncedHub: false }, null, 2)}\n`);
        else process.stdout.write("All email accounts are already signed in (use --force to re-login).\n");
        return;
      }
    }
  }

  const results = [];
  let failed = 0;
  for (const job of jobs) {
    if (!job.password) {
      failed += 1;
      const errMsg = `No mailbox password in Env Catalog for ${job.email}`;
      results.push({ id: job.accountId ?? null, email: job.email, ok: false, error: errMsg });
      if (!asJson) process.stderr.write(`${job.accountId ?? job.email}\tfailed: ${errMsg}\n`);
      continue;
    }
    try {
      const r = await runOne({
        accountId: job.accountId,
        email: job.email,
        password: job.password,
        imapHost: job.imapHost,
        maxParallel,
        headless: !headed,
        force,
      });
      results.push({ id: r.id, email: r.email, ok: true, status: r.status, cookiesCount: r.cookiesCount });
      if (!asJson) process.stdout.write(`${r.id}\t${r.status}\t${r.cookiesCount} cookies\n`);
    } catch (err) {
      failed += 1;
      const msg = String(err?.message ?? err);
      results.push({ id: job.accountId ?? null, email: job.email, ok: false, error: msg });
      if (!asJson) process.stderr.write(`${job.accountId ?? job.email}\tfailed: ${msg}\n`);
    }
  }

  let syncedHub = false;
  if (results.some((r) => r.ok)) {
    const hubRes = await hubSync();
    syncedHub = Boolean(hubRes);
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ accounts: results, syncedHub }, null, 2)}\n`);
  }
  if (failed > 0) process.exit(1);
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
    case "login":
      await cmdAccountsLogin(args);
      break;
    case "auto-login":
      await cmdAccountsAutoLogin(args);
      break;
    case "remove":
      await cmdAccountsRemove(args);
      break;
    case "check":
      await cmdAccountsCheck(args);
      break;
    case "usage":
      await cmdAccountsUsage(args);
      break;
    case "refresh":
      await cmdAccountsRefresh(args);
      break;
    case "set":
      await cmdAccountsSet(args);
      break;
    case "import":
      await cmdAccountsImport(args);
      break;
    case "export":
      await cmdAccountsExport(args);
      break;
    default:
      process.stderr.write("Usage: musebridge accounts list|add|login|auto-login|remove|check|usage|refresh|set|import|export\n");
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
    case "image":
      await cmdImage(args);
      break;
    case "approve":
      await cmdApprove(args);
      break;
    case "accounts":
      await cmdAccounts(args);
      break;
    case "sync":
      await cmdSync(args);
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

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

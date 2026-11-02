#!/usr/bin/env node
import fs from "node:fs";
import { chromeExecutable, openSession } from "../bridge/session.mjs";
import { profileDir } from "../bridge/paths.mjs";

const HELP = `Usage: musebridge <command>

Commands:
  doctor                 Check Chrome, the profile directory, and sign-in
  chats [--json]         List side chats
  history <chatId> [--json]
                         Show a chat transcript
  send [--chat <id>] [--headed] [--json] <text>
                         Send a message and print the reply
  login                  Open a headed Chrome window and wait for sign-in
  --help                 Show this help
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

async function withSession(opts, fn) {
  const session = await openSession(opts);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function requireSignedIn(session) {
  const ok = await session.isSignedIn();
  if (!ok) {
    process.stderr.write("Not signed in to Muse. Run: musebridge login\n");
    process.exit(2);
  }
}

async function cmdDoctor() {
  const chrome = chromeExecutable();
  const profile = profileDir("default");
  const profileExists = fs.existsSync(profile);
  process.stdout.write(`Chrome: ${chrome ? `found (${chrome})` : "not found"}\n`);
  process.stdout.write(`Profile: ${profileExists ? `exists (${profile})` : `missing (${profile})`}\n`);
  if (!chrome) {
    process.stderr.write("Google Chrome is required (channel chrome).\n");
    process.exit(1);
  }
  await withSession({ accountId: "default", headless: true }, async (session) => {
    const signedIn = await session.isSignedIn();
    process.stdout.write(`Signed in: ${signedIn ? "yes" : "no"}\n`);
    if (!signedIn) process.exit(2);
  });
}

async function cmdChats(args) {
  const asJson = takeFlag(args, "--json");
  await withSession({ accountId: "default", headless: true }, async (session) => {
    await requireSignedIn(session);
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
  const chatId = args[0];
  if (!chatId) {
    process.stderr.write("Usage: musebridge history <chatId> [--json]\n");
    process.exit(1);
  }
  await withSession({ accountId: "default", headless: true }, async (session) => {
    await requireSignedIn(session);
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
  const text = args.join(" ").trim();
  if (!text) {
    process.stderr.write("Usage: musebridge send [--chat <id>] [--headed] [--json] <text>\n");
    process.exit(1);
  }
  await withSession({ accountId: "default", headless: !headed }, async (session) => {
    await requireSignedIn(session);
    const result = await session.send({
      chatId: chatId || undefined,
      text,
      onDelta: asJson
        ? undefined
        : (suffix) => {
            process.stdout.write(suffix);
          },
    });
    if (!asJson) process.stdout.write("\n");
    else process.stdout.write(`${JSON.stringify({ chatId: result.chatId, messageId: result.messageId, text: result.text })}\n`);
  });
}

async function cmdLogin() {
  await withSession({ accountId: "default", headless: false }, async (session) => {
    const ok = await session.waitForSignIn();
    if (!ok) {
      process.stderr.write("Timed out waiting for Muse sign-in.\n");
      process.exit(2);
    }
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
      await cmdDoctor();
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

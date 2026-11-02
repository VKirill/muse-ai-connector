import fs from "node:fs";
import { chromium } from "playwright-core";
import { findUserMessage, parseChatList, parseTranscript, replyState } from "./cache.mjs";
import { profileDir } from "./paths.mjs";

const MUSE_ORIGIN = "https://muse.ai";
const SIGN_IN_MS = 15_000;
const LOGIN_WAIT_MS = 10 * 60_000;
const POLL_MS = 500;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
];

/** @returns {string | null} */
export function chromeExecutable() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replyTimeoutError() {
  const err = new Error("Timed out waiting for Muse reply");
  err.code = "reply_timeout";
  return err;
}

/**
 * @param {import("playwright-core").Page} page
 * @param {string} storeName
 */
async function readCacheStore(page, storeName) {
  return page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("hatch-chat-cache");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!db.objectStoreNames.contains(name)) return [];
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(name, "readonly");
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, storeName);
}

/**
 * @param {import("playwright-core").Page} page
 * @param {number} timeoutMs
 */
async function waitSignedInSignals(page, timeoutMs) {
  try {
    await Promise.any([
      page.locator("[data-testid=hatch-nav-chat]").waitFor({ timeout: timeoutMs }),
      page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: timeoutMs }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import("playwright-core").Page} page
 */
async function pageIsBusy(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  return text.includes("is working");
}

/**
 * @param {import("playwright-core").Page} page
 * @param {string} chatId
 */
async function readTranscriptRecord(page, chatId) {
  const rows = await readCacheStore(page, "side-transcripts");
  return rows.find((row) => row.sessionId === chatId) ?? null;
}

/**
 * @param {import("playwright-core").Page} page
 */
async function readChatListRecord(page) {
  const rows = await readCacheStore(page, "side-chat-lists");
  if (rows.length === 0) return { sessions: [] };
  return rows.reduce((best, row) => ((row.cachedAtMs ?? 0) > (best.cachedAtMs ?? 0) ? row : best));
}

/**
 * @param {object} opts
 * @param {string} [opts.accountId]
 * @param {boolean} [opts.headless]
 */
export async function openSession({ accountId = "default", headless = true } = {}) {
  const userDataDir = profileDir(accountId);
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  async function isSignedIn() {
    await page.goto(`${MUSE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    return waitSignedInSignals(page, SIGN_IN_MS);
  }

  async function waitForSignIn(timeoutMs = LOGIN_WAIT_MS) {
    await page.goto(`${MUSE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    if (await waitSignedInSignals(page, Math.min(SIGN_IN_MS, timeoutMs))) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await waitSignedInSignals(page, POLL_MS * 4)) return true;
    }
    return false;
  }

  async function listChats() {
    await page.goto(`${MUSE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitSignedInSignals(page, SIGN_IN_MS);
    const record = await readChatListRecord(page);
    return parseChatList(record);
  }

  async function history(chatId) {
    await page.goto(`${MUSE_ORIGIN}/thread/${chatId}`, { waitUntil: "domcontentloaded" });
    await waitSignedInSignals(page, SIGN_IN_MS);
    const record = await readTranscriptRecord(page, chatId);
    if (!record) return { chatId, revision: null, hasMore: false, messages: [] };
    return parseTranscript(record);
  }

  /**
   * @param {{ chatId?: string, text: string, onDelta?: (suffix: string) => void, timeoutMs?: number }} input
   */
  async function send({ chatId, text, onDelta, timeoutMs = 180_000 }) {
    const target = chatId ? `${MUSE_ORIGIN}/thread/${chatId}` : `${MUSE_ORIGIN}/thread/new`;
    await page.goto(target, { waitUntil: "domcontentloaded" });
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: SIGN_IN_MS });
    await box.click();
    const sentAfterIso = new Date().toISOString();
    await page.keyboard.insertText(text);
    await page.keyboard.press("Enter");

    let resolvedChatId = chatId ?? null;
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let userMessageId = null;

    while (Date.now() < deadline) {
      if (!resolvedChatId) {
        const match = page.url().match(/\/thread\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (match) resolvedChatId = match[1];
      }
      const busy = await pageIsBusy(page);
      let messages = [];
      if (resolvedChatId) {
        const record = await readTranscriptRecord(page, resolvedChatId);
        if (record) messages = parseTranscript(record).messages;
      }
      if (!userMessageId) {
        const user = findUserMessage(messages, text, sentAfterIso) ?? findUserMessage(messages, text);
        if (user) userMessageId = user.id;
      }
      const state = userMessageId
        ? replyState(messages, userMessageId, busy)
        : { state: "pending", text: "" };
      if (state.text.length > lastText.length) {
        const suffix = state.text.slice(lastText.length);
        lastText = state.text;
        onDelta?.(suffix);
      }
      if (state.state === "done" && resolvedChatId && userMessageId) {
        let messageId = null;
        const userIndex = messages.findIndex((m) => m.id === userMessageId);
        for (let i = userIndex + 1; i < messages.length; i++) {
          if (messages[i].role === "user") break;
          if (messages[i].role === "assistant") messageId = messages[i].id;
        }
        return { chatId: resolvedChatId, messageId, text: state.text };
      }
      await sleep(POLL_MS);
    }
    throw replyTimeoutError();
  }

  async function close() {
    await context.close();
  }

  return { isSignedIn, waitForSignIn, listChats, history, send, close };
}

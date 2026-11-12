import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { addAccount, listAccounts, setMaxParallel, setStatus } from "./accounts.mjs";
import { saveCookies } from "./cookies.mjs";
import { profileDir } from "./paths.mjs";
import { COMPOSER_SELECTOR, launchOptions } from "./session.mjs";
import { syncIfTargets } from "./sync.mjs";

const execFileP = promisify(execFile);

const MUSE_ORIGIN = "https://muse.ai";
const IMAP_TIMEOUT_MS = 15_000;
const OTP_POLL_MS = 2_000;
const DEFAULT_OTP_TIMEOUT_MS = 90_000;
const DEFAULT_STEP_TIMEOUT_MS = 35_000;

const IMAP_HOST_MAP = {
  "mail.com": "imap.mail.com",
  "email.com": "imap.mail.com",
  "gmx.com": "imap.gmx.com",
  "gmx.net": "imap.gmx.net",
  "gmail.com": "imap.gmail.com",
  "googlemail.com": "imap.gmail.com",
  "yandex.ru": "imap.yandex.ru",
  "yandex.com": "imap.yandex.com",
  "ya.ru": "imap.yandex.ru",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "live.com": "outlook.office365.com",
  "yahoo.com": "imap.mail.yahoo.com",
  "icloud.com": "imap.mail.me.com",
  "me.com": "imap.mail.me.com",
  "purelymail.com": "imap.purelymail.com",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Resolve an IMAP hostname from a mailbox hint ("mail.com", "imap.mail.com") or email address.
 * @param {string} [mailboxOrEmail]
 * @param {string} [fallbackEmail]
 * @returns {string}
 */
export function resolveImapHost(mailboxOrEmail, fallbackEmail = "") {
  const raw = String(mailboxOrEmail || "").trim().toLowerCase();
  const domainFromEmail = String(fallbackEmail || "").includes("@")
    ? String(fallbackEmail).trim().toLowerCase().split("@").pop()
    : "";
  const candidate = raw.includes("@") ? raw.split("@").pop() : raw || domainFromEmail;
  if (!candidate) throw codedError("missing_imap_host", "Cannot determine IMAP host");
  if (candidate.startsWith("imap.") || candidate.startsWith("mail.") || candidate.includes(".office365.")) {
    return IMAP_HOST_MAP[candidate] ?? candidate;
  }
  return IMAP_HOST_MAP[candidate] ?? `imap.${candidate}`;
}

/**
 * Parse batch credential lines such as:
 *   `user@mail.com MyPass123 mailbox: mail.com`
 *   `user@mail.com MyPass123`
 * Skips blank lines and `#` or `--` comments.
 * @param {string} text
 * @returns {Array<{ email: string, password: string, imapHost: string }>}
 */
export function parseCredentialLines(text) {
  const out = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("--")) continue;
    const mailboxMatch = line.match(/\bmailbox:\s*([^\s]+)/i);
    const stripped = mailboxMatch ? line.slice(0, mailboxMatch.index).trim() : line;
    const parts = stripped.split(/\s+/);
    if (parts.length < 2 || !parts[0].includes("@")) continue;
    const email = parts[0].trim();
    const password = parts[1].trim();
    const mailboxHint = mailboxMatch?.[1] ?? parts[2] ?? "";
    out.push({
      email,
      password,
      imapHost: resolveImapHost(mailboxHint, email),
    });
  }
  return out;
}

/**
 * Extract a 6-8 digit Meta/Muse login OTP code from a raw IMAP FETCH response.
 * Checks messages from newest to oldest and ignores UIDs below `minUid`.
 * @param {string} rawImap
 * @param {number} minUid
 * @returns {{ maxUid: number, code: string | null }}
 */
export function extractOtpFromImapFetch(rawImap, minUid = 1) {
  const unfolded = String(rawImap ?? "")
    .replace(/=\r?\n/g, "")
    .replace(/=3D/gi, "=");
  const blocks = unfolded.split(/\*\s+\d+\s+FETCH\s*\(/i).slice(1).reverse();
  let foundCode = null;
  let maxUid = Math.max(0, minUid - 1);
  for (const block of blocks) {
    const uidMatch = block.match(/\bUID\s+(\d+)/i);
    const uid = uidMatch ? Number(uidMatch[1]) : 0;
    if (uid > maxUid) maxUid = uid;
    if (uid < minUid) continue;
    const plain = block
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|=C2=A0/gi, " ");
    const match =
      block.match(/Subject:[^\r\n]*?\b(\d{6,8})\b/i) ||
      plain.match(/(?:Login|confirmation|security|confirm|sign[\s-]?up|verification)\s+code[\s:]*?(\d{6,8})\b/i);
    if (match && !foundCode) foundCode = match[1];
  }
  return { maxUid, code: foundCode };
}

function imapQuote(value) {
  return `"${String(value).replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Query IMAP over TLS (port 993). When `minUid <= 0`, returns `{ maxUid, code: null }`
 * from `SELECT INBOX` (`UIDNEXT - 1`). When `minUid >= 1`, fetches messages `minUid:*`.
 * @param {{ host: string, port?: number, user: string, password: string, minUid?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ maxUid: number, code: string | null }>}
 */
export function queryImapOtp({ host, port = 993, user, password, minUid = 0, timeoutMs = IMAP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(port, host, { servername: host });
    sock.setEncoding("utf8");
    let buf = "";
    let step = 0;
    let settled = false;

    const finish = (value, isErr = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      if (isErr) reject(value);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(codedError("imap_timeout", `IMAP timed out connecting to ${host}:${port}`), true);
    }, timeoutMs);

    sock.on("error", (err) => finish(err, true));
    sock.on("data", (chunk) => {
      if (settled) return;
      buf += chunk;
      if (step === 0 && buf.includes("* OK")) {
        step = 1;
        buf = "";
        sock.write(`a1 LOGIN ${imapQuote(user)} ${imapQuote(password)}\r\n`);
      } else if (step === 1 && /(?:^|\r?\n)a1 (OK|NO|BAD)\b/i.test(buf)) {
        if (!/(?:^|\r?\n)a1 OK\b/i.test(buf)) {
          finish(codedError("imap_auth_failed", `IMAP authentication failed for ${user} on ${host}`), true);
          return;
        }
        step = 2;
        buf = "";
        sock.write("a2 SELECT INBOX\r\n");
      } else if (step === 2 && /(?:^|\r?\n)a2 (OK|NO|BAD)\b/i.test(buf)) {
        if (!/(?:^|\r?\n)a2 OK\b/i.test(buf)) {
          finish(codedError("imap_select_failed", `IMAP SELECT INBOX failed for ${user}`), true);
          return;
        }
        const uidNextMatch = buf.match(/UIDNEXT\s+(\d+)/i);
        const existsMatch = buf.match(/\*\s+(\d+)\s+EXISTS/i);
        const uidNext = uidNextMatch ? Number(uidNextMatch[1]) : 1;
        const exists = existsMatch ? Number(existsMatch[1]) : 0;
        if (minUid <= 0 || exists === 0 || uidNext <= minUid) {
          step = 4;
          try {
            sock.write("a4 LOGOUT\r\n");
          } catch {
            /* ignore */
          }
          finish({ maxUid: Math.max(0, uidNext - 1), code: null });
          return;
        }
        step = 3;
        buf = "";
        sock.write(`a3 UID FETCH ${minUid}:* (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])\r\n`);
      } else if (step === 3 && /(?:^|\r?\n)a3 (OK|NO|BAD)\b/i.test(buf)) {
        const parsed = extractOtpFromImapFetch(buf, minUid);
        step = 4;
        try {
          sock.write("a4 LOGOUT\r\n");
        } catch {
          /* ignore */
        }
        finish(parsed);
      }
    });
  });
}

/**
 * Poll IMAP until a new OTP message (`UID >= minUid`) arrives.
 */
export async function waitForImapOtp({
  host,
  port = 993,
  user,
  password,
  minUid,
  timeoutMs = DEFAULT_OTP_TIMEOUT_MS,
  pollMs = OTP_POLL_MS,
  query = queryImapOtp,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await query({ host, port, user, password, minUid });
    if (res.code) return res.code;
    await sleep(pollMs);
  }
  throw codedError("otp_timeout", `Timed out waiting for Muse login code in ${user} (${host})`);
}

/**
 * Resolve login credentials from BB Env Catalog (`bb env-catalog`) for a list of emails,
 * optionally also discovering any `login` entries tagged `"muse"` or named `MUSE_MAIL_*`.
 * Passwords remain in memory only and are never logged.
 * @param {string[]} emails
 * @param {{ exec?: Function, includeTaggedMuse?: boolean }} [opts]
 * @returns {Promise<Map<string, { email: string, password: string, imapHost: string }>>}
 */
export async function loadCredentialsFromEnvCatalog(emails, { exec = execFileP, includeTaggedMuse = false } = {}) {
  const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const map = new Map();
  if (wanted.size === 0 && !includeTaggedMuse) return map;

  let listedRaw;
  try {
    const { stdout } = await exec("bb", ["env-catalog", "list", "--kind", "login", "--json"], { encoding: "utf8" });
    listedRaw = JSON.parse(stdout);
  } catch {
    return map;
  }

  const variables = Array.isArray(listedRaw)
    ? listedRaw
    : Array.isArray(listedRaw?.variables)
      ? listedRaw.variables
      : [];
  for (const entry of variables) {
    if (!entry?.name) continue;
    const summary = String(entry?.maskedValue ?? entry?.summary ?? "").toLowerCase();
    const summaryEmail = summary.includes("@http") ? summary.split("@http")[0] : summary;
    const isMuseTagged =
      includeTaggedMuse &&
      (String(entry.name).startsWith("MUSE_MAIL_") ||
        (Array.isArray(entry.tags) && entry.tags.some((t) => String(t).toLowerCase() === "muse")));
    const matchedEmail = [...wanted].find((email) => summary.startsWith(`${email}@`) || summary === email) ?? (isMuseTagged && summaryEmail.includes("@") ? summaryEmail : null);
    if (!matchedEmail || map.has(matchedEmail)) continue;
    try {
      const { stdout } = await exec("bb", ["env-catalog", "get", String(entry.name), "--json"], { encoding: "utf8" });
      const detail = JSON.parse(stdout);
      const access = detail?.access ?? detail;
      const username = String(access?.username ?? matchedEmail).trim();
      const key = username.toLowerCase();
      const password = String(access?.password ?? "");
      if (!password || map.has(key)) continue;
      map.set(key, {
        email: username,
        password,
        imapHost: resolveImapHost(access?.host || entry?.service || "", username),
      });
    } catch {
      /* skip unreadable entry */
    }
  }
  return map;
}

function deriveProfileName(email) {
  const local = String(email || "").split("@")[0].replace(/\d+/g, "").trim();
  const parts = local.split(/[._-]+/).filter(Boolean);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
  const firstName = cap(parts[0]) || "Alex";
  const lastName = cap(parts[1]) || "Taylor";
  return { firstName, lastName };
}

async function inspectPageState(page) {
  try {
    return await page.evaluate((composerSel) => {
      const signedIn =
        Boolean(document.querySelector("[data-testid=hatch-nav-chat]")) ||
        Boolean(document.querySelector(composerSel));
      const url = location.href;
      const title = document.title || "";
      const text = signedIn ? "" : (document.body?.innerText || "").slice(0, 2500);
      const iframes = signedIn ? [] : [...document.querySelectorAll("iframe")].map((f) => f.src || "");
      const hay = `${url}\n${title}\n${text}\n${iframes.join("\n")}`.toLowerCase();
      const captcha = !signedIn && /captcha|recaptcha|hcaptcha|turnstile|arkose|funcaptcha|verify you are human/i.test(hay);
      return { signedIn, url, title, text, captcha };
    }, COMPOSER_SELECTOR);
  } catch {
    return { signedIn: false, url: "", title: "", text: "", captcha: false };
  }
}

function ensureAccountForEmail(email, { maxParallel, defaultNewMaxParallel = 20 } = {}) {
  const lower = email.trim().toLowerCase();
  const existing = listAccounts().find(
    (a) => a.label.trim().toLowerCase() === lower || a.id === lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
  );
  if (existing) {
    if (Number.isInteger(maxParallel) && maxParallel >= 1) setMaxParallel(existing.id, maxParallel);
    return existing;
  }
  const created = addAccount(email.trim());
  const targetMax = Number.isInteger(maxParallel) && maxParallel >= 1 ? maxParallel : defaultNewMaxParallel;
  if (Number.isInteger(targetMax) && targetMax >= 1) setMaxParallel(created.id, targetMax);
  return listAccounts().find((a) => a.id === created.id) ?? created;
}

/**
 * Sign in one Muse account automatically using Chrome persistent profile + IMAP OTP.
 *
 * @param {object} opts
 * @param {string} [opts.accountId]
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} [opts.imapHost]
 * @param {number} [opts.maxParallel]
 * @param {boolean} [opts.headless]
 * @param {boolean} [opts.force]
 * @param {number} [opts.otpTimeoutMs]
 * @param {object} [opts.deps]
 */
export async function autoLoginAccount({
  accountId,
  email,
  password,
  imapHost,
  maxParallel,
  headless = true,
  force = false,
  otpTimeoutMs = DEFAULT_OTP_TIMEOUT_MS,
  deps = {},
}) {
  if (!email || !email.includes("@")) throw codedError("invalid_email", `Valid email is required, got: ${email}`);
  if (!password) throw codedError("missing_password", `Mailbox password is required for ${email}`);

  const resolvedImapHost = imapHost ? resolveImapHost(imapHost, email) : resolveImapHost("", email);
  const account = accountId
    ? (listAccounts().find((a) => a.id === accountId) ?? ensureAccountForEmail(email, { maxParallel }))
    : ensureAccountForEmail(email, { maxParallel });

  const queryOtp = deps.queryImapOtp ?? queryImapOtp;
  const launch =
    deps.launchPersistentContext ??
    ((dir, opts) => chromium.launchPersistentContext(dir, opts));
  const syncTargetsFn = deps.syncIfTargets ?? syncIfTargets;

  // Verify IMAP credentials up front and snapshot current max UID before triggering Meta's email.
  const preImap = await queryOtp({
    host: resolvedImapHost,
    user: email,
    password,
    minUid: 0,
  });

  const dir = profileDir(account.id);
  fs.mkdirSync(dir, { recursive: true });
  const context = await launch(dir, launchOptions({ headless }));

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${MUSE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await sleep(2500);

    let state = await inspectPageState(page);
    if (state.captcha) {
      throw codedError("captcha_blocked", `CAPTCHA / human verification encountered for ${email}; stopping.`);
    }
    if (state.signedIn && !force) {
      const cookies = await context.cookies(["https://muse.ai", "https://auth.meta.com"]);
      saveCookies(account.id, cookies);
      setStatus(account.id, "signed_in");
      await syncTargetsFn(account.id);
      return { id: account.id, email, status: "already_signed_in", cookiesCount: cookies.length };
    }

    // Drive landing -> OTP input screen
    const codeSelector =
      'input[aria-label*="security code" i], input[aria-label*="code" i], input[autocomplete="one-time-code"], input[maxlength="6"]';
    const emailSelector =
      'input[type="email"], input[placeholder*="email" i], input[aria-label*="email" i], input[name*="email" i]';

    let emailSubmitted = false;
    let savedCardClicked = false;
    const stepDeadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS;

    while (Date.now() < stepDeadline) {
      state = await inspectPageState(page);
      if (state.captcha) {
        throw codedError("captcha_blocked", `CAPTCHA / human verification encountered for ${email}; stopping.`);
      }
      if (state.signedIn && !force) {
        const cookies = await context.cookies(["https://muse.ai", "https://auth.meta.com"]);
        saveCookies(account.id, cookies);
        setStatus(account.id, "signed_in");
        await syncTargetsFn(account.id);
        return { id: account.id, email, status: "signed_in", cookiesCount: cookies.length };
      }

      const codeInput = page.locator(codeSelector).first();
      if ((await codeInput.count()) > 0) break;

      if (!savedCardClicked && !emailSubmitted) {
        const metaCard = page.locator("button, [role=button]").filter({ hasText: /Meta Account/i }).first();
        if ((await metaCard.count()) > 0) {
          const cardText = (await metaCard.innerText().catch(() => "")).trim().toLowerCase();
          const firstChar = email.trim()[0].toLowerCase();
          if (cardText.startsWith(`${firstChar}*`)) {
            savedCardClicked = true;
            await metaCard.click();
            await sleep(2000);
            continue;
          }
          const useAnother = page.locator("button, [role=button]").filter({ hasText: /Use another account/i }).first();
          if ((await useAnother.count()) > 0) {
            savedCardClicked = true;
            await useAnother.click();
            await sleep(1500);
            continue;
          }
        }
      }

      const emailInput = page.locator(emailSelector).first();
      if (!emailSubmitted && (await emailInput.isVisible().catch(() => false))) {
        await emailInput.fill(email);
        await sleep(200);
        const submitBtn = page
          .locator("button, [role=button], input[type=submit]")
          .filter({ hasText: /^Continue$|^Next$|^Send code$/i })
          .first();
        if ((await submitBtn.count()) > 0) {
          await submitBtn.click();
        } else {
          await emailInput.press("Enter");
        }
        emailSubmitted = true;
        await sleep(2500);
        continue;
      }

      if (emailSubmitted) {
        if (/couldn't find|no account|create a new|doesn't match/i.test(state.text)) {
          throw codedError("login_rejected", `Muse/Meta rejected ${email}: ${state.text.split("\n").slice(0, 4).join(" ")}`);
        }
        const sendCodeBtn = page
          .locator("button, [role=button]")
          .filter({ hasText: /Send code|Continue with email|Enter code|Try another way/i })
          .first();
        if ((await sendCodeBtn.count()) > 0) {
          await sendCodeBtn.click();
          await sleep(2000);
          continue;
        }
      }

      await sleep(700);
    }

    const codeInput = page.locator(codeSelector).first();
    if ((await codeInput.count()) === 0) {
      throw codedError("code_screen_missing", `Did not reach 6-digit code screen for ${email}`);
    }

    const code = await waitForImapOtp({
      host: resolvedImapHost,
      user: email,
      password,
      minUid: preImap.maxUid + 1,
      timeoutMs: otpTimeoutMs,
      query: queryOtp,
    });

    // Ensure "Remember this device" checkbox is checked when present.
    const rememberBox = page.locator('input[type="checkbox"]').first();
    if ((await rememberBox.count()) > 0 && !(await rememberBox.isChecked().catch(() => true))) {
      await rememberBox.check({ force: true }).catch(() => {});
    }

    // Backing <input class="sr-only"> is covered by presentation digit boxes, so focus + fill instead of pointer click.
    await codeInput.focus();
    await codeInput.fill(code);
    await sleep(400);

    const nextBtn = page
      .locator("button, [role=button], input[type=submit]")
      .filter({ hasText: /^Next$|^Confirm$|^Continue$|^Verify$|^Submit$/i })
      .first();
    if ((await nextBtn.count()) > 0 && (await nextBtn.isEnabled().catch(() => false))) {
      await nextBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    const finishDeadline = Date.now() + 45_000;
    let profileFilled = false;
    while (Date.now() < finishDeadline) {
      await sleep(1500);
      state = await inspectPageState(page);
      if (state.captcha) {
        throw codedError("captcha_blocked", `CAPTCHA / human verification encountered after OTP for ${email}; stopping.`);
      }
      if (state.signedIn) {
        const cookies = await context.cookies(["https://muse.ai", "https://auth.meta.com"]);
        saveCookies(account.id, cookies);
        setStatus(account.id, "signed_in");
        await syncTargetsFn(account.id);
        return { id: account.id, email, status: "signed_in", cookiesCount: cookies.length };
      }
      if (/incorrect|invalid code|expired|try again/i.test(state.text)) {
        throw codedError("invalid_otp", `Muse rejected OTP code for ${email}`);
      }
      if (/isn[’']t available in your country|join the waitlist/i.test(state.text)) {
        setStatus(account.id, "signed_out");
        throw codedError(
          "region_waitlist",
          `Muse waitlist / region block for ${email}: Muse isn't available in this IP's country/region yet`,
        );
      }
      if (!profileFilled && /finish creating your account|first name/i.test(state.text)) {
        const { firstName, lastName } = deriveProfileName(email);
        const firstInput = page.locator('input[placeholder*="First name" i], input[aria-label*="First name" i]').first();
        const lastInput = page.locator('input[placeholder*="Last name" i], input[aria-label*="Last name" i]').first();
        if ((await firstInput.count()) > 0) await firstInput.fill(firstName).catch(() => {});
        if ((await lastInput.count()) > 0) await lastInput.fill(lastName).catch(() => {});
        const selects = page.locator("select");
        const selCount = await selects.count();
        for (let i = 0; i < selCount; i += 1) {
          const sel = selects.nth(i);
          await sel
            .evaluate((el) => {
              const opts = [...el.options].map((o) => ({ value: o.value, text: o.text }));
              const yearOpt = opts.find((o) => o.text === "1992" || o.value === "1992");
              const monthOpt = opts.find((o) => /may/i.test(o.text));
              const dayOpt = opts.find((o) => o.text === "15" || o.value === "15");
              const target = yearOpt ?? monthOpt ?? dayOpt ?? opts.find((o) => o.value && !/month|day|year/i.test(o.text));
              if (target) {
                el.value = target.value;
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
            })
            .catch(() => {});
        }
        profileFilled = true;
        await sleep(300);
      }
      // Handle optional non-monetary post-login "Continue" / "Save" / "Agree" prompt if Meta shows one.
      const continueBtn = page
        .locator("button, [role=button], input[type=submit]")
        .filter({ hasText: /^Continue$|^Confirm$|^Finish$|^Sign up$|^Save$|^Done$|^Get started$|^Accept$|^Agree$|^I agree$/i })
        .first();
      if ((await continueBtn.count()) > 0 && (await continueBtn.isEnabled().catch(() => false))) {
        await continueBtn.click().catch(() => {});
      }
    }

    setStatus(account.id, "signed_out");
    const snippet = state.text ? ` (screen: ${state.text.replace(/\s+/g, " ").slice(0, 180)})` : "";
    throw codedError("signin_timeout", `Timed out waiting for Muse chat view after OTP for ${email}${snippet}`);
  } finally {
    await context.close();
  }
}

/**
 * Trigger BB Hub's `muse.syncAccounts` RPC when running on a BB machine so all connected
 * BB hosts receive the updated cookies immediately. Best-effort; never throws.
 * @param {{ exec?: Function }} [opts]
 */
export async function syncBbHubAccounts({ exec = execFileP } = {}) {
  let tmpFile = null;
  try {
    const { stdout: statusJson } = await exec("bb", ["status", "--json"], { encoding: "utf8", timeout: 10_000 });
    const hostId = JSON.parse(statusJson)?.thread?.environment?.hostId;
    if (!hostId) return null;
    tmpFile = path.join(os.tmpdir(), `muse-sync-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ hostId }), { mode: 0o600 });
    const { stdout: rpcOut } = await exec(
      "bb",
      ["plugin", "rpc", "call", "muse", "syncAccounts", "--input-file", tmpFile, "--json"],
      { encoding: "utf8", timeout: 60_000 },
    );
    return JSON.parse(rpcOut);
  } catch {
    return null;
  } finally {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
  }
}

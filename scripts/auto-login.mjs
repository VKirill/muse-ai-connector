#!/usr/bin/env node
// Automated Muse account login via Chrome persistent profile + IMAP OTP.
// Examples:
//   node scripts/auto-login.mjs                    # sign in all signed-out MUSE_MAIL_* / email accounts via BB Env Catalog
//   node scripts/auto-login.mjs --force            # force OTP re-login for all email accounts
//   node scripts/auto-login.mjs <id-or-email>      # sign in one account
//   node scripts/auto-login.mjs --batch -          # read `<email> <password> [mailbox: mail.com]` lines from stdin
import { cmdAccountsAutoLogin } from "../bin/musebridge.mjs";

cmdAccountsAutoLogin(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
});

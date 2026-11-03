import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { answerPermissionCards, permissionDecision } from "../bridge/permissions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "permission-card.html"), "utf8");

test("permissionDecision auto-approves non-money cards (EN and RU)", () => {
  assert.equal(
    permissionDecision({
      title: "Allow Muse to join a Tailscale network in Tailscale?",
      details: "Registers this device with its configured login server",
    }),
    "always_allow",
  );
  assert.equal(
    permissionDecision({ title: "Разрешить Muse присоединение к сети Tailscale в Tailscale?", details: "" }),
    "always_allow",
  );
  assert.equal(permissionDecision({ title: "Allow Muse to read your calendar", details: "" }), "always_allow");
});

test("permissionDecision sends money cards to the owner", () => {
  assert.equal(
    permissionDecision({ title: "Allow Muse to make a purchase in Shop?", details: "Charges your card $25" }),
    "ask",
  );
  assert.equal(permissionDecision({ title: "Разрешить Muse оплату подписки?", details: "" }), "ask");
  assert.equal(permissionDecision({ title: "Allow Muse to continue?", details: "Payment of $10 required" }), "ask");
});

async function withFixturePage(t, html, fn) {
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (err) {
    t.skip(`chrome launch failed: ${err.message}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await fn(page);
  } finally {
    await browser.close();
  }
}

test("answerPermissionCards clicks Always allow, falls back to Allow, and asks on money", async (t) => {
  await withFixturePage(t, fixture, async (page) => {
    const asked = [];
    const logs = [];
    const handled = await answerPermissionCards(page, {
      onAsk: (card) => asked.push(card),
      log: (line) => logs.push(line),
    });

    const tailscale = await page.locator("#tailscale-card").getAttribute("data-answered");
    assert.equal(tailscale, "always");
    const purchase = await page.locator("#purchase-card").getAttribute("data-answered");
    assert.equal(purchase, null);
    const calendar = await page.locator("#calendar-card").getAttribute("data-answered");
    assert.equal(calendar, "allow");

    assert.equal(asked.length, 1);
    assert.match(asked[0].title, /purchase/i);
    assert.ok(logs.some((line) => /Tailscale/.test(line)));

    const decisions = Object.fromEntries(handled.map((c) => [c.title, c.decision]));
    assert.equal(decisions["Allow Muse to make a purchase in Shop?"], "ask");
    assert.equal(decisions["Allow Muse to read your calendar?"], "always_allow");
  });
});

test("answerPermissionCards answers RU cards with «Всегда разрешать», never Deny", async (t) => {
  const ru = `<!doctype html><html><body>
    <div class="approval-card" id="ru-card">
      <div class="approval-title">Разрешить Muse присоединение к сети Tailscale в Tailscale?</div>
      <div class="approval-actions">
        <button data-action="deny">Отклонить</button>
        <button data-action="allow">Разрешить</button>
        <button data-action="always">Всегда разрешать</button>
      </div>
    </div>
    <script>
      document.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => { b.closest(".approval-card").dataset.answered = b.dataset.action; }));
    </script>
  </body></html>`;
  await withFixturePage(t, ru, async (page) => {
    const asked = [];
    await answerPermissionCards(page, { onAsk: (card) => asked.push(card) });
    assert.equal(await page.locator("#ru-card").getAttribute("data-answered"), "always");
    assert.equal(asked.length, 0);
  });
});

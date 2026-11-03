// Approval-card policy for Muse chats driven by the connector.
//
// Muse shows an approval card («Allow Muse to … ?» with Allow / Always allow /
// Deny, RU: Разрешить / Всегда разрешать / Отклонить) and pauses the chat until
// it is answered. The connector answers «Always allow» for every card except
// cards about money, which are left to the owner. Deny is never clicked.

const MONEY_RE =
  /purchase|buy|pay(ment)?|charge|subscri|checkout|order|billing|card|оплат|покуп|купить|подписк|списан/i;

export const PERM_CARD_ATTR = "data-muse-perm-card";

/**
 * @param {{ title?: string, details?: string }} card
 * @returns {"always_allow" | "ask"}
 */
export function permissionDecision({ title, details } = {}) {
  const text = `${title ?? ""}\n${details ?? ""}`;
  return MONEY_RE.test(text) ? "ask" : "always_allow";
}

// Runs inside the page. Finds approval cards by their action buttons (EN and
// RU), tags each card root with PERM_CARD_ATTR, and returns serializable
// { key, title, details } records.
function scanPermissionCardsInPage() {
  const attr = "data-muse-perm-card";
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const btext = (el) => norm(el.innerText ?? el.textContent ?? "");
  const ALWAYS = /always allow|всегда разрешать/i;
  const ALLOW = /^(allow|разрешить)$/i;
  const DENY = /deny|отклонить/i;
  const SKIP_LINE =
    /^(allow|always allow|deny|разрешить|всегда разрешать|отклонить|request|запрос|approval required.*|требуется одобрение.*)$/i;

  const buttons = [...document.querySelectorAll("button, [role='button']")];
  const triggers = buttons.filter(
    (b) => visible(b) && (ALWAYS.test(btext(b)) || ALLOW.test(btext(b))),
  );
  const outsideButtonText = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && !node.parentElement.closest("button, [role='button'], script, style")) {
        parts.push(node.nodeValue || "");
      }
    }
    return parts.join("\n");
  };
  const nonButtonLine = (el) =>
    outsideButtonText(el)
      .split("\n")
      .map((l) => l.trim())
      .some((l) => l && !SKIP_LINE.test(l));
  const roots = [];
  for (const btn of triggers) {
    let root = btn;
    let fallback = null;
    for (let depth = 0; depth < 10 && root.parentElement && root !== document.body; depth++) {
      const parent = root.parentElement;
      const texts = [...parent.querySelectorAll("button, [role='button']")].map(btext);
      if (texts.length > 8) break;
      if (texts.some((t) => ALWAYS.test(t) || ALLOW.test(t)) && texts.some((t) => DENY.test(t))) {
        if (nonButtonLine(parent)) {
          root = parent;
          fallback = null;
          break;
        }
        fallback = parent;
      }
      root = parent;
    }
    if (fallback) root = fallback;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots.map((root, i) => {
    const key = root.getAttribute(attr) ?? `mpc-${i}-${Math.random().toString(36).slice(2, 8)}`;
    root.setAttribute(attr, key);
    const textLines = outsideButtonText(root)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !SKIP_LINE.test(l));
    return { key, title: textLines[0] ?? "", details: textLines.slice(1).join("\n") };
  });
}

// Runs inside the page. Clicks «Always allow» (fallback «Allow») on the card
// tagged with key. Returns the clicked button label, or null. Never clicks Deny.
function clickPermissionCardInPage(key) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const root = document.querySelector(`[data-muse-perm-card="${key}"]`);
  if (!root) return null;
  const buttons = [...root.querySelectorAll("button, [role='button']")].filter(
    (b) => visible(b) && !b.disabled,
  );
  const pick = (re) =>
    buttons.find((b) => re.test(norm(b.innerText ?? b.textContent ?? "")));
  const btn =
    pick(/always allow|всегда разрешать/i) ?? pick(/^(allow|разрешить)$/i);
  if (!btn) return null;
  const label = norm(btn.innerText ?? btn.textContent ?? "");
  btn.click();
  return label;
}

/**
 * Answers every visible approval card on the page by policy.
 *
 * @param {import("playwright-core").Page} page
 * @param {{ onAsk?: (card: { title: string, details: string }) => void | Promise<void>, log?: (line: string) => void }} [opts]
 * @returns {Promise<Array<{ key: string, title: string, details: string, decision: string, clicked?: string }>>}
 */
export async function answerPermissionCards(page, { onAsk, log } = {}) {
  let cards;
  try {
    cards = await page.evaluate(scanPermissionCardsInPage);
  } catch {
    return [];
  }
  const handled = [];
  for (const card of cards) {
    const decision = permissionDecision(card);
    if (decision === "ask") {
      await onAsk?.({ title: card.title, details: card.details });
      handled.push({ ...card, decision });
      continue;
    }
    const clicked = await page
      .evaluate(clickPermissionCardInPage, card.key)
      .catch(() => null);
    if (clicked) {
      log?.(`auto-approved Muse approval card: ${card.title}`);
      handled.push({ ...card, decision, clicked });
    } else {
      handled.push({ ...card, decision: "unanswered" });
    }
  }
  return handled;
}

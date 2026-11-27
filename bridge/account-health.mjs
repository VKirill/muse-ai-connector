import { listAccounts, pickAccount, setStatus } from "./accounts.mjs";

// Owner rule: a Muse account without working authorization gets no requests.

/** Muse refused the account itself: auth failed, or the bootstrap was rejected (400/401/403). */
export function isAuthRefused(err) {
  return err?.code === "auth_failed" || err?.status === 400 || err?.status === 401 || err?.status === 403;
}

/** The account cannot serve this request: auth refused, or its VM gateway refused the dial. */
export function isDeadAccountError(err) {
  return isAuthRefused(err) || err?.code === "gateway_dial_failed";
}

/**
 * Takes a dead account out of rotation and returns the next account to try, or null.
 * Auth refusals become signed_out; a refused dial becomes unknown, which pickAccount
 * uses only when no signed-in account is free, and the next success marks it signed_in.
 * @param {string} id
 * @param {unknown} err
 * @param {Set<string>} tried account ids already tried in this request
 */
export function nextAfterDeadAccount(id, err, tried) {
  tried.add(id);
  if (listAccounts().some((a) => a.id === id)) setStatus(id, isAuthRefused(err) ? "signed_out" : "unknown");
  let next;
  try {
    next = pickAccount();
  } catch {
    return null;
  }
  return tried.has(next.id) ? null : next;
}

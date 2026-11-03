// Copy one account's cookies from a source host to every other connected host
// that has a runtime. `call(method, input, {hostId})` is the injected host RPC
// client: "exportAccount" -> {id, label, cookies}, "importAccount" -> {ok}.
// Cookies live only in this process' memory — they are never logged or persisted.
// A failure on one host is reported on its own row and never stops the others.

/**
 * @param {{sourceHostId: string, accountId: string, hosts: {hostId: string, connected: boolean, runtime: boolean}[], call: Function}} opts
 * @returns {Promise<{hostId: string, ok: boolean, error?: string}[]>}
 */
export async function syncAcrossHosts({ sourceHostId, accountId, hosts, call }) {
  const exported = await call("exportAccount", { id: accountId }, { hostId: sourceHostId });
  const payload = {
    id: accountId,
    label: typeof exported?.label === "string" && exported.label ? exported.label : accountId,
    cookies: Array.isArray(exported?.cookies) ? exported.cookies : [],
  };
  if (Number.isInteger(exported?.maxParallel) && exported.maxParallel >= 1) {
    payload.maxParallel = exported.maxParallel;
  }
  const targets = (hosts ?? []).filter((h) => h && h.hostId !== sourceHostId && h.connected && h.runtime);
  const results = [];
  for (const host of targets) {
    try {
      const res = await call("importAccount", payload, { hostId: host.hostId });
      results.push(
        res && res.ok === true
          ? { hostId: host.hostId, ok: true }
          : { hostId: host.hostId, ok: false, error: res?.error ?? "import failed" },
      );
    } catch (e) {
      results.push({ hostId: host.hostId, ok: false, error: String(e?.message ?? e) });
    }
  }
  return results;
}

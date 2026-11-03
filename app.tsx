import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { t } from "./i18n";
import type { HostEntry, MergedUsageAccount, SyncRow, rpcContract } from "./server";

type AccountRow = NonNullable<HostEntry["status"]>["accounts"][number];
type HostStatus = NonNullable<HostEntry["status"]>;
type PanelPage = "" | "machines" | "add";

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="muse-row">
      <span className="muse-row-label">{label}</span>
      <span className={bad ? "muse-text-danger" : undefined}>{value}</span>
    </div>
  );
}

function statusPill(account: Pick<AccountRow, "locked" | "status">): { className: string; label: string } {
  if (account.locked) return { className: "muse-pill muse-pill-info", label: t("statusBusy") };
  if (account.status === "signed_in") return { className: "muse-pill muse-pill-success", label: t("statusSignedIn") };
  if (account.status === "signed_out") return { className: "muse-pill muse-pill-warning", label: t("statusSignedOut") };
  return { className: "muse-pill muse-pill-muted", label: t("statusUnknown") };
}

function lastUsedLabel(iso: string): string {
  if (!iso) return t("neverUsed");
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return t("neverUsed");
  return t("lastUsed", { when: new Date(ms).toLocaleString() });
}

function chromeMachineNames(hosts: HostEntry[]): string {
  return hosts
    .filter((h) => h.connected && h.status?.chromeFound)
    .map((h) => h.name)
    .join(", ");
}

function addSuccessText(label: string, synced: SyncRow[], hosts: HostEntry[]): string {
  const ok = String(synced.filter((s) => s.ok).length);
  const failedNames = synced
    .filter((s) => !s.ok)
    .map((s) => hosts.find((h) => h.hostId === s.hostId)?.name ?? s.hostId)
    .join(", ");
  const base = t("addSuccess", { label, count: ok });
  return failedNames ? `${base}. ${t("addSyncFailed", { names: failedNames })}` : base;
}

function uniqueAccountCount(hosts: HostEntry[]): number {
  return new Set(hosts.flatMap((h) => h.status?.accounts.map((a) => a.id) ?? [])).size;
}

function mergedAccounts(hosts: HostEntry[]): Array<AccountRow & { machines: Array<{ hostId: string; name: string; account: AccountRow }> }> {
  const map = new Map<string, AccountRow & { machines: Array<{ hostId: string; name: string; account: AccountRow }> }>();
  for (const host of hosts) {
    for (const account of host.status?.accounts ?? []) {
      let row = map.get(account.id);
      if (!row) {
        row = { ...account, machines: [] };
        map.set(account.id, row);
      }
      row.machines.push({ hostId: host.hostId, name: host.name, account });
      if (typeof account.max === "number") row.max = Math.max(row.max ?? 0, account.max);
      if (account.status === "signed_in") row.status = "signed_in";
      if (account.locked) row.locked = true;
      if (account.lastUsedAt > row.lastUsedAt) row.lastUsedAt = account.lastUsedAt;
    }
  }
  return [...map.values()];
}

function formatReset(usage: MergedUsageAccount["usage"]): string {
  if (!usage) return "";
  if (usage.periodLabel) return usage.periodLabel;
  if (typeof usage.resetsAt === "number") {
    const ms = usage.resetsAt > 1e12 ? usage.resetsAt : usage.resetsAt * 1000;
    return new Date(ms).toLocaleDateString();
  }
  return "";
}

function RuntimeRow({
  st,
  busy,
  onInstall,
}: {
  st: HostStatus;
  busy: boolean;
  onInstall: () => void;
}) {
  const rt = st.runtime;
  if (st.platform === "win32") {
    return <Row label={t("runtime")} value={t("runtimeUnsupported")} bad />;
  }
  if (rt.installing) {
    return (
      <div className="muse-row">
        <span className="muse-row-label">{t("runtime")}</span>
        <span className="muse-progress">
          <span className="muse-spinner" aria-hidden="true" />
          {t("runtimeInstalling")}
        </span>
      </div>
    );
  }
  if (rt.installed) {
    return <Row label={t("runtime")} value={t("runtimeInstalled", { version: rt.version ?? "?" })} />;
  }
  return (
    <div className="muse-row">
      <span className="muse-row-label">{t("runtime")}</span>
      <span className="muse-actions">
        <span className="muse-text-danger">{t("runtimeMissing")}</span>
        <button type="button" className="muse-btn" disabled={busy} onClick={onInstall}>
          {t("install")}
        </button>
      </span>
    </div>
  );
}

function MachineCard({
  h,
  busy,
  onInstall,
}: {
  h: HostEntry;
  busy: boolean;
  onInstall: (hostId: string) => void;
}) {
  const st = h.status;
  if (!st) {
    const value = h.error ? `${t("noAnswer")}: ${h.error}` : h.connected ? t("noAnswer") : t("offline");
    return <Row label={h.name} value={value} bad={Boolean(h.error) || !h.connected} />;
  }
  return (
    <div className="muse-panel">
      <div className="muse-panel-head">
        <span>{h.name}</span>
        <span className={h.connected ? "muse-pill muse-pill-success" : "muse-pill muse-pill-muted"}>
          {h.connected ? t("connected") : t("offline")}
        </span>
      </div>
      <div className="muse-panel-body">
        <RuntimeRow st={st} busy={busy} onInstall={() => onInstall(h.hostId)} />
        <Row label={t("chrome")} value={st.chromeFound ? `${t("chromeFound")}${st.chromePath ? ` (${st.chromePath})` : ""}` : t("chromeMissing")} bad={!st.chromeFound} />
        <Row label={t("bridge")} value={st.bridgeFound ? `musebridge ${st.bridgeVersion ?? "?"}` : t("bridgeMissing")} bad={!st.bridgeFound} />
        <Row label={t("agent")} value={st.agentFound ? t("agentFound") : t("agentMissing")} bad={!st.agentFound} />
        {st.runtime.error ? <div className="muse-error">{st.runtime.error}</div> : null}
        {st.problems.map((p) => (
          <div key={p} className="muse-error">
            {p}
          </div>
        ))}
        <div className="muse-muted">{t("accounts")}</div>
        {st.accounts.length === 0 ? <div className="muse-muted">{t("emptyAccounts")}</div> : null}
        {st.accounts.map((account) => {
          const pill = statusPill(account);
          return (
            <div key={account.id} className="muse-compact">
              <span className="muse-account-name">
                <span>{account.label}</span>
                <span className={pill.className}>{pill.label}</span>
              </span>
              <span className="muse-muted">{t("busySlots", { busy: String(account.busy ?? 0), max: String(account.max ?? 1) })}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccountLimitCard({
  account,
  usage,
  busy,
  onCheck,
  onSync,
  onRemove,
}: {
  account: ReturnType<typeof mergedAccounts>[number];
  usage: MergedUsageAccount | undefined;
  busy: boolean;
  onCheck: (hostId: string, id: string) => void;
  onSync: (hostId: string, id: string) => void;
  onRemove: (hostId: string, id: string, purge: boolean) => void;
}) {
  const pill = statusPill(account);
  const snapshot = usage?.usage;
  const percent = snapshot?.percentUsed;
  const reset = formatReset(snapshot ?? null);
  const extra = snapshot?.extraTokensLeftLabel ?? (snapshot?.extraTokensBalance != null ? String(snapshot.extraTokensBalance) : "");
  const actionHost = account.machines.find((m) => m.account.status === "signed_in") ?? account.machines[0];
  const meter = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
  return (
    <div className="muse-card">
      <div className="muse-account-name">
        <span>{account.label}</span>
        <span className={pill.className}>{pill.label}</span>
      </div>
      <div className="muse-muted">
        {account.id} · {lastUsedLabel(account.lastUsedAt)}
      </div>
      {usage?.error ? <div className="muse-error">{t("usageUnavailable", { reason: usage.error.message })}</div> : null}
      {!usage?.error && snapshot ? (
        <>
          <div>{t("usagePlan", { name: snapshot.plan ?? "—" })}</div>
          <div className="muse-meter" style={{ ["--muse-meter" as string]: `${meter}%` }}>
            <span className="muse-meter-fill" />
          </div>
          <div className="muse-muted">{typeof percent === "number" ? t("usageUsed", { n: String(percent) }) : t("usageUnlimited")}</div>
          {reset ? <div className="muse-muted">{t("usageResets", { when: reset })}</div> : null}
          {extra ? <div className="muse-muted">{t("usageExtraTokens", { value: extra })}</div> : null}
        </>
      ) : null}
      {account.max ? <div className="muse-muted">{t("usageParallel", { n: String(account.max) })}</div> : null}
      <div className="muse-muted">{t("accountOnMachines", { names: account.machines.map((m) => m.name).join(", ") })}</div>
      <div className="muse-chips">
        {account.machines.map((m) => {
          const chip = statusPill(m.account);
          return (
            <span key={m.hostId} className={chip.className}>
              {m.name}: {chip.label}
            </span>
          );
        })}
      </div>
      <div className="muse-actions">
        <button
          type="button"
          className="muse-btn"
          disabled={busy || !actionHost}
          onClick={() => actionHost && onCheck(actionHost.hostId, account.id)}
        >
          {t("check")}
        </button>
        <button
          type="button"
          className="muse-btn"
          disabled={busy || !actionHost}
          onClick={() => actionHost && onSync(actionHost.hostId, account.id)}
        >
          {t("copyToAll")}
        </button>
        <button
          type="button"
          className="muse-btn"
          disabled={busy || !actionHost}
          onClick={() => {
            if (!actionHost) return;
            if (!globalThis.confirm(t("removeConfirm", { label: account.label }))) return;
            onRemove(actionHost.hostId, account.id, globalThis.confirm(t("purgeProfile")));
          }}
        >
          {t("remove")}
        </button>
      </div>
    </div>
  );
}

function useMuseHosts() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingHostId, setAddingHostId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const mergeHosts = useCallback((next: HostEntry[], hostId?: string) => {
    setHosts((prev) => (hostId && prev ? prev.map((h) => next.find((n) => n.hostId === h.hostId) ?? h) : next));
  }, []);

  const load = useCallback(() => {
    setBusy(true);
    rpc.call("hosts", {}).then(
      (r) => {
        mergeHosts(r.hosts);
        setError(null);
        setBusy(false);
      },
      (e) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  }, [mergeHosts, rpc]);

  const run = useCallback(
    (work: () => Promise<{ hosts: HostEntry[] }>, hostId?: string) => {
      setBusy(true);
      work().then(
        (r) => {
          mergeHosts(r.hosts, hostId);
          setError(null);
          setBusy(false);
        },
        (e) => {
          setError(e instanceof Error ? e.message : String(e));
          setBusy(false);
        },
      );
    },
    [mergeHosts],
  );

  useEffect(() => load(), [load]);

  return { rpc, hosts, error, busy, setBusy, addingHostId, setAddingHostId, notice, setNotice, mergeHosts, load, run };
}

function MuseSettings() {
  const nav = useBbNavigate();
  const { hosts, error, busy, load } = useMuseHosts();
  const summary =
    hosts === null
      ? t("loading")
      : t("settingsSummary", { accounts: String(uniqueAccountCount(hosts)), machines: String(hosts.length) });
  return (
    <div className="muse-stack" data-bb-plugin="muse">
      {error ? (
        <div className="muse-error">
          {t("error")}: {error}
        </div>
      ) : null}
      <div className="muse-muted">{summary}</div>
      <div className="muse-actions">
        <button type="button" className="muse-btn muse-btn-accent" onClick={() => nav.toPluginPanel("muse")}>
          {t("openMusePanel")}
        </button>
        <button type="button" className="muse-btn" disabled={busy} onClick={load}>
          {t("refresh")}
        </button>
      </div>
    </div>
  );
}

function PanelNav({ page }: { page: PanelPage }) {
  const nav = useBbNavigate();
  const go = (subPath: PanelPage) => nav.toPluginPanel("muse", { subPath });
  const items: Array<{ id: PanelPage; label: string }> = [
    { id: "", label: t("navAccounts") },
    { id: "machines", label: t("navMachines") },
    { id: "add", label: t("navAdd") },
  ];
  return (
    <div className="muse-nav">
      {items.map((item) => (
        <button
          key={item.id || "accounts"}
          type="button"
          className="muse-btn muse-nav-btn"
          aria-current={page === item.id ? "page" : undefined}
          onClick={() => go(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function AccountsPage({
  hosts,
  busy,
  onCheck,
  onSync,
  onRemove,
}: {
  hosts: HostEntry[];
  busy: boolean;
  onCheck: (hostId: string, id: string) => void;
  onSync: (hostId: string, id: string) => void;
  onRemove: (hostId: string, id: string, purge: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<MergedUsageAccount[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const loadUsage = useCallback(() => {
    rpc.call("usage", {}).then(
      (r) => {
        setRows(r.accounts);
        setUsageError(null);
      },
      (e) => setUsageError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(() => loadUsage(), [loadUsage]);
  const accounts = useMemo(() => mergedAccounts(hosts), [hosts]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  return (
    <div className="muse-stack">
      {usageError ? (
        <div className="muse-error">
          {t("error")}: {usageError}
        </div>
      ) : null}
      {accounts.length === 0 ? <div className="muse-muted">{t("emptyAccounts")}</div> : null}
      {accounts.map((account) => (
        <AccountLimitCard
          key={account.id}
          account={account}
          usage={byId.get(account.id)}
          busy={busy}
          onCheck={onCheck}
          onSync={onSync}
          onRemove={onRemove}
        />
      ))}
      <div>
        <button type="button" className="muse-btn" disabled={busy} onClick={loadUsage}>
          {t("refreshLimits")}
        </button>
      </div>
    </div>
  );
}

function MachinesPage({
  hosts,
  busy,
  onInstall,
}: {
  hosts: HostEntry[];
  busy: boolean;
  onInstall: (hostId: string) => void;
}) {
  return (
    <div className="muse-stack">
      {hosts.map((h) => (
        <MachineCard key={h.hostId} h={h} busy={busy} onInstall={onInstall} />
      ))}
      {hosts.length === 0 ? <div className="muse-muted">{t("hostOffline")}</div> : null}
    </div>
  );
}

function AddAccountPage({
  hosts,
  busy,
  addingHostId,
  notice,
  onAdd,
}: {
  hosts: HostEntry[];
  busy: boolean;
  addingHostId: string | null;
  notice: { kind: "ok" | "err"; text: string } | null;
  onAdd: (hostId: string, label: string) => void;
}) {
  const nav = useBbNavigate();
  const chromeHosts = hosts.filter((h) => h.connected && h.status?.chromeFound);
  const [hostId, setHostId] = useState(chromeHosts[0]?.hostId ?? "");
  const [label, setLabel] = useState("");
  const selected = hosts.find((h) => h.hostId === hostId);
  const adding = addingHostId !== null;
  return (
    <div className="muse-stack">
      <div className="muse-steps">
        <div>{t("addStep1")}</div>
        <div>{t("addStep2")}</div>
        <div>{t("addStep3")}</div>
      </div>
      {adding ? (
        <div className="muse-progress">
          <span className="muse-spinner" aria-hidden="true" />
          <span>{t("addInProgress", { name: selected?.name ?? hostId })}</span>
        </div>
      ) : (
        <>
          <label className="muse-row">
            <span className="muse-row-label">{t("pickMachine")}</span>
            <select
              className="muse-input"
              value={hostId}
              disabled={busy}
              onChange={(e) => setHostId(e.target.value)}
            >
              {hosts.map((h) => (
                <option key={h.hostId} value={h.hostId} disabled={!h.connected || !h.status?.chromeFound}>
                  {h.name}
                  {!h.status?.chromeFound ? ` — ${t("chromeRequired")}` : ""}
                </option>
              ))}
            </select>
          </label>
          {!selected?.status?.chromeFound ? (
            <p className="muse-muted">{t("noChromeOnHost", { names: chromeMachineNames(hosts) })}</p>
          ) : null}
          <div className="muse-actions">
            <input
              className="muse-input"
              value={label}
              disabled={busy}
              placeholder={t("labelPlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              type="button"
              className="muse-btn muse-btn-accent"
              disabled={busy || !label.trim() || !selected?.status?.chromeFound}
              onClick={() => {
                const next = label.trim();
                if (!next || !hostId) return;
                onAdd(hostId, next);
                setLabel("");
              }}
            >
              {t("addAccount")}
            </button>
          </div>
        </>
      )}
      {notice ? <div className={notice.kind === "ok" ? "muse-ok" : "muse-error"}>{notice.text}</div> : null}
      {notice?.kind === "ok" ? (
        <button type="button" className="muse-btn" onClick={() => nav.toPluginPanel("muse", { subPath: "" })}>
          {t("goToAccounts")}
        </button>
      ) : null}
    </div>
  );
}

function MusePanel({ subPath }: { subPath: string }) {
  const page: PanelPage = subPath === "machines" || subPath === "add" ? subPath : "";
  const { rpc, hosts, error, busy, setBusy, addingHostId, setAddingHostId, notice, setNotice, mergeHosts, load, run } =
    useMuseHosts();
  return (
    <div className="muse-stack" data-bb-plugin="muse">
      <PanelNav page={page} />
      {error ? (
        <div className="muse-error">
          {t("error")}: {error}
        </div>
      ) : null}
      {hosts === null ? <div className="muse-muted">{t("loading")}</div> : null}
      {hosts && page === "" ? (
        <AccountsPage
          hosts={hosts}
          busy={busy}
          onCheck={(hostId, id) => run(() => rpc.call("checkAccounts", { hostId, id }), hostId)}
          onSync={(hostId, id) => run(() => rpc.call("syncAccounts", { hostId, id }), hostId)}
          onRemove={(hostId, id, purge) => run(() => rpc.call("removeAccount", { hostId, id, purge }), hostId)}
        />
      ) : null}
      {hosts && page === "machines" ? (
        <MachinesPage hosts={hosts} busy={busy} onInstall={(hostId) => run(() => rpc.call("installRuntime", { hostId }), hostId)} />
      ) : null}
      {hosts && page === "add" ? (
        <AddAccountPage
          hosts={hosts}
          busy={busy}
          addingHostId={addingHostId}
          notice={notice}
          onAdd={(hostId, label) => {
            setAddingHostId(hostId);
            setNotice(null);
            setBusy(true);
            rpc.call("addAccount", { hostId, label }).then(
              (r) => {
                mergeHosts(r.hosts, hostId);
                setNotice({
                  kind: "ok",
                  text: addSuccessText(
                    label,
                    r.synced,
                    hosts.map((entry) => r.hosts.find((n) => n.hostId === entry.hostId) ?? entry),
                  ),
                });
                setAddingHostId(null);
                setBusy(false);
              },
              (e) => {
                setNotice({ kind: "err", text: e instanceof Error ? e.message : String(e) });
                setAddingHostId(null);
                setBusy(false);
              },
            );
          }}
        />
      ) : null}
      <div>
        <button type="button" className="muse-btn" disabled={busy} onClick={load}>
          {t("refresh")}
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "muse",
    title: t("settingsTitle"),
    icon: "Bot",
    path: "muse",
    component: MusePanel,
  });
  app.slots.settingsSection({
    id: "muse-accounts",
    title: t("settingsTitle"),
    description: t("settingsDescription"),
    component: MuseSettings,
  });
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { t } from "./i18n";
import type { HostEntry, MergedUsageAccount, SyncRow, rpcContract } from "./server";

type AccountRow = NonNullable<HostEntry["status"]>["accounts"][number];
type HostStatus = NonNullable<HostEntry["status"]>;
type PanelPage = "" | "machines" | "add";
type MergedAccount = AccountRow & { machines: Array<{ hostId: string; name: string; account: AccountRow }> };

// Same limit the server uses in collectMergedUsage (server.ts USAGE_TIMEOUT_MS);
// the value is not imported so the app bundle never pulls in server code.
const USAGE_TIMEOUT_MS = 45000;

function useLocale(): void {
  const [, setLocale] = useState(() => t("navAccounts"));
  useEffect(() => {
    const sync = () => setLocale(t("navAccounts"));
    const el = globalThis.document?.documentElement;
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ["lang", "data-pk-lang"] });
    const t1 = globalThis.setTimeout(sync, 500);
    const t2 = globalThis.setTimeout(sync, 2000);
    const t3 = globalThis.setTimeout(sync, 5000);
    return () => {
      observer.disconnect();
      globalThis.clearTimeout(t1);
      globalThis.clearTimeout(t2);
      globalThis.clearTimeout(t3);
    };
  }, []);
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

function connectedMachineCount(hosts: HostEntry[]): number {
  return hosts.filter((h) => h.connected).length;
}

function mergedAccounts(hosts: HostEntry[]): MergedAccount[] {
  const map = new Map<string, MergedAccount>();
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

function chromeValue(st: HostStatus): string {
  if (!st.chromeFound) return t("chromeMissing");
  return st.chromePath ? `${t("chromeFound")} (${st.chromePath})` : t("chromeFound");
}

function bridgeValue(st: HostStatus): string {
  return st.bridgeFound ? `musebridge ${st.bridgeVersion ?? "?"}` : t("bridgeMissing");
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
    return (
      <div className="muse-card">
        <div className="muse-card-head">
          <span className="muse-account-name">{h.name}</span>
          <span className={h.connected ? "muse-pill muse-pill-success" : "muse-pill muse-pill-muted"}>
            {h.connected ? t("connected") : t("offline")}
          </span>
        </div>
        <div className={h.error || !h.connected ? "muse-text-danger" : "muse-muted"}>{value}</div>
      </div>
    );
  }
  const rt = st.runtime;
  return (
    <div className="muse-card">
      <div className="muse-card-head">
        <div className="muse-account-name">
          <span>{h.name}</span>
          <span className={h.connected ? "muse-pill muse-pill-success" : "muse-pill muse-pill-muted"}>
            {h.connected ? t("connected") : t("offline")}
          </span>
        </div>
        {rt.installing ? (
          <span className="muse-progress">
            <span className="muse-spinner" aria-hidden="true" />
            {t("runtimeInstalling")}
          </span>
        ) : rt.installed ? (
          <span className="muse-muted">{t("runtimeInstalled", { version: rt.version ?? "?" })}</span>
        ) : st.platform === "win32" ? (
          <span className="muse-text-danger">{t("runtimeUnsupported")}</span>
        ) : (
          <button type="button" className="muse-btn muse-btn-compact" disabled={busy} onClick={() => onInstall(h.hostId)}>
            {t("install")}
          </button>
        )}
      </div>
      <div className="muse-kv">
        <span className="muse-row-label">{t("chrome")}</span>
        <span className={!st.chromeFound ? "muse-text-danger" : undefined}>{chromeValue(st)}</span>
        <span className="muse-row-label">{t("bridge")}</span>
        <span className={!st.bridgeFound ? "muse-text-danger" : undefined}>{bridgeValue(st)}</span>
        <span className="muse-row-label">{t("agent")}</span>
        <span className={!st.agentFound ? "muse-text-danger" : undefined}>
          {st.agentFound ? t("agentFound") : t("agentMissing")}
        </span>
      </div>
      {st.runtime.error ? <div className="muse-error">{st.runtime.error}</div> : null}
      {st.problems.map((p) => (
        <div key={p} className="muse-error">
          {p}
        </div>
      ))}
      {st.accounts.length === 0 ? <div className="muse-muted">{t("emptyAccounts")}</div> : null}
      {st.accounts.length > 0 ? (
        <table className="muse-table">
          <tbody>
            {st.accounts.map((account) => {
              const pill = statusPill(account);
              return (
                <tr key={account.id}>
                  <td>
                    <span className="muse-account-name">{account.label}</span>
                  </td>
                  <td>
                    <span className={pill.className}>{pill.label}</span>
                  </td>
                  <td className="muse-muted">{t("busySlots", { busy: String(account.busy ?? 0), max: String(account.max ?? 1) })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function AccountMeter({
  usage,
  loading,
  onRetry,
}: {
  usage: MergedUsageAccount | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  const snapshot = usage?.usage;
  const percent = snapshot?.percentUsed;
  const meter = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
  const reset = formatReset(snapshot ?? null);
  const extra = snapshot?.extraTokensLeftLabel ?? (snapshot?.extraTokensBalance != null ? String(snapshot.extraTokensBalance) : "");
  if (loading) {
    return (
      <div className="muse-meter-row">
        <div className="muse-meter muse-meter-loading" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuetext={t("usageLoading")}>
          <span className="muse-meter-fill" />
        </div>
        <span className="muse-muted muse-meter-label">{t("usageLoading")}</span>
      </div>
    );
  }
  if (usage?.error) {
    return (
      <div className="muse-meter-row">
        <div className="muse-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuetext={t("usageUnavailable", { reason: usage.error.message })}>
          <span className="muse-meter-fill" />
        </div>
        <span className="muse-error muse-meter-label" title={usage.error.message}>
          {t("usageUnavailableLabel")}
          {" · "}
          <button type="button" className="muse-btn muse-btn-compact" onClick={onRetry}>
            {t("retry")}
          </button>
        </span>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="muse-meter-row">
        <div className="muse-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuetext={t("usageNotRead")}>
          <span className="muse-meter-fill" />
        </div>
        <span className="muse-muted muse-meter-label">
          {t("usageNotRead")}
          {" · "}
          <button type="button" className="muse-btn muse-btn-compact" onClick={onRetry}>
            {t("retry")}
          </button>
        </span>
      </div>
    );
  }
  const unlimited = typeof percent !== "number";
  return (
    <>
      <div>{t("usagePlan", { name: snapshot.plan ?? "—" })}</div>
      <div className="muse-meter-row">
        <div
          className="muse-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={unlimited ? undefined : meter}
          aria-valuetext={unlimited ? t("usageUnlimited") : t("weeklyUsed", { n: String(percent) })}
          style={{ ["--muse-meter" as string]: `${meter}%` }}
        >
          <span className="muse-meter-fill" />
        </div>
        <span className="muse-meter-pct">{unlimited ? t("usageUnlimited") : t("weeklyUsed", { n: String(percent) })}</span>
      </div>
      <div className="muse-muted">
        {reset ? t("usageResets", { when: reset }) : ""}
        {reset && extra ? " · " : ""}
        {extra ? t("usageExtraTokens", { value: extra }) : ""}
      </div>
    </>
  );
}

function AccountLimitCard({
  account,
  usage,
  loading,
  busy,
  onCheck,
  onSync,
  onRemove,
  onRetry,
}: {
  account: MergedAccount;
  usage: MergedUsageAccount | undefined;
  loading: boolean;
  busy: boolean;
  onCheck: (hostId: string, id: string) => void;
  onSync: (hostId: string, id: string) => void;
  onRemove: (hostId: string, id: string, purge: boolean) => void;
  onRetry: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [purge, setPurge] = useState(false);
  const pill = statusPill(account);
  const actionHost = account.machines.find((m) => m.account.status === "signed_in") ?? account.machines[0];
  return (
    <div className="muse-card">
      <div className="muse-card-head">
        <div className="muse-account-meta">
          <div className="muse-account-name">
            <span>{account.label}</span>
            <span className={pill.className}>{pill.label}</span>
          </div>
          <span className="muse-muted">{account.id}</span>
        </div>
        <div className="muse-card-actions">
          <button
            type="button"
            className="muse-btn muse-btn-compact"
            disabled={busy || !actionHost}
            onClick={() => actionHost && onCheck(actionHost.hostId, account.id)}
          >
            {t("check")}
          </button>
          <button
            type="button"
            className="muse-btn muse-btn-compact"
            disabled={busy || !actionHost}
            onClick={() => actionHost && onSync(actionHost.hostId, account.id)}
          >
            {t("copyToAll")}
          </button>
          <button
            type="button"
            className="muse-btn muse-btn-compact muse-btn-danger"
            disabled={busy || !actionHost}
            onClick={() => {
              setPurge(false);
              setConfirming(true);
            }}
          >
            {t("remove")}
          </button>
        </div>
      </div>
      {confirming ? (
        <div className="muse-confirm">
          <div>{t("confirmRemove", { label: account.label })}</div>
          <label className="muse-check">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            {t("purgeProfile")}
          </label>
          <div className="muse-actions">
            <button
              type="button"
              className="muse-btn muse-btn-danger"
              disabled={busy || !actionHost}
              onClick={() => {
                if (!actionHost) return;
                onRemove(actionHost.hostId, account.id, purge);
                setConfirming(false);
              }}
            >
              {t("confirm")}
            </button>
            <button type="button" className="muse-btn" onClick={() => setConfirming(false)}>
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : null}
      <AccountMeter usage={usage} loading={loading} onRetry={onRetry} />
      <div className="muse-divider" />
      <div className="muse-muted">
        {account.max ? t("usageParallel", { n: String(account.max) }) : ""}
        {account.max ? " · " : ""}
        {lastUsedLabel(account.lastUsedAt)}
      </div>
      <div className="muse-chips">
        {account.machines.map((m) => {
          const chip = statusPill(m.account);
          const mark = m.account.status === "signed_in" ? " ✓" : "";
          return (
            <span key={m.hostId} className={chip.className}>
              {`${m.name}${mark} · ${chip.label}`}
            </span>
          );
        })}
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

function Toolbar({
  title,
  summary,
  onRefresh,
  busy,
}: {
  title: string;
  summary: string;
  onRefresh?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="muse-toolbar">
      <div className="muse-toolbar-copy">
        <div className="muse-toolbar-title">{title}</div>
        <div className="muse-muted">{summary}</div>
      </div>
      {onRefresh ? (
        <button type="button" className="muse-btn" disabled={busy} onClick={onRefresh}>
          {t("refresh")}
        </button>
      ) : null}
    </div>
  );
}

function MuseSettings() {
  useLocale();
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

function SideNav({ page, hosts }: { page: PanelPage; hosts: HostEntry[] | null }) {
  const nav = useBbNavigate();
  const go = (subPath: PanelPage) => nav.toPluginPanel("muse", { subPath });
  const accounts = hosts ? uniqueAccountCount(hosts) : 0;
  const machines = hosts ? connectedMachineCount(hosts) : 0;
  const items: Array<{ id: PanelPage; label: string; count?: number }> = [
    { id: "", label: t("navAccounts"), count: accounts },
    { id: "machines", label: t("navMachines"), count: machines },
    { id: "add", label: t("navAdd") },
  ];
  return (
    <nav className="muse-sidenav" role="tablist" aria-orientation="vertical">
      {items.map((item) => (
        <button
          key={item.id || "accounts"}
          type="button"
          className="muse-sidenav-btn"
          role="tab"
          aria-selected={page === item.id}
          onClick={() => go(item.id)}
        >
          <span>{item.label}</span>
          {item.count != null ? <span className="muse-badge">{String(item.count)}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function AccountsPage({
  hosts,
  busy,
  onRefreshHosts,
  onCheck,
  onSync,
  onRemove,
}: {
  hosts: HostEntry[];
  busy: boolean;
  onRefreshHosts: () => void;
  onCheck: (hostId: string, id: string) => void;
  onSync: (hostId: string, id: string) => void;
  onRemove: (hostId: string, id: string, purge: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<MergedUsageAccount[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const accounts = useMemo(() => mergedAccounts(hosts), [hosts]);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const loadUsage = useCallback(() => {
    let settled = false;
    const failAll = (error: { code: string; message: string }) =>
      setRows(
        accountsRef.current.map((a) => ({
          id: a.id,
          label: a.label,
          usage: null,
          error,
          hosts: a.machines.map((m) => m.hostId),
        })),
      );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      failAll({ code: "usage_timeout", message: t("usageTimeout") });
    }, USAGE_TIMEOUT_MS);
    rpc.call("usage", {}).then(
      (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setRows(r.accounts);
        setUsageError(null);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = e instanceof Error ? e.message : String(e);
        failAll({ code: "usage_unavailable", message });
        setUsageError(message);
      },
    );
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [rpc]);
  useEffect(() => loadUsage(), [loadUsage]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const loading = rows === null;
  const summary = t("summaryAccounts", {
    accounts: String(uniqueAccountCount(hosts)),
    machines: String(hosts.length),
  });
  return (
    <div className="muse-content">
      <Toolbar
        title={t("pageAccountsTitle")}
        summary={summary}
        busy={busy}
        onRefresh={() => {
          setRows(null);
          onRefreshHosts();
          loadUsage();
        }}
      />
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
          loading={loading}
          busy={busy}
          onCheck={onCheck}
          onSync={onSync}
          onRemove={onRemove}
          onRetry={loadUsage}
        />
      ))}
    </div>
  );
}

function MachinesPage({
  hosts,
  busy,
  onInstall,
  onRefresh,
}: {
  hosts: HostEntry[];
  busy: boolean;
  onInstall: (hostId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="muse-content">
      <Toolbar
        title={t("pageMachinesTitle")}
        summary={t("summaryAccounts", {
          accounts: String(uniqueAccountCount(hosts)),
          machines: String(hosts.length),
        })}
        busy={busy}
        onRefresh={onRefresh}
      />
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
  const optionLabel = (h: HostEntry) =>
    !h.connected || !h.status?.chromeFound ? `${h.name} — ${t("chromeRequired")}` : h.name;
  return (
    <div className="muse-content">
      <Toolbar
        title={t("pageAddTitle")}
        summary={t("summaryAccounts", {
          accounts: String(uniqueAccountCount(hosts)),
          machines: String(hosts.length),
        })}
      />
      <div className="muse-card muse-form">
        {adding ? (
          <div className="muse-progress">
            <span className="muse-spinner" aria-hidden="true" />
            <span>{t("addInProgress", { name: selected?.name ?? hostId })}</span>
          </div>
        ) : (
          <>
            <div className="muse-field">
              <label className="muse-field-label" htmlFor="muse-add-machine">
                {t("pickMachine")}
              </label>
              <select
                id="muse-add-machine"
                className="muse-input"
                value={hostId}
                disabled={busy}
                onChange={(e) => setHostId(e.target.value)}
              >
                {hosts.map((h) => (
                  <option key={h.hostId} value={h.hostId} disabled={!h.connected || !h.status?.chromeFound}>
                    {optionLabel(h)}
                  </option>
                ))}
              </select>
            </div>
            {!selected?.status?.chromeFound ? (
              <p className="muse-muted">{t("noChromeOnHost", { names: chromeMachineNames(hosts) })}</p>
            ) : null}
            <div className="muse-field">
              <label className="muse-field-label" htmlFor="muse-add-label">
                {t("accountLabel")}
              </label>
              <div className="muse-actions">
                <input
                  id="muse-add-label"
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
            </div>
          </>
        )}
        <ol className="muse-steps">
          <li>{t("addStep1")}</li>
          <li>{t("addStep2")}</li>
          <li>{t("addStep3")}</li>
        </ol>
        {notice ? <div className={notice.kind === "ok" ? "muse-ok" : "muse-error"}>{notice.text}</div> : null}
        {notice?.kind === "ok" ? (
          <button type="button" className="muse-btn" onClick={() => nav.toPluginPanel("muse", { subPath: "" })}>
            {t("goToAccounts")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MusePanel({ subPath }: { subPath: string }) {
  useLocale();
  const page: PanelPage = subPath === "machines" || subPath === "add" ? subPath : "";
  const { rpc, hosts, error, busy, setBusy, addingHostId, setAddingHostId, notice, setNotice, mergeHosts, load, run } =
    useMuseHosts();
  return (
    <div className="muse-layout" data-bb-plugin="muse">
      <SideNav page={page} hosts={hosts} />
      <section className="muse-workspace">
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
            onRefreshHosts={load}
            onCheck={(hostId, id) => run(() => rpc.call("checkAccounts", { hostId, id }), hostId)}
            onSync={(hostId, id) => run(() => rpc.call("syncAccounts", { hostId, id }), hostId)}
            onRemove={(hostId, id, purge) => run(() => rpc.call("removeAccount", { hostId, id, purge }), hostId)}
          />
        ) : null}
        {hosts && page === "machines" ? (
          <MachinesPage
            hosts={hosts}
            busy={busy}
            onRefresh={load}
            onInstall={(hostId) => run(() => rpc.call("installRuntime", { hostId }), hostId)}
          />
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
      </section>
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

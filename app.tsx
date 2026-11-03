import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { t } from "./i18n";
import type { HostEntry, SyncRow, rpcContract } from "./server";

type AccountRow = NonNullable<HostEntry["status"]>["accounts"][number];
type HostStatus = NonNullable<HostEntry["status"]>;

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="muse-row">
      <span className="muse-row-label">{label}</span>
      <span className={bad ? "muse-text-danger" : undefined}>{value}</span>
    </div>
  );
}

function statusPill(account: AccountRow): { className: string; label: string } {
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

function AccountCard({
  account,
  busy,
  onCheck,
  onSync,
  onRemove,
}: {
  account: AccountRow;
  busy: boolean;
  onCheck: (id: string) => void;
  onSync: (id: string) => void;
  onRemove: (id: string, purge: boolean) => void;
}) {
  const [purge, setPurge] = useState(false);
  const pill = statusPill(account);
  return (
    <div className="muse-account">
      <div className="muse-account-meta">
        <div className="muse-account-name">
          <span>{account.label}</span>
          <span className={pill.className}>{pill.label}</span>
        </div>
        <div className="muse-muted">
          {account.id} · {lastUsedLabel(account.lastUsedAt)}
        </div>
      </div>
      <div className="muse-actions">
        <label className="muse-check">
          <input type="checkbox" checked={purge} disabled={busy} onChange={(e) => setPurge(e.target.checked)} />
          {t("purgeProfile")}
        </label>
        <button type="button" className="muse-btn" disabled={busy} onClick={() => onCheck(account.id)}>
          {t("check")}
        </button>
        <button type="button" className="muse-btn" disabled={busy} onClick={() => onSync(account.id)}>
          {t("copyToAll")}
        </button>
        <button
          type="button"
          className="muse-btn"
          disabled={busy}
          onClick={() => {
            if (globalThis.confirm(t("removeConfirm", { label: account.label }))) onRemove(account.id, purge);
          }}
        >
          {t("remove")}
        </button>
      </div>
    </div>
  );
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

function HostCard({
  h,
  hosts,
  busy,
  adding,
  notice,
  onCheck,
  onRemove,
  onAdd,
  onSync,
  onInstall,
}: {
  h: HostEntry;
  hosts: HostEntry[];
  busy: boolean;
  adding: boolean;
  notice: { kind: "ok" | "err"; text: string } | null;
  onCheck: (hostId: string, id?: string) => void;
  onRemove: (hostId: string, id: string, purge: boolean) => void;
  onAdd: (hostId: string, label: string) => void;
  onSync: (hostId: string, id: string) => void;
  onInstall: (hostId: string) => void;
}) {
  const [label, setLabel] = useState("");
  const st = h.status;
  if (!st) {
    const value = h.error ? `${t("noAnswer")}: ${h.error}` : h.connected ? t("noAnswer") : t("offline");
    return <Row label={h.name} value={value} bad={Boolean(h.error) || !h.connected} />;
  }
  const chromeNames = chromeMachineNames(hosts);
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
        {st.accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            busy={busy}
            onCheck={(id) => onCheck(h.hostId, id)}
            onSync={(id) => onSync(h.hostId, id)}
            onRemove={(id, purge) => onRemove(h.hostId, id, purge)}
          />
        ))}
        {st.chromeFound ? (
          adding ? (
            <div className="muse-progress">
              <span className="muse-spinner" aria-hidden="true" />
              <span>{t("addInProgress", { name: h.name })}</span>
            </div>
          ) : (
            <>
              <p className="muse-muted">{t("addHint")}</p>
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
                  disabled={busy || !label.trim()}
                  onClick={() => {
                    const next = label.trim();
                    if (!next) return;
                    onAdd(h.hostId, next);
                    setLabel("");
                  }}
                >
                  {t("addAccount")}
                </button>
                <button type="button" className="muse-btn" disabled={busy || st.accounts.length === 0} onClick={() => onCheck(h.hostId)}>
                  {t("checkAll")}
                </button>
              </div>
            </>
          )
        ) : (
          <p className="muse-muted">{t("noChromeOnHost", { names: chromeNames })}</p>
        )}
        {notice ? <div className={notice.kind === "ok" ? "muse-ok" : "muse-error"}>{notice.text}</div> : null}
      </div>
    </div>
  );
}

function MuseSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingHostId, setAddingHostId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ hostId: string; kind: "ok" | "err"; text: string } | null>(null);

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

  return (
    <div className="muse-stack" data-bb-plugin="muse">
      {error ? (
        <div className="muse-error">
          {t("error")}: {error}
        </div>
      ) : null}
      {hosts === null ? <div className="muse-muted">{t("loading")}</div> : null}
      {hosts?.map((h) => (
        <HostCard
          key={h.hostId}
          h={h}
          hosts={hosts}
          busy={busy}
          adding={addingHostId === h.hostId}
          notice={notice?.hostId === h.hostId ? notice : null}
          onAdd={(hostId, label) => {
            setAddingHostId(hostId);
            setNotice(null);
            setBusy(true);
            rpc.call("addAccount", { hostId, label }).then(
              (r) => {
                mergeHosts(r.hosts, hostId);
                setNotice({
                  hostId,
                  kind: "ok",
                  text: addSuccessText(
                    label,
                    r.synced,
                    hosts.map((entry) => r.hosts.find((n) => n.hostId === entry.hostId) ?? entry),
                  ),
                });
                setError(null);
                setAddingHostId(null);
                setBusy(false);
              },
              (e) => {
                const text = e instanceof Error ? e.message : String(e);
                setNotice({ hostId, kind: "err", text });
                setAddingHostId(null);
                setBusy(false);
              },
            );
          }}
          onCheck={(hostId, id) => run(() => rpc.call("checkAccounts", { hostId, id }), hostId)}
          onRemove={(hostId, id, purge) => run(() => rpc.call("removeAccount", { hostId, id, purge }), hostId)}
          onSync={(hostId, id) => run(() => rpc.call("syncAccounts", { hostId, id }), hostId)}
          onInstall={(hostId) => run(() => rpc.call("installRuntime", { hostId }), hostId)}
        />
      ))}
      {hosts?.length === 0 ? <div className="muse-muted">{t("hostOffline")}</div> : null}
      <div>
        <button type="button" className="muse-btn" disabled={busy} onClick={load}>
          {t("refresh")}
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "muse-accounts",
    title: t("settingsTitle"),
    description: t("settingsDescription"),
    component: MuseSettings,
  });
});

import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { t } from "./i18n";
import type { HostEntry, rpcContract } from "./server";

type AccountRow = NonNullable<HostEntry["status"]>["accounts"][number];

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

function AccountCard({
  account,
  busy,
  onCheck,
  onRemove,
}: {
  account: AccountRow;
  busy: boolean;
  onCheck: (id: string) => void;
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

function HostCard({
  h,
  busy,
  onCheck,
  onRemove,
  onAdd,
}: {
  h: HostEntry;
  busy: boolean;
  onCheck: (hostId: string, id?: string) => void;
  onRemove: (hostId: string, id: string, purge: boolean) => void;
  onAdd: (hostId: string, label: string) => void;
}) {
  const [label, setLabel] = useState("");
  const st = h.status;
  if (!st) {
    const value = h.error ? `${t("noAnswer")}: ${h.error}` : h.connected ? t("noAnswer") : t("offline");
    return <Row label={h.name} value={value} bad={Boolean(h.error) || !h.connected} />;
  }
  return (
    <div className="muse-panel">
      <div className="muse-panel-head">{h.name}</div>
      <div className="muse-panel-body">
        <Row label={t("chrome")} value={st.chromeFound ? `${t("chromeFound")}${st.chromePath ? ` (${st.chromePath})` : ""}` : t("chromeMissing")} bad={!st.chromeFound} />
        <Row label={t("bridge")} value={st.bridgeFound ? `musebridge ${st.bridgeVersion ?? "?"}` : t("bridgeMissing")} bad={!st.bridgeFound} />
        <Row label={t("agent")} value={st.agentFound ? t("agentFound") : t("agentMissing")} bad={!st.agentFound} />
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
            onRemove={(id, purge) => onRemove(h.hostId, id, purge)}
          />
        ))}
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
      </div>
    </div>
  );
}

function MuseSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          busy={busy}
          onAdd={(hostId, label) => run(() => rpc.call("addAccount", { hostId, label }), hostId)}
          onCheck={(hostId, id) => run(() => rpc.call("checkAccounts", { hostId, id }), hostId)}
          onRemove={(hostId, id, purge) => run(() => rpc.call("removeAccount", { hostId, id, purge }), hostId)}
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

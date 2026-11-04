// UI strings follow BB's interface language (`<html lang>`); English by default.

const en = {
  settingsTitle: "Muse accounts",
  settingsDescription: "Chrome, the bridge, and each Muse account on this machine.",
  settingsSummary: "{accounts} accounts · {machines} machines",
  openMusePanel: "Open Muse panel",
  navAccounts: "Accounts",
  navMachines: "Machines",
  navAdd: "Add account",
  pageAccountsTitle: "Accounts",
  pageMachinesTitle: "Machines",
  pageAddTitle: "Add account",
  summaryAccounts: "{accounts} accounts · {machines} machines",
  usagePlan: "Plan {name}",
  usageResets: "Limit resets {when}",
  usageExtraTokens: "Extra tokens: {value}",
  extraTokensUsed: "{n}% used",
  usageUnavailable: "Limit unavailable: {reason}",
  usageUnavailableLabel: "Limit unavailable",
  usageTimeout: "Timed out while reading the limit",
  usageUsed: "{n}% used",
  usageUnlimited: "Unlimited",
  usageParallel: "Parallel chats: {n}",
  usageLoading: "Loading limits…",
  usageNotRead: "Limit not read",
  weeklyUsed: "{n}% of weekly limit",
  retry: "Retry",
  accountOnMachines: "Machines: {names}",
  refreshLimits: "Refresh limits",
  busySlots: "{busy}/{max}",
  goToAccounts: "Go to Accounts",
  addStep1: "1. Choose a machine that has Google Chrome.",
  addStep2: "2. Enter a label for the account.",
  addStep3: "3. Sign in to Muse in the Chrome window that opens and wait until the status is signed in.",
  chromeRequired: "Chrome is not installed on this machine.",
  pickMachine: "Machine",
  accountLabel: "Account label",
  chrome: "Google Chrome",
  chromeFound: "found",
  chromeMissing: "not found",
  bridge: "Bridge",
  bridgeMissing: "musebridge not installed",
  agent: "Agent",
  agentFound: "muse-acp on PATH",
  agentMissing: "muse-acp not on PATH",
  runtime: "Connector",
  runtimeInstalled: "Connector v{version} installed",
  runtimeInstalling: "Installing…",
  runtimeMissing: "Not installed",
  runtimeUnsupported: "This OS is not supported",
  install: "Install",
  connected: "connected",
  accounts: "Accounts",
  emptyAccounts: "No Muse accounts yet",
  addHint: "A Chrome window opens so you can sign in to Muse. Leave it open until the status turns signed in.",
  labelPlaceholder: "Label, e.g. Work",
  addAccount: "Add account",
  addInProgress:
    "A Chrome window opened on {name}. Sign in to Muse there — this updates by itself. You have up to 10 minutes.",
  addSuccess: "{label} is signed in and copied to {count} machines",
  addSyncFailed: "Failed on {names}",
  noChromeOnHost:
    "No Chrome on this machine. Add the account on a machine with Chrome ({names}) — it is copied here automatically.",
  check: "Check",
  checkAll: "Check all",
  copyToAll: "Copy to all machines",
  signInAgain: "Sign in again",
  reloginInProgress: "Opened a sign-in window on {name}: sign in to Muse…",
  reloginOk: "Signed in and copied to {count} machines",
  reloginPartial: "Signed in, but not copied to: {names} ({error})",
  noChromeMachine: "A machine with Google Chrome is required",
  remove: "Remove",
  purgeProfile: "Delete Chrome profile",
  removeConfirm: "Remove account {label}?",
  confirmRemove: "Remove {label}?",
  confirm: "Confirm",
  cancel: "Cancel",
  statusSignedIn: "signed in",
  statusSignedOut: "signed out",
  statusUnknown: "unknown",
  statusBusy: "busy",
  lastUsed: "Last used {when}",
  neverUsed: "not used yet",
  loading: "Checking Muse on your machines…",
  offline: "offline",
  noAnswer: "no answer",
  error: "Error",
  refresh: "Refresh",
  hostOffline: "This machine is offline.",
};

export type I18nKey = keyof typeof en;

const ru: Record<I18nKey, string> = {
  settingsTitle: "Аккаунты Muse",
  settingsDescription: "Chrome, мост и каждый аккаунт Muse на этой машине.",
  settingsSummary: "{accounts} аккаунтов · {machines} машин",
  openMusePanel: "Открыть панель Muse",
  navAccounts: "Аккаунты",
  navMachines: "Машины",
  navAdd: "Добавить аккаунт",
  pageAccountsTitle: "Аккаунты",
  pageMachinesTitle: "Машины",
  pageAddTitle: "Добавить аккаунт",
  summaryAccounts: "{accounts} аккаунта · {machines} машины",
  usagePlan: "Тариф {name}",
  usageResets: "Сброс лимита: {when}",
  usageExtraTokens: "Доп. токены: {value}",
  extraTokensUsed: "{n}% использовано",
  usageUnavailable: "Лимит недоступен: {reason}",
  usageUnavailableLabel: "Лимит недоступен",
  usageTimeout: "Время чтения лимита вышло",
  usageUsed: "использовано {n}%",
  usageUnlimited: "Без лимита",
  usageParallel: "Параллельные чаты: {n}",
  usageLoading: "Загружаем лимиты…",
  usageNotRead: "Лимит не прочитан",
  weeklyUsed: "{n}% недельного лимита",
  retry: "Повторить",
  accountOnMachines: "Машины: {names}",
  refreshLimits: "Обновить лимиты",
  busySlots: "{busy}/{max}",
  goToAccounts: "К аккаунтам",
  addStep1: "1. Выберите машину с Google Chrome.",
  addStep2: "2. Введите подпись аккаунта.",
  addStep3: "3. Войдите в Muse в открывшемся окне Chrome и дождитесь статуса «вошёл».",
  chromeRequired: "На этой машине нет Chrome.",
  pickMachine: "Машина",
  accountLabel: "Подпись аккаунта",
  chrome: "Google Chrome",
  chromeFound: "найден",
  chromeMissing: "не найден",
  bridge: "Мост",
  bridgeMissing: "musebridge не установлен",
  agent: "Агент",
  agentFound: "muse-acp в PATH",
  agentMissing: "muse-acp нет в PATH",
  runtime: "Коннектор",
  runtimeInstalled: "Коннектор v{version} установлен",
  runtimeInstalling: "Устанавливаю…",
  runtimeMissing: "Не установлен",
  runtimeUnsupported: "Эта ОС не поддерживается",
  install: "Установить",
  connected: "на связи",
  accounts: "Аккаунты",
  emptyAccounts: "Пока нет аккаунтов Muse",
  addHint: "Откроется окно Chrome, чтобы войти в Muse. Не закрывайте его, пока статус не станет «вошёл».",
  labelPlaceholder: "Подпись, например Работа",
  addAccount: "Добавить аккаунт",
  addInProgress:
    "На {name} открылось окно Chrome. Войдите в Muse там — статус обновится сам. Есть до 10 минут.",
  addSuccess: "{label} вошёл и скопирован на {count} машин",
  addSyncFailed: "Не вышло на {names}",
  noChromeOnHost:
    "На этой машине нет Chrome. Добавьте аккаунт на машине с Chrome ({names}) — он скопируется сюда сам.",
  check: "Проверить",
  checkAll: "Проверить все",
  copyToAll: "Скопировать на все машины",
  signInAgain: "Войти заново",
  reloginInProgress: "Открыли окно входа на {name}: войдите в Muse…",
  reloginOk: "Вход выполнен, скопирован на {count} машин",
  reloginPartial: "Вход выполнен, но не скопирован на: {names} ({error})",
  noChromeMachine: "Нужна машина с Google Chrome",
  remove: "Удалить",
  purgeProfile: "Удалить профиль Chrome",
  removeConfirm: "Удалить аккаунт {label}?",
  confirmRemove: "Удалить {label}?",
  confirm: "Подтвердить",
  cancel: "Отмена",
  statusSignedIn: "вошёл",
  statusSignedOut: "не вошёл",
  statusUnknown: "неизвестно",
  statusBusy: "занят",
  lastUsed: "Последний раз {when}",
  neverUsed: "ещё не использовался",
  loading: "Проверяю Muse на ваших машинах…",
  offline: "не в сети",
  noAnswer: "нет ответа",
  error: "Ошибка",
  refresh: "Обновить",
  hostOffline: "Эта машина не в сети.",
};

export type Locale = "en" | "ru";

const CYRILLIC = /[\u0400-\u04FF]/;
const SIDEBAR_LABELS = '[data-sidebar="sidebar"] button[aria-label], header button[aria-label]';

function ruPluginEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("bb-plugin-ru:enabled") !== "off";
  } catch {
    return true;
  }
}

function hasCyrillicSidebar(): boolean {
  try {
    const nodes = globalThis.document?.querySelectorAll?.(SIDEBAR_LABELS);
    if (!nodes) return false;
    const limit = Math.min(12, nodes.length);
    for (let i = 0; i < limit; i++) {
      const label = nodes[i]?.getAttribute?.("aria-label") ?? "";
      if (CYRILLIC.test(label)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function detectLocale(): Locale {
  try {
    const el = globalThis.document?.documentElement;
    if (!el) return "en";
    const lang = (el.lang ?? "").toLowerCase();
    if (lang.startsWith("ru")) return "ru";
    const pk = (el.getAttribute?.("data-pk-lang") ?? "").toLowerCase();
    if (pk === "ru" || pk.startsWith("ru")) return "ru";
    if (ruPluginEnabled() && hasCyrillicSidebar()) return "ru";
  } catch {
    return "en";
  }
  return "en";
}

export function t(key: I18nKey, vars?: Record<string, string>, locale: Locale = detectLocale()): string {
  let text = (locale === "ru" ? ru : en)[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

export type ReloginSummary = { kind: "ok" | "err"; text: string };

export function reloginSummary(
  synced: Array<{ ok: boolean; hostId: string; error: string | null }>,
  hosts: Array<{ hostId: string; name: string }>,
  locale: Locale = "en",
): ReloginSummary {
  const failed = synced.filter((row) => !row.ok);
  if (failed.length === 0) {
    return {
      kind: "ok",
      text: t("reloginOk", { count: String(synced.filter((row) => row.ok).length) }, locale),
    };
  }
  const names = failed.map((row) => hosts.find((h) => h.hostId === row.hostId)?.name ?? row.hostId).join(", ");
  const error = failed.find((row) => row.error)?.error ?? "";
  return {
    kind: "err",
    text: t("reloginPartial", { names, error }, locale),
  };
}

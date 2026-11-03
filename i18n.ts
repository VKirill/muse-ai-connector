// UI strings follow BB's interface language (`<html lang>`); English by default.

const en = {
  settingsTitle: "Muse accounts",
  settingsDescription: "Chrome, the bridge, and each Muse account on this machine.",
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
  remove: "Remove",
  purgeProfile: "Delete Chrome profile",
  removeConfirm: "Remove account {label}?",
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
  refresh: "Check again",
  hostOffline: "This machine is offline.",
};

export type I18nKey = keyof typeof en;

const ru: Record<I18nKey, string> = {
  settingsTitle: "Аккаунты Muse",
  settingsDescription: "Chrome, мост и каждый аккаунт Muse на этой машине.",
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
  remove: "Удалить",
  purgeProfile: "Удалить профиль Chrome",
  removeConfirm: "Удалить аккаунт {label}?",
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
  refresh: "Проверить снова",
  hostOffline: "Эта машина не в сети.",
};

export type Locale = "en" | "ru";

export function detectLocale(): Locale {
  const lang = globalThis.document?.documentElement?.lang ?? "";
  return lang.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function t(key: I18nKey, vars?: Record<string, string>, locale: Locale = detectLocale()): string {
  let text = (locale === "ru" ? ru : en)[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

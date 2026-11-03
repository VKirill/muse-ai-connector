---
title: Muse AI connector
date: 2026-11-02
---

# Muse AI connector

**Muse as a BB provider.** Pick Muse in a BB chat and the prompt runs in a Muse side chat of one of your signed-in accounts. The reply streams back into BB. You sign in once per account in a Chrome window the connector opens.

Licence: Apache-2.0. Requires Node 22+, Google Chrome, and BB with plugin SDK >= 0.6.49.

Русская версия: [ниже](#по-русски).

## Install

```sh
git clone https://github.com/VKirill/muse-ai-connector.git
cd muse-ai-connector
npm install
npm link
bb plugin install .
```

`npm link` puts `musebridge` and `muse-acp` on your PATH (usually `~/.local/bin` or the npm global bin). The BB host daemon must see those commands. If it does not, set the plugin setting **Agent command** to the full path of `muse-acp`.

Check: `musebridge doctor`, or BB Settings → Plugins → Muse.

## Accounts

Open BB Settings → Plugins → Muse. The screen lists each connected machine: Chrome, `musebridge` version, whether `muse-acp` is on PATH, and every Muse account.

- **Add account** — type a label and press the button. A Chrome window opens on that machine. Sign in to Muse and leave the window until the status becomes signed in.
- **Check** — refreshes signed-in / signed-out for one account (or **Check all**).
- **Remove** — drops the account from the registry. Tick **Delete Chrome profile** to also wipe `~/.muse-bridge/profiles/<id>/`.
- A **busy** pill means that account is running a prompt; wait, then check again.

State lives in `~/.muse-bridge/` (`MUSE_BRIDGE_HOME` overrides it): `accounts.json`, per-account Chrome profiles, `accounts/<id>/cookies.json` (mode 0600), and locks. Cookie and token values are never logged. `musebridge` talks to Muse over the stored cookies by default (`--transport api`); Chrome is used to sign in, to run `accounts refresh <id>`, or when `--transport browser` / `MUSE_TRANSPORT=browser` is set. Missing cookies or HTTP 401/403 fall back to Chrome.

The screen follows the BB interface language (English or Russian).

## CLI

```sh
musebridge doctor [--account <id>]
musebridge accounts list [--json]
musebridge accounts add <label>
musebridge accounts check [<id>]
musebridge accounts refresh <id>
musebridge accounts remove <id> [--purge]
musebridge chats [--account <id>] [--transport api|browser] [--json]
musebridge history [--account <id>] [--transport api|browser] <chatId> [--json]
musebridge send [--account <id>] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>
musebridge approve [--account <id>] --chat <id>
musebridge login
muse-acp                          # ACP agent on stdio (BB launches this)
```

`accounts list --json` includes `locked` when a prompt holds that account.

When Muse shows an approval card («Allow Muse to …?») in a chat the connector drives, the connector answers **Always allow** itself and keeps waiting — `send` no longer stalls on the card. Cards about money (a purchase, a payment, a subscription) are never touched; the reply notes «Muse asks for approval» and waits for you to answer in Muse. `musebridge approve --chat <id>` answers pending cards in an existing chat. `send --timeout <sec>` sets the reply timeout (default 180).

## Limits

This is a UI-driven connector. It breaks when Muse changes its page or the `hatch-chat-cache` schema (schemaVersion 4 is checked; a mismatch is a clear error). One Chrome profile per account; accounts can run in parallel, one prompt at a time per account. Google Chrome is required (`channel: "chrome"`). Headless is the default for chats; add-account always opens a visible window. Muse has no reasoning knob: BB reasoning levels (`none` / `low` / `medium` / `high`) are accepted so the composer does not fail, and the agent ignores them.

## По-русски

Плагин ставит Muse провайдером в BB: сообщение из чата уходит в боковой чат Muse на одном из ваших аккаунтов, ответ возвращается потоком. Вход — один раз на аккаунт, в окне Chrome.

**Установка:** клонировать репозиторий, `npm install`, `npm link`, `bb plugin install .`. Команды `musebridge` и `muse-acp` должны быть в PATH хост-демона BB; иначе в настройках плагина укажите полный путь к `muse-acp`.

**Аккаунты** (Настройки → Плагины → Muse): видно Chrome, мост, агент и список аккаунтов. «Добавить аккаунт» открывает Chrome для входа. «Проверить» обновляет статус. «Удалить» снимает запись; галочка «Удалить профиль Chrome» ещё и стирает каталог профиля. «Занят» значит, что на аккаунте сейчас идёт запрос.

**CLI:** `musebridge doctor`, `accounts list|add|check|refresh|remove`, `chats`, `history`, `send` (флаги `--timeout <сек>`, `--transport api|browser`; по умолчанию api и 180 с), `approve`, `login`. У `list --json` есть поле `locked`. Chrome нужен для входа и как запасной транспорт.

Когда Muse показывает карточку одобрения («Разрешить Muse …?») в чате, которым управляет коннектор, коннектор сам отвечает «Всегда разрешать». Карточки про деньги (покупка, оплата, подписка) не трогаются — ответ помечается «Muse asks for approval» и ждёт вашего решения в Muse. `musebridge approve --chat <id>` отвечает на ожидающие карточки в существующем чате.

**Ограничения:** управление через интерфейс сайта; смена вёрстки Muse или схемы кэша (проверяется schemaVersion 4) ломает шаг. Один профиль Chrome на аккаунт; параллельно несколько аккаунтов, но один запрос на аккаунт. Нужен Google Chrome. У Muse нет переключателя рассуждения: уровни BB принимаются, чтобы композитор не падал, и агент их игнорирует.

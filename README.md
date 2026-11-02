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

State lives in `~/.muse-bridge/` (`MUSE_BRIDGE_HOME` overrides it): `accounts.json`, per-account Chrome profiles, and locks. Cookies and tokens are never copied or logged.

The screen follows the BB interface language (English or Russian).

## CLI

```sh
musebridge doctor [--account <id>]
musebridge accounts list [--json]
musebridge accounts add <label>
musebridge accounts check [<id>]
musebridge accounts remove <id> [--purge]
musebridge chats [--account <id>] [--json]
musebridge history [--account <id>] <chatId> [--json]
musebridge send [--account <id>] [--chat <id>] [--headed] [--json] <text>
musebridge login
muse-acp                          # ACP agent on stdio (BB launches this)
```

`accounts list --json` includes `locked` when a prompt holds that account.

## Limits

This is a UI-driven connector. It breaks when Muse changes its page or the `hatch-chat-cache` schema (schemaVersion 4 is checked; a mismatch is a clear error). One Chrome profile per account; accounts can run in parallel, one prompt at a time per account. Google Chrome is required (`channel: "chrome"`). Headless is the default for chats; add-account always opens a visible window.

## По-русски

Плагин ставит Muse провайдером в BB: сообщение из чата уходит в боковой чат Muse на одном из ваших аккаунтов, ответ возвращается потоком. Вход — один раз на аккаунт, в окне Chrome.

**Установка:** клонировать репозиторий, `npm install`, `npm link`, `bb plugin install .`. Команды `musebridge` и `muse-acp` должны быть в PATH хост-демона BB; иначе в настройках плагина укажите полный путь к `muse-acp`.

**Аккаунты** (Настройки → Плагины → Muse): видно Chrome, мост, агент и список аккаунтов. «Добавить аккаунт» открывает Chrome для входа. «Проверить» обновляет статус. «Удалить» снимает запись; галочка «Удалить профиль Chrome» ещё и стирает каталог профиля. «Занят» значит, что на аккаунте сейчас идёт запрос.

**CLI:** `musebridge doctor`, `accounts list|add|check|remove`, `chats`, `history`, `send`, `login`. У `list --json` есть поле `locked`.

**Ограничения:** управление через интерфейс сайта; смена вёрстки Muse или схемы кэша (проверяется schemaVersion 4) ломает шаг. Один профиль Chrome на аккаунт; параллельно несколько аккаунтов, но один запрос на аккаунт. Нужен Google Chrome.

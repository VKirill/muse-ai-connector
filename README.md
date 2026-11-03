---
title: Muse AI connector
date: 2026-11-03
---

# Muse AI connector

**Muse as a BB provider.** Muse (muse.ai) is Meta's personal assistant; every account runs on its
own cloud VM. This connector registers Muse as a provider in BB: pick **Muse** in a chat and your
prompt runs in a Muse side chat on one of your signed-in accounts, with local tools, MCP servers
and skills — the reply streams back into BB. Sign-in happens once per account in a Chrome window
the connector opens.

Licence: Apache-2.0. Requires Node 22+, npm, and Google Chrome on at least one connected machine
(macOS or Linux). Unofficial connector: it drives Muse the same way the muse.ai web app does.

Русская версия: [ниже](#по-русски).

## How it works

```
BB chat ──ACP──▶ muse-acp (on the BB machine)
                    │  picks a free account slot, sends the prompt, runs tools locally
                    ▼
                musebridge client
                    │  api transport (default): the account's cookies
                    ▼
        HTTPS muse.ai/api/hatch/*  →  vm_id, gateway url, auth_token (+ notary token)
                    ▼
   WSS wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&app_id=hatch-web
                    │  Noise_XX_25519_AESGCM_SHA256 encrypted channel
                    ▼
        the user's Muse cloud VM — HTTP-like calls inside the tunnel:
        /api/nodes/register · /api/ping · /api/session/list
        /chat/stream · /chat/subscribe · /chat/history
```

- **The API transport is the default.** The connector bootstraps over HTTPS with the account's
  cookies, opens the Noise-encrypted WebSocket to the VM and sends/receives chat inside it.
  No Chrome is needed per message.
- **Chrome is the sign-in and fallback transport.** Adding or refreshing an account drives a real
  Chrome (`playwright-core`, channel `chrome`) with a per-account persistent profile; the fallback
  reads the page's `hatch-chat-cache` IndexedDB (schemaVersion 4 is checked) and the page busy
  signal. Missing cookies or HTTP 401/403 on the API path fall back to Chrome.
- **The BB host runs the ACP agent.** BB launches `muse-acp` (via the runtime shim at
  `~/.muse-bridge/bin/muse-acp`, or the **Agent command** plugin setting). It speaks ACP on stdio,
  maps each BB session to a Muse side chat, and executes Muse's tool calls on the machine.
- **Settings screen:** BB Settings → Plugins → Muse lists every connected machine — connector
  runtime, Chrome, agent — and the shared account list. The screen follows the BB interface
  language (English or Russian).

## Install

1. Install the plugin in BB from the git source `VKirill/muse-ai-connector`
   (Settings → Plugins → install from git). For a local checkout: `bb plugin install .`
2. Open BB Settings → Plugins → Muse. On each connected machine the connector runtime installs
   itself automatically in the background: a versioned checkout under
   `~/.muse-bridge/runtime/<version>/` with `~/.muse-bridge/runtime/current` pointing at the
   active one, plus `musebridge` and `muse-acp` shims in `~/.muse-bridge/bin/`. Old versions
   beyond the last two are removed. The **Install** button retries a failed install.
   Windows is not supported for self-install.
3. On a machine **with Chrome**, type a label and press **Add account**. A Chrome window opens;
   sign in to Muse and leave the window open until the status turns signed in (up to ~10 minutes).
   The account's cookies are then copied to every connected machine that has a runtime, including
   headless servers.
4. Pick **Muse** as the provider in any chat on any of those machines.

Check a machine manually with `musebridge doctor`.

## Accounts

State lives in `~/.muse-bridge/` (`MUSE_BRIDGE_HOME` overrides it): `accounts.json`, per-account
Chrome profiles under `profiles/<id>/`, `accounts/<id>/cookies.json` (mode 0600), slot locks under
`locks/`, and `sessions.json` (BB session → Muse chat mapping). Cookie and token values are never
logged; during account sync they travel host → hub memory → host and are never stored on the hub.

- **Add account** — on a machine with Chrome; see Install above. A machine without Chrome shows
  which machines have it: add the account there and it is copied over automatically.
- **Check / Check all** — refreshes the signed-in status.
- **Copy to all machines** — pushes the account's cookies to every other connected host.
- **Remove** — drops the account from the registry; tick **Delete Chrome profile** to also wipe
  `profiles/<id>/`.
- **Refresh** — `musebridge accounts refresh <id>` re-exports cookies from the signed-in Chrome
  profile without signing in again. Re-login is needed roughly monthly or after a Meta checkpoint.
- **Machines outside BB** can receive the cookies over ssh: `musebridge sync targets add <name>`,
  then `musebridge sync` (or it runs automatically after add/refresh).

### Parallel slots

Each account serves `maxParallel` chats at once — default 1, allowed 1–50:

```sh
musebridge accounts set <id> --max-parallel <n>
```

`accounts list` shows `busy/max` per account; a fully busy account shows a **busy** pill in
settings. `MUSE_MAX_PARALLEL` sets the default for accounts without an explicit value. Slot locks
under `~/.muse-bridge/locks/` are reclaimed when the holder's process dies or the lock is older
than 30 minutes. When several signed-in accounts are free, the connector picks the one with the
fewest busy slots, then the least recently used — parallel work spreads across accounts.

## The agent in BB chats

`muse-acp` speaks ACP: BB starts it per machine and it maps each BB session to a Muse side chat
(kept in `sessions.json`). Muse cannot call our tools natively, so the agent runs a text protocol:
the first message of a Muse chat tells Muse it works inside the workspace `<cwd>` and may end a
reply with exactly one ```` ```muse-tool ```` fenced block `{"tool":"<name>","args":{...}}`. The
agent runs the tool on the machine and sends the result back as `TOOL RESULT <name> (ok|error)`;
the reply continues until Muse ends its final answer with a `[[done]]` line.

- **Local tools:** `read_file`, `write_file`, `edit_file` (exact unique match), `list_dir`,
  `grep`, `bash` (`/bin/bash -lc` in the workspace, default 120 s, max 600 s), `tool_schema`.
  Paths resolve inside the session workspace — anything outside is refused; tool output is
  capped at ~20 KB. When the client announces `fs.readTextFile`/`fs.writeTextFile`, file reads
  and writes go through the ACP client so BB sees the edits.
- **MCP servers** the chat passes in `session/new` (stdio, or streamable HTTP) are started and
  exposed as `mcp__<server>__<tool>`; `tool_schema` returns any tool's input schema. A server
  that fails to start is skipped, the rest work.
- **Skills:** `list_skills {query?}` / `read_skill {name}` scan `SKILL.md` front matter in
  `MUSE_SKILL_DIRS` (colon-separated; default `<cwd>/.claude/skills`, `<cwd>/.agents/skills`,
  `~/.claude/skills`, `~/.agents/skills`, `~/.bb/skills`).
- **BB rules** from the system block (project instructions, the owner's rules, the language
  section) are forwarded to Muse, capped at 16 KB; plugin manuals and skills catalogues are not.
- A reply with neither a tool block nor `[[done]]` is nudged once; at most `MUSE_MAX_TOOL_ROUNDS`
  (default 60) rounds run per prompt, then the turn ends with a note. `session/cancel` stops the
  loop between rounds; when a send was in flight, the rest of the interrupted reply is pulled
  from history on the next prompt (`MUSE_PENDING_WAIT_MS`, default 30 s).
- **Approval cards.** When Muse shows «Allow Muse to …?», the connector answers **Always allow**
  itself and keeps waiting. Cards about money (purchase, payment, subscription) are never
  touched — the reply notes «Muse asks for approval» and waits for you in Muse;
  `musebridge approve --chat <id>` answers pending cards in an existing chat.
- **Models:** `muse-spark` (Muse Spark, default) keeps the tool loop. **Muse Image** (`muse-image`)
  prefixes only the first message (or a later one that starts with a form factor `16:9 кот` /
  `[4:5] cat`) as `Create image format: <W:H>. …` or `Create image. …`. Other follow-ups go to the
  same Muse chat as typed. No tools intro. The agent saves new pictures under
  `<workspace>/muse-images/` and sends each one back as an image content block plus the relative
  path. Muse has no reasoning knob: BB reasoning levels are accepted so the composer does not fail,
  and the agent ignores them.

## CLI reference

```sh
musebridge doctor [--account <id>]          # check Chrome, the profile directory, and sign-in
musebridge chats [--account <id>] [--transport api|browser] [--json]
                                            # list side chats
musebridge history [--account <id>] [--transport api|browser] <chatId> [--json]
                                            # show a chat transcript
musebridge send [--account <id>] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>
                                            # send a message and print the reply
musebridge image [--account <id>] [--format W:H] [--out dir] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--json] <prompt>
                                            # first call returns chatId; pass --chat <id> to keep editing in the same chat
musebridge approve [--account <id>] --chat <id>
                                            # answer pending approval cards (Always allow;
                                            # cards about money are left to you)
musebridge accounts list [--json]           # list Muse accounts (busy/max slots, locked)
musebridge accounts add <label>             # register an account and open a sign-in window
musebridge accounts remove <id> [--purge]   # remove an account from the registry
musebridge accounts check [<id>]            # refresh signed-in status
musebridge accounts refresh <id>            # export cookies from the signed-in Chrome profile
musebridge accounts import [<id>] [--label <label>]
                                            # import a cookies JSON array or an export object from stdin
musebridge accounts export <id> --json      # print {id, label, cookies} (host RPC only)
musebridge accounts set <id> --max-parallel <n>
                                            # how many chats the account serves at once (1..50)
musebridge sync targets add <name>          # add an ssh host that receives refreshed cookies
musebridge sync targets remove <name>       # remove an ssh sync target
musebridge sync targets list                # show the ssh sync targets
musebridge sync [--account <id>]            # push saved cookies to every sync target
musebridge login                            # sign in (adds account "default" when none exist)
musebridge --help                           # show the help text
muse-acp                                    # ACP agent on stdio (BB launches this)
```

Environment variables the code reads:

| Variable | Default | Effect |
|---|---|---|
| `MUSE_TRANSPORT` | `api` | `browser` forces the Chrome transport |
| `MUSE_REPLY_TIMEOUT_SEC` | `180` | reply wait per send (plugin setting **Reply timeout**) |
| `MUSE_MAX_TOOL_ROUNDS` | `60` | max tool round trips per prompt |
| `MUSE_MAX_PARALLEL` | `1` | default `maxParallel` for accounts without an explicit value |
| `MUSE_SKILL_DIRS` | see above | colon-separated extra skill roots |
| `MUSE_HEADLESS` | `1` | `0`/`false` shows the Chrome window (plugin setting **Headless Chrome**) |
| `MUSE_PENDING_WAIT_MS` | `30000` | how long to pull the tail of an interrupted reply |
| `MUSE_ACP_DUMP_PROMPT` | off | append every prompt sent to Muse to this file (debug) |
| `MUSE_BRIDGE_HOME` | `~/.muse-bridge` | state directory |
| `MUSE_RUNTIME_DEV` | off | path to a dev checkout the shims run instead of the runtime |

## Measured behaviour

On 2026-11-03, on the API transport: ~6 s round trip for a short message; 40 parallel short chats
on one account completed without errors; 10 parallel agent tasks (tool-loop sessions) on one
account all finished.

## Limits and risks

- **Unofficial connector.** It speaks the same protocol the muse.ai web app uses; Meta can change
  the page, the cache schema (`schemaVersion` 4 is checked and a mismatch is a clear error) or the
  VM protocol at any time.
- The **Noise server identity is not verified** yet — the channel is encrypted, and the connector
  prints a warning to stderr.
- **One account = one Muse cloud VM.** Parallel slots share that VM; `maxParallel` multiplies
  load on it.
- Meta may ask to re-confirm sign-in (checkpoint), more likely when the same account's session is
  used from several IPs/machines.
- Google Chrome is required to sign in and for the fallback transport; headless is the default
  for chat runs, add-account always opens a visible window.
- The runtime self-install needs Node 22+ and npm reachable from the BB host daemon; Windows is
  not supported.
- User-attached image and audio prompts are not supported (`promptCapabilities`: text only).
  Generated pictures come back from the **Muse Image** model and `musebridge image`.

## Troubleshooting

- **Muse is missing in the provider picker of a machine** — open BB Settings → Plugins → Muse and
  look at that machine's row: the Connector line shows installed/installing/not installed. Press
  **Install** if needed, then give BB a few minutes — provider lists are cached.
- **"No signed-in Muse account"** — press **Check** in settings; if the account is signed out,
  sign in again with **Add account** (or `musebridge accounts refresh <id>` when the Chrome
  profile is still valid).
- **"All Muse accounts are busy"** — wait, raise `maxParallel`, or add another account.
- **Runtime install failed** — the settings row shows the error tail (download, `tar`, or
  `npm install --omit=dev`). Fix Node/npm/network for the host daemon and press **Install**.
- **`musebridge`/`muse-acp` not found on a machine** — the runtime shims in `~/.muse-bridge/bin/`
  are tried first; to force a different agent set the plugin setting **Agent command** to the
  full path of `muse-acp`.
- **A money approval card pauses the chat** — answer it in Muse itself, or run
  `musebridge approve --account <id> --chat <id>` for the remaining cards.

## Development

Layout: `server.ts` — hub-side plugin entry (provider, RPC, account sync orchestration);
`host.ts` — per-machine host entry (status, runtime install, account actions); `app.tsx` +
`i18n.ts` — the settings screen (EN/RU); `bin/` — `musebridge` CLI and `muse-acp` agent;
`bridge/` — shared plain-ESM modules (`protocol/` — HTTPS bootstrap, Noise handshake, envelope,
ndjson; transports, accounts, tools, MCP, skills, hub sync, runtime install); `tests/` —
`node:test` suites; `bench/` — the DeepSWE pilot kit.

```sh
npm test          # node --test tests/*.test.mjs
npm run typecheck # tsc --noEmit
```

Tests use a fake Muse driver: `MUSE_BRIDGE_FAKE=1`, `MUSE_BRIDGE_FAKE_SCRIPT=<json>` (replies
returned in order), `MUSE_BRIDGE_FAKE_SENT=<file>` (logs sent messages). `runtime-install`
accepts `dir:<path>` as a source for local installs.

## По-русски

**Muse провайдером в BB.** Muse (muse.ai) — персональный ассистент Meta; у каждого аккаунта своя
облачная VM. Коннектор регистрирует Muse как провайдера в BB: выбираете **Muse** в чате — промпт
уходит в боковой чат Muse на одном из ваших аккаунтов, с локальными инструментами, MCP-серверами
и скиллами, а ответ стримится обратно в BB. Вход — один раз на аккаунт в окне Chrome, которое
открывает коннектор.

Лицензия: Apache-2.0. Нужны Node 22+, npm и Google Chrome хотя бы на одной подключённой машине
(macOS или Linux). Коннектор неофициальный: он управляет Muse так же, как веб-приложение muse.ai.

### Как это устроено

```
Чат BB ──ACP──▶ muse-acp (на машине BB)
                    │  выбирает свободный слот аккаунта, отправляет промпт, выполняет инструменты локально
                    ▼
                клиент musebridge
                    │  api-транспорт (по умолчанию): куки аккаунта
                    ▼
        HTTPS muse.ai/api/hatch/*  →  vm_id, адрес шлюза, auth_token (+ notary token)
                    ▼
   WSS wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&app_id=hatch-web
                    │  зашифрованный канал Noise_XX_25519_AESGCM_SHA256
                    ▼
        облачная Muse VM пользователя — HTTP-подобные вызовы внутри туннеля:
        /api/nodes/register · /api/ping · /api/session/list
        /chat/stream · /chat/subscribe · /chat/history
```

- **API-транспорт — по умолчанию.** Коннектор по кукам аккаунта проходит HTTPS-бутстрап, открывает
  зашифрованный Noise WebSocket к VM и гоняет чат внутри него. Chrome на каждое сообщение не нужен.
- **Chrome — вход и запасной транспорт.** Добавление и обновление аккаунта управляет настоящим
  Chrome (`playwright-core`, канал `chrome`) с постоянным профилем на аккаунт; запасной путь читает
  IndexedDB `hatch-chat-cache` страницы (проверяется schemaVersion 4) и признак занятости. Нет кук
  или HTTP 401/403 на API-пути — переход на Chrome.
- **Хост BB запускает ACP-агента.** BB стартует `muse-acp` (через шим `~/.muse-bridge/bin/muse-acp`
  или настройку **Agent command**). Агент говорит ACP по stdio, связывает сессию BB с боковым чатом
  Muse и выполняет вызовы инструментов на машине.
- **Экран настроек:** Настройки BB → Плагины → Muse показывает каждую подключённую машину —
  рантайм коннектора, Chrome, агент — и общий список аккаунтов. Язык экрана следует языку
  интерфейса BB (English или Русский).

### Установка

1. Установите плагин в BB из git-источника `VKirill/muse-ai-connector`
   (Настройки → Плагины → установить из git). Для локальной копии: `bb plugin install .`
2. Откройте Настройки → Плагины → Muse. На каждой подключённой машине рантайм коннектора ставится
   сам в фоне: версионная копия в `~/.muse-bridge/runtime/<version>/` с ссылкой
   `~/.muse-bridge/runtime/current` на активную, плюс шимы `musebridge` и `muse-acp` в
   `~/.muse-bridge/bin/`. Старые версии сверх последних двух удаляются. Кнопка **Установить**
   повторяет упавшую установку. Windows не поддерживается.
3. На машине **с Chrome** введите подпись и нажмите **Добавить аккаунт**. Откроется окно Chrome;
   войдите в Muse и не закрывайте его, пока статус не станет «вошёл» (до ~10 минут). Куки аккаунта
   затем копируются на каждую подключённую машину с рантаймом, включая серверы без дисплея.
4. Выберите **Muse** провайдером в любом чате на любой из этих машин.

Проверить машину вручную: `musebridge doctor`.

### Аккаунты

Состояние лежит в `~/.muse-bridge/` (переопределяется `MUSE_BRIDGE_HOME`): `accounts.json`,
профили Chrome по аккаунтам в `profiles/<id>/`, `accounts/<id>/cookies.json` (права 0600), замки
слотов в `locks/` и `sessions.json` (связка сессия BB → чат Muse). Значения кук и токенов не
пишутся в логи; при синхронизации аккаунта куки идут хост → память хаба → хост и на хабе не
сохраняются.

- **Добавить аккаунт** — на машине с Chrome, см. Установку. На машине без Chrome видно, где он
  есть: добавьте аккаунт там — он скопируется сам.
- **Проверить / Проверить все** — обновляет статус входа.
- **Скопировать на все машины** — отправляет куки аккаунта на остальные подключённые хосты.
- **Удалить** — снимает аккаунт из реестра; галочка «Удалить профиль Chrome» ещё и стирает
  `profiles/<id>/`.
- **Обновить** — `musebridge accounts refresh <id>` заново выгружает куки из вошедшего профиля
  Chrome без повторного входа. Перелогин нужен примерно раз в месяц или после контрольной точки
  Meta.
- **Машины вне BB** могут получать куки по ssh: `musebridge sync targets add <name>`, затем
  `musebridge sync` (или автоматически после add/refresh).

#### Параллельные слоты

Каждый аккаунт обслуживает `maxParallel` чатов одновременно — по умолчанию 1, допустимо 1–50:

```sh
musebridge accounts set <id> --max-parallel <n>
```

`accounts list` показывает `busy/max` по каждому аккаунту; полностью занятый аккаунт показывает
пилюлю «занят» в настройках. `MUSE_MAX_PARALLEL` задаёт значение по умолчанию для аккаунтов без
явной настройки. Замки слотов в `~/.muse-bridge/locks/` снимаются, когда процесс-держатель умер
или замку больше 30 минут. Из свободных вошедших аккаунтов коннектор выбирает с наименьшим числом
занятых слотов, затем — давно не использовавшийся: параллельная работа распределяется по
аккаунтам.

### Агент в чатах BB

`muse-acp` говорит ACP: BB запускает его на машине, и он связывает каждую сессию BB с боковым
чатом Muse (сохраняется в `sessions.json`). Muse не умеет вызывать наши инструменты напрямую,
поэтому агент ведёт текстовый протокол: первое сообщение чата Muse объясняет, что работа идёт в
каталоге `<cwd>`, и что ответ можно завершить ровно одним блоком ```` ```muse-tool ````
`{"tool":"<name>","args":{...}}`. Агент выполняет инструмент на машине и отправляет результат
как `TOOL RESULT <name> (ok|error)`; цикл продолжается, пока Muse не закончит финальный ответ
строкой `[[done]]`.

- **Локальные инструменты:** `read_file`, `write_file`, `edit_file` (точное единственное
  совпадение), `list_dir`, `grep`, `bash` (`/bin/bash -lc` в рабочем каталоге, таймаут по
  умолчанию 120 с, максимум 600 с), `tool_schema`. Пути решаются внутри рабочего каталога сессии —
  снаружи отказ; вывод ограничен ~20 КБ. Когда клиент объявляет `fs.readTextFile`/`fs.writeTextFile`,
  чтение и запись идут через ACP-клиент, и BB видит правки.
- **MCP-серверы** чата из `session/new` (stdio или streamable HTTP) стартуют и доступны как
  `mcp__<server>__<tool>`; `tool_schema` возвращает схему входа любого инструмента. Сервер,
  который не стартовал, пропускается — остальные работают.
- **Скиллы:** `list_skills {query?}` / `read_skill {name}` сканируют front matter SKILL.md в
  `MUSE_SKILL_DIRS` (разделитель `:`; по умолчанию `<cwd>/.claude/skills`, `<cwd>/.agents/skills`,
  `~/.claude/skills`, `~/.agents/skills`, `~/.bb/skills`).
- **Правила BB** из системного блока (инструкции проекта, правила владельца, раздел про язык)
  пересылаются Muse с ограничением 16 КБ; инструкции плагинов и каталоги скиллов — нет.
- Ответ без блока инструмента и без `[[done]]` получает одно напоминание; на промпт — не больше
  `MUSE_MAX_TOOL_ROUNDS` раундов (по умолчанию 60), затем ход завершается с пояснением.
  `session/cancel` останавливает цикл между раундами; если отправка была в полёте, хвост
  прерванного ответа дочитывается из истории на следующем промпте (`MUSE_PENDING_WAIT_MS`,
  по умолчанию 30 с).
- **Карточки одобрения.** Когда Muse показывает «Разрешить Muse …?», коннектор сам отвечает
  «Всегда разрешать» и ждёт дальше. Карточки про деньги (покупка, оплата, подписка) не трогаются —
  ответ помечается «Muse asks for approval» и ждёт вашего решения в Muse;
  `musebridge approve --chat <id>` отвечает на ожидающие карточки в существующем чате.
- **Модели:** `muse-spark` (Muse Spark, по умолчанию) — цикл инструментов. **Muse Image**
  (`muse-image`) ставит префикс только на первое сообщение (или на следующее, которое начинается
  с форм-фактора `16:9 кот` / `[4:5] cat`): `Create image format: <W:H>. …` или `Create image. …`.
  Остальные реплики уходят в тот же чат Muse как есть. Без интро инструментов. Агент сохраняет
  новые картинки в `<workspace>/muse-images/` и отдаёт каждую блоком изображения плюс относительный
  путь. У Muse нет переключателя рассуждения: уровни BB принимаются, чтобы композитор не падал,
  и агент их игнорирует.

### Справка по CLI

```sh
musebridge doctor [--account <id>]          # проверить Chrome, каталог профиля и вход
musebridge chats [--account <id>] [--transport api|browser] [--json]
                                            # список боковых чатов
musebridge history [--account <id>] [--transport api|browser] <chatId> [--json]
                                            # транскрипт чата
musebridge send [--account <id>] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--headed] [--json] <text>
                                            # отправить сообщение и напечатать ответ
musebridge image [--account <id>] [--format W:H] [--out dir] [--chat <id>] [--timeout <sec>] [--transport api|browser] [--json] <prompt>
                                            # первый вызов возвращает chatId; --chat <id> продолжает правки в том же чате
musebridge approve [--account <id>] --chat <id>
                                            # ответить на карточки одобрения («Всегда разрешать»;
                                            # карточки про деньги остаются вам)
musebridge accounts list [--json]           # список аккаунтов (слоты busy/max, locked)
musebridge accounts add <label>             # зарегистрировать аккаунт и открыть окно входа
musebridge accounts remove <id> [--purge]   # убрать аккаунт из реестра
musebridge accounts check [<id>]            # обновить статус входа
musebridge accounts refresh <id>            # выгрузить куки из вошедшего профиля Chrome
musebridge accounts import [<id>] [--label <label>]
                                            # импорт массива кук или объекта export со stdin
musebridge accounts export <id> --json      # печатает {id, label, cookies} (только для host RPC)
musebridge accounts set <id> --max-parallel <n>
                                            # сколько чатов аккаунт обслуживает разом (1..50)
musebridge sync targets add <name>          # добавить ssh-хост для доставки кук
musebridge sync targets remove <name>       # убрать ssh-хост синхронизации
musebridge sync targets list                # показать ssh-хосты синхронизации
musebridge sync [--account <id>]            # отправить сохранённые куки на все цели
musebridge login                            # войти (добавляет аккаунт "default", если их нет)
musebridge --help                           # показать справку
muse-acp                                    # ACP-агент на stdio (запускает BB)
```

Переменные окружения, которые читает код:

| Переменная | По умолчанию | Действие |
|---|---|---|
| `MUSE_TRANSPORT` | `api` | `browser` принудительно включает транспорт Chrome |
| `MUSE_REPLY_TIMEOUT_SEC` | `180` | ожидание ответа на отправку (настройка **Reply timeout**) |
| `MUSE_MAX_TOOL_ROUNDS` | `60` | максимум раундов инструментов на промпт |
| `MUSE_MAX_PARALLEL` | `1` | `maxParallel` по умолчанию для аккаунтов без явного значения |
| `MUSE_SKILL_DIRS` | см. выше | дополнительные корни скиллов через `:` |
| `MUSE_HEADLESS` | `1` | `0`/`false` показывает окно Chrome (настройка **Headless Chrome**) |
| `MUSE_PENDING_WAIT_MS` | `30000` | сколько дочитывать хвост прерванного ответа |
| `MUSE_ACP_DUMP_PROMPT` | выкл. | дописывать каждый промпт для Muse в этот файл (отладка) |
| `MUSE_BRIDGE_HOME` | `~/.muse-bridge` | каталог состояния |
| `MUSE_RUNTIME_DEV` | выкл. | путь к dev-копии, которую шимы запускают вместо рантайма |

### Замеренное поведение

03.11.2026 на API-транспорте: ~6 с на короткое сообщение; 40 параллельных коротких чатов на одном
аккаунте завершились без ошибок; 10 параллельных агентных задач (сессии с циклом инструментов) на
одном аккаунте все завершились.

### Ограничения и риски

- **Неофициальный коннектор.** Он говорит тем же протоколом, что веб-приложение muse.ai; Meta
  может в любой момент поменять страницу, схему кэша (проверяется `schemaVersion` 4, несовпадение —
  понятная ошибка) или протокол VM.
- **Идентичность Noise-сервера пока не проверяется** — канал зашифрован, а в stderr печатается
  предупреждение.
- **Один аккаунт = одна облачная Muse VM.** Параллельные слоты делят её; `maxParallel` умножает
  нагрузку на неё.
- Meta может попросить подтвердить вход (контрольная точка), особенно когда сессия одного
  аккаунта используется с нескольких IP/машин.
- Google Chrome нужен для входа и запасного транспорта; headless — по умолчанию для чатов,
  добавление аккаунта всегда открывает видимое окно.
- Самоустановке рантайма нужны Node 22+ и npm, доступные хост-демону BB; Windows не
  поддерживается.
- Картинки и аудио, приложенные к промпту, не поддерживаются (`promptCapabilities`: только
  текст). Сгенерированные картинки приходят из модели **Muse Image** и команды `musebridge image`.

### Диагностика

- **Muse нет в выборе провайдера на машине** — откройте Настройки → Плагины → Muse и посмотрите
  строку этой машины: в строке «Коннектор» видно, установлен ли рантайм или идёт установка.
  Нажмите **Установить** при необходимости и подождите несколько минут — списки провайдеров
  кэшируются.
- **«No signed-in Muse account»** — нажмите **Проверить** в настройках; если аккаунт не вошёл,
  войдите снова через **Добавить аккаунт** (или `musebridge accounts refresh <id>`, пока жив
  профиль Chrome).
- **«All Muse accounts are busy»** — подождите, поднимите `maxParallel` или добавьте ещё аккаунт.
- **Установка рантайма упала** — в строке настроек виден хвост ошибки (загрузка, `tar` или
  `npm install --omit=dev`). Почините Node/npm/сеть для хост-демона и нажмите **Установить**.
- **`musebridge`/`muse-acp` не найдены на машине** — сначала пробуются шимы в
  `~/.muse-bridge/bin/`; чтобы задать другого агента, укажите в настройке **Agent command**
  полный путь к `muse-acp`.
- **Карточка про деньги приостановила чат** — ответьте на неё в самом Muse или выполните
  `musebridge approve --account <id> --chat <id>` для оставшихся карточек.

### Разработка

Состав: `server.ts` — вход плагина на хабе (провайдер, RPC, оркестровка синхронизации);
`host.ts` — хостовая часть на машине (статус, установка рантайма, действия с аккаунтами);
`app.tsx` + `i18n.ts` — экран настроек (EN/RU); `bin/` — CLI `musebridge` и агент `muse-acp`;
`bridge/` — общие модули на чистом ESM (`protocol/` — HTTPS-бутстрап, рукопожатие Noise,
конверты, ndjson; транспорты, аккаунты, инструменты, MCP, скиллы, синхронизация через хаб,
установка рантайма); `tests/` — наборы `node:test`; `bench/` — комплект пилота DeepSWE.

```sh
npm test          # node --test tests/*.test.mjs
npm run typecheck # tsc --noEmit
```

В тестах работает поддельный драйвер Muse: `MUSE_BRIDGE_FAKE=1`,
`MUSE_BRIDGE_FAKE_SCRIPT=<json>` (ответы по очереди), `MUSE_BRIDGE_FAKE_SENT=<file>` (журнал
отправленных сообщений). `runtime-install` принимает источник `dir:<path>` для локальной
установки.

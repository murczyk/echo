# Group Message Replies Implementation Plan

Задача: [#3612](https://github.com/echoua/echo/issues/3612).
Оновлено 2026-10-23 після перевірки реалізації `3612-reply`.

**Мета незмінна:** виконати погоджені сценарії E1–E13 для групових reply на
`/rer-duty-neo` та `/rer-analysis-neo`. Переносимо наявний код у цільову реалізацію,
а не замінюємо вимоги поточною поведінкою. Робота послідовна в цій сесії;
починаємо з E2E.

## Поточна ітерація: лише фронтенд

За уточненням користувача 2026-10-23: без змін Rust/API/міграцій і без від’єднання
у create/edit. Сценарії E1–E13 зберігаються як ціль наступних доробок; їхні
backend-dependent кроки не видаємо за виконані.

Поточний обсяг: спільний editor з рамкою джерела; оформлення numbered item за
наданим прикладом, timestamp і однорядкове прев’ю, клікабельна вся поверхня;
максимум 2 direct items на картці та `Усі N` у попапі з власним scroll поверх
картки; перехід у поточному фіді/початковій Duty-колонці через наявні API, без
зміни фільтрів. Наявний API завантажує всі direct relations одним response:
попап поки не означає server pagination чи готовність спільного ланцюжка.

Фронтенд-регресії: `wdintel-web/tests/e2e/message-replies-frontend.spec.ts`;
наявний `message-replies.spec.ts` оновлює DOM/navigation expectations відповідно
до погодженої зміни UI, зберігаючи перевірки deleted/unavailable, timestamps,
viewer access, mobile та save. Доробки бекенду нижче залишаються невиконаними.

## Що вже реалізовано

- `wdintel-rs/src/message_reply/`: прямі зв’язки `message_reply`, пакетне читання,
  авторизація, короткі актуальні прев’ю, tombstones, native-source reconciliation.
- `POST /api/rer-importer/message-replies`: `{signal_message_ids, screen}` →
  `{replies, reply_messages}`. Ліміт 512 стосується ID карток у запиті, а не розміру
  сторінки ланцюжка. Повертаються лише прямі зв’язки, без спільного thread ID.
- `submit-direct` приймає `cited_signal_message_ids`, перевіряє джерела і зберігає
  цитати разом із новим повідомленням у транзакції. Це не API від’єднання.
- `message_reply_change` та background worker доставляють інвалідації через
  наявні `ETInboxChanged`; після помилки Redis outbox залишається для повтору.
- React `MessageRepliesProvider`, `ReplyStore`, `CitedMessageCard`,
  `MessageReplyChain` і стандартний редактор уже підключені до обох Neo-екранів.
  Store батчить mounted-картки, обмежує кеш та відкидає застарілі відповіді.
- Базовий UI вже створює reply на обох екранах: показує прев’ю, фіксує групу
  (також у «Всі групи»), лишає текст порожнім, закривається після успіху й показує
  прямі зв’язки на обох картках. Оновлення між сесіями, актуальне прев’ю після edit
  та позначки видалення — наявні частини; не переписувати їх заново.
- Є Rust DB/API-тести й наявний `message-replies.spec.ts`. Їх не замінюємо новими
  моками; зберігаємо регресії чинних прав доступу, timestamps і polling.

Детальний поточний контракт: [docs/message-replies.md](../../message-replies.md).

## Прогалини, відомі до початку реалізації

| Погоджена вимога | Поточний стан / необхідна доробка |
| --- | --- |
| Drawer як у звичайному створенні | Підключено спільний responsive editor та intent coordination. |
| Один плоский ланцюжок; усі учасники доступні з кожної картки | Є лише directed edges. Потрібні незалежна ідентичність ланцюжка та індексований склад учасників. Рекурсивний обхід історії на кожне читання не підходить. |
| Максимум 2 посилання та «Усі N» поверх фіда | UI для direct relations реалізовано; compact summary і server pagination ще потребують контракту BE. |
| Перехід у поточному фіді, без зміни фільтрів | Підключено наявний resolve/materialize/land з контекстом Duty-колонки та перевіркою чинних фільтрів. |
| Блакитна рамка джерела | Підключено стан source через наявний shared editor highlight. |
| Новий reply після видалення джерела | `prepare_submission` відхиляє видалене джерело. Потрібен окремий авторизований шлях tombstone; звичайне редагування видаленого повідомлення не дозволяти. |
| Від’єднання в create/edit; решта учасників лишаються разом | Немає відповідної серверної мутації й UI. Видалення edges не є достатньою реалізацією плоского ланцюжка. |
| Строго група оригіналу | Наявний submit може спробувати іншу дозволену групу. Для Echo reply потрібна перевірка точної зафіксованої групи без fallback. |
| Retry після невідомого результату commit без дубля | Немає підтвердженого request-level idempotency контракту Echo create. Ідемпотентність native receipts цього не доводить. |
| Масштаб до мільйонів повідомлень | Є endpoint indexes, але немає підтвердженого бюджету на повний сценарій. 512 anchors не обмежує кількість пов’язаних рядків у відповіді. |

**Не готові серверні контракти:** склад/пагінація плоского ланцюжка та
від’єднання. До написання коду цих частин потрібно завершити пункт 1 нижче:
зафіксувати схему, DTO, сумісність і перевірку гонок. Наявність бекенду прямих
цитат не означає готовності всього погодженого функціоналу.

## Незмінні сценарії та обмеження

- Reply — окреме звичайне повідомлення. На групове розвіддонесення створюється
  звичайне повідомлення; report-parent/copy зв’язки не успадковуються.
- У drawer порожні текст/вкладення, звичайні defaults, лише група успадкована й
  заблокована. Після успіху drawer закривається; автоматичного переходу немає.
- E1: перший reply із групи та «Всі групи», рамка, взаємні посилання, locked group.
- E2: reply на групове розвіддонесення; зв’язки з його джерелами незалежні.
- E3: A створює оригінал, B відповідає, C відповідає B, A знову відповідає
  оригіналу. Усі бачать один ланцюжок за `(message.created_at, message.id)`.
- E4: незалежні ланцюжки однієї групи не змішуються.
- E5: одночасні перші reply утворюють один ланцюжок без дублів; порядок стабільний.
- E6: 10 000+ історичних повідомлень, 100 учасників, 2 compact links, popover
  без стрибка картки, підвантаження при scroll, stale response після зміни складу,
  далекий перехід у тому самому фіді; друга Duty-колонка не змінює першу.
- E7: фільтри й період зберігаються; недоступний через фільтр target позначено,
  для перегляду користувач змінює фільтр сам. Нові reply виконують звичайні правила
  групи, видимості й unread.
- E8: актуальне прев’ю після редагування іншим користувачем; текст reply і
  creation-order не змінюються.
- E9: видалення root/middle/last лишає позначку без вмісту й зберігає інших
  учасників та можливість відповідати на доступні повідомлення.
- E10: видалення джерела під час першого/вкладеного reply не блокує його створення;
  джерело представлене tombstone, група зафіксована.
- E11: від’єднання зберігається лише при save, cancel нічого не змінює. Повідомлення
  лишається у фіді, зникає зі списку на всіх інших картках; інші лишаються разом.
  Це працює також для reply на видалене джерело; singleton не показує блок.
- E12: прибрати джерело під час create → звичайний draft зі збереженими даними й
  доступним вибором групи, без ланцюжка після створення.
- E13: reply/detach в обох порядках commit: створення використовує актуальну
  належність джерела під блокуванням; після detach новий reply утворює новий
  ланцюжок, а вже створений до detach лишається з рештою попереднього.
- Не додаємо приєднання наявного повідомлення, merge/move, іншу ціль редагування,
  окрему вкладку/режим Аналізу. Native Signal/WhatsApp citations не включаємо
  автоматично в Echo-ланцюжки й не видаляємо наявний native functionality.

## Послідовність реалізації

### 1. Зафіксувати доповнення до наявного бекенду

- [ ] Зберегти прямі `message_reply` і native receipts; визначити джерело істини
  Echo membership незалежно від parent edge, щоб detach не ділив ланцюжок.
  Узгодити походження Echo/native зв’язків і поведінку старих citation rows.
  Без цього не починати міграцію й не вигадувати успішний detach у фікстурах.
- [ ] Обрати additive таблиці thread/member з group scope, незалежним thread ID,
  maintained count/revision та індексом `(thread_id, created_at, signal_message_id)`.
  Унікальність членства — `(group, signal_message_id)`. Tombstone зберігає стабільну
  ідентичність/порядок; видалення оригіналу не каскадує на інших учасників.
- [ ] Описати backward-compatible DTO: наявний `cited_signal_message_ids`
  використовувати для create; нові поля/контракти додавати лише там, де їх немає.
  Визначити payload save-detach і idempotency key. Не повертати вигадане
  `reply_to_signal_message_id` замість уже реалізованого поля цитат.
- [ ] Compact metadata завантажувати пакетно для видимих Neo-карток із груповим
  контекстом. Наявний API прямих цитат не видавати за API транзитивного ланцюжка.
  Окремий paged read — cursor `(thread_id, created_at, signal_message_id)`, 25
  учасників, фільтри поточного фіда й `outside_filters` для доступних targets.
- [ ] Зберегти наявний `MESSAGE_REPLY_MAX_ANCHORS = 512` як межу пакетного
  запиту. Для нового thread UI додати в `config.rs` окремі preview/page constants:
  2 інші повідомлення на картці й 25 учасників на сторінці. Це технічні значення,
  не налаштування користувача; request `limit` і окремий page-max не потрібні.
- [ ] DTO визначати в Rust/`elm.rs`, потім `just gen-front`. Нові API paths і точні
  payload-и зафіксувати тут до оновлення відповідних моків. Сценарії не змінювати.

### 2. E2E перед feature-кодом

- [x] Перенести погоджені 24 перевірки E1–E13 у поточну гілку, не замінюючи
  `wdintel-web/tests/e2e/message-replies.spec.ts`.
- [x] Оновити технічні фікстури на `/api/rer-importer/message-replies`,
  `cited_signal_message_ids`, generated types і звичайний `ETInboxChanged`.
  Прибрати старі вигадані `/message-threads/*` та `reply_thread_changes`.
- [x] Зберегти назви/сенс усіх 24 acceptance cases. Для відсутнього UI потрібен
  meaningful red на очікуваній можливості; не skip, не expected-failure і не
  протилежне очікування на кшталт «видалення повинне блокувати reply».
- [ ] Для ще відсутнього read/detach контракту не симулювати серверний алгоритм.
  Після пункту 1 дозаповнити лише wire responses/request assertions, зберігаючи
  той самий користувацький шлях. DB invariants перевіряються Rust DB-тестами.
- [x] Виконати Chromium з trace і переглянути браузерні артефакти всіх сценаріїв.
  Фіксувати початковий meaningful red; це не green і не перевірка пізніших кроків.

### 3. Storage і транзакції

- [ ] Переглянути зіставні міграції; додати нову SQL-in-Rust міграцію, не змінювати
  вже merged/deployed файли. Нові допоміжні таблиці — PostgreSQL-only з точним
  analytics impact/exclusions. Історію всіх повідомлень не backfill-ити.
- [ ] Повторно використати direct-submit transaction, access checks і outbox.
  Нові write paths блокують джерело, потім thread, та визначають поточне членство
  після lock. Fixed source group перевіряється сервером.
- [ ] Реалізувати create/join, save-detach, source-deleted create і tombstones.
  Оновлювати лише зачеплені membership rows/thread counter; без переписування
  всіх історичних `signal_message` та без N² попарних зв’язків.
- [ ] Додати receipt для повтору request після невідомого commit, включно з
  перевіркою payload; `finish_direct_submit` може помилитися після DB commit.
- [ ] DB-тести: simultaneous first replies, duplicate retry, exact-group access,
  source delete/detach races, root/middle/last deletion, singleton, native isolation.
- [ ] Локально: migrate-up, gen-seaorm, catalog-aware analytics check на стандартному
  test dump з явним `GITHUB_BASE_REF`. Staging/production не змінювати.

### 4. Читання й оновлення

- [ ] Реалізувати summary/page contract пункту 1 через конкретні message/thread
  indexes. Без global message scan, загальних exact counts та N+1 preview loads.
- [ ] Розвинути наявний `ReplyStore` і provider: bounded caches, cancel/version
  guards, refresh лише за чинним polling coordinator. Використати наявний outbox,
  не створювати паралельний transport і не fanout-ити подію на кожен старий member.
- [ ] Cursor не прив’язувати до revision. Stale response не відновлює видаленого
  учасника й не змушує список починати з першої сторінки при кожному reply.
- [ ] Не змінювати shared `InboxMessage` і loaders інших екранів заради Neo reply.

### 5. UI і навігація

- [ ] Використати стандартний drawer: citation preview, fixed group, source outline,
  close-on-success; remove-source у create зберігає draft і повертає ordinary mode.
  Базові preview/group/save вже підключені; змінити презентацію й координацію
  наявного editor, а не створювати ще одну форму або дублювати submit logic.
- [ ] Edit-detach — лише save; поля повідомлення та creation date не змінюються.
  Reply при відкритому іншому editor проходить наявний dirty-intent guard і не
  приєднує редаговане повідомлення до іншого ланцюжка.
- [ ] Замість inline direct-list для Echo thread — максимум 2 посилання включно з
  parent, «Усі N» і lazy anchored popover з власним scroll. Без росту картки.
  Розмістити блок нижче intelligence-report links: зараз `replyContent` іде перед ними.
- [ ] Target → наявний cancellable resolve/materialize/land у конкретному фіді.
  Для reply не використовувати generic navigation з новою вкладкою, першою Duty
  колонкою або автоматичним розширенням Analysis date range.
- [ ] Зберегти filter/unread/follow/scroll contracts #3546; не додавати важкі MUI
  wrappers у hot-path карток. API errors показувати, а не приховувати.

### 6. Перевірка перед інтеграцією

- [ ] На локальних репрезентативних 50k/2m даних порівняти фактичні query plans,
  scanned rows/buffers, p95, CPU/IO й lock contention при паралельних reply.
  Виміряти також звичайний Neo feed до/після. Моки не доводять backend performance.
- [ ] Chromium: усі 24 E1–E13 green і переглянуті у браузері; наявні reply та feed
  regression suites green. Технічні payload assertions оновлювати, сценарії — ні.
- [ ] cargo fmt/check/clippy, відповідні DB-тести, frontend formatting і
  `just build-front`. Три погоджено відкладені помилки TS mocks не виправляти тут.
- [ ] Оновити focused docs і CHANGELOG #3612. README overviews не змінювати.
  До approval окремої операції/target не запускати remote deploy чи міграції.

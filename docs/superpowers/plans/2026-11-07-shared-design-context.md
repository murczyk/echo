# Shared Design Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дати розробникам Echo спільний продуктовий і дизайн-контекст, доступні з репозиторію навички та відтворюване локальне налаштування Impeccable.

**Architecture:** Кореневі `PRODUCT.md` і `DESIGN.md` описують основний Echo web UI. Власні навички залишаються в `.github/skills`; Codex знаходить їх через відносні посилання в `.agents/skills`. Проєктна інсталяція Impeccable має зафіксоване походження й версію; спільна конфігурація відокремлена від особистої довіри до hooks.

**Tech Stack:** Markdown, Agent Skills, Git symlinks, Impeccable project installation, наявні Elm/React/MUI/Tailwind і design tokens. Без нових runtime-залежностей застосунку.

**Spec:** [Межі й очікувана поведінка](#межі-й-очікувана-поведінка), запит користувача про план для `PRODUCT.md`, `DESIGN.md`, командних skills і Impeccable.

## Global Constraints

- `wdintel-web/src/design-system/tokens.json` залишається єдиним джерелом спільних значень; згенеровані CSS/TS вручну не редагувати.
- Дотримуватися `AGENTS.md`, `CODE_REVIEW.md`, `docs/frontend/layout-component-contract.md` і локальних `AGENTS.md` відповідної поверхні.
- Поточні екрани, глобальну палітру MUI, API, БД і поведінку застосунку ця робота не змінює.
- `README.md` і `docs/README.md` залишити без змін; інструкції команди розмістити у focused frontend-документації.
- Не змінювати особисті конфігурації агентів, підписки, permissions, workspace trust або plugin state інших людей.
- План не дозволяє деплой, зміни staging/production, публікацію Storybook чи надсилання продуктових даних зовнішнім сервісам.
- Експериментальна гілка `finch/2026-11-07-design-context` створена від `main`; issue поки не призначено. Сторонні зміни гілки `3340-mobile-video` залишаються в початковому checkout і не входять у цю роботу.

## Review Focus

1. Новий checkout на клієнтах/ОС команди: навички відстежуються Git, symlinks працюють і потрібні залежності названі — перевірка Tasks 2–4.
2. Запуск із кореня та з `wdintel-web`: обидва знаходять ті самі контекстні файли — перевірка Task 4.
3. Особистий Impeccable уже встановлений або hooks не довірені: setup не перезаписує його й не оголошує hooks активними — перевірка Task 4.
4. Немає Product Design, браузера, ImageGen або engine; змінено Elm-файл, який detector не підтримує: базовий контекст доступний, неперевірене не зараховується як успіх — перевірка Tasks 4–5.
5. Код і опис дизайну розходяться: навичка показує суперечність із посиланнями на джерела, а не змінює тему чи токени — перевірка Tasks 2 і 5.

## Межі й очікувана поведінка

Після налаштування новий розробник отримує з Git контекст Echo, власні командні навички й погоджену версію Impeccable. Навички можна використовувати без персонального Product Design-плагіна. Наявність плагіна, браузера, engine і активних hooks перевіряється окремо.

У першій ітерації фіксуємо наявну систему. Повний workflow роботи з тасками готується окремо; тут залишається лише мінімальна інструкція використання контексту й skills. Новий візуальний стиль, розширення Storybook, телеметрія UX і screenshot baselines — наступні окремі задачі.

Рекомендований спосіб доставки — перевірена копія штатного project bundle Impeccable, збережена в Git, із зафіксованими source release/commit та hash. Команда отримує її через checkout, без повторного завантаження skill через installer. Персональні plugins самі по собі не дають відтворюваного стану репозиторію; власний marketplace і Git submodule додадуть окремий процес підтримки, який для першої ітерації не потрібен.

## Покриття початкового запиту

| Потреба | Результат цієї ітерації | Наступний етап |
| --- | --- | --- |
| Спільне розуміння продукту | `PRODUCT.md`, Task 1 | Уточнення пріоритетів за дослідженнями користувачів |
| Послідовна система й тема | `DESIGN.md` із чинними контрактами, Task 2 | Усунення контрастних проблем і погоджена міграція палітри |
| Дизайн-процес без окремого дизайнера | Brief/review skills і workflow, Task 3 | Пілотні UI-зміни та розширення Storybook |
| Доступ інструментів для команди | Матриця клієнтів, repo skills, Impeccable setup, Tasks 3–5 | Непідтримані конфігурації — явно відкриті задачі; Product Design — опційно |
| Перевірка покращень у метриках | Базові виміри процесу й критерії якості, Task 5 | До/після UI-змін: успішність задач, час виконання, помилки користувачів; screenshot baselines/телеметрія окремо |

## Файли та відповідальність

| Файл | Призначення |
| --- | --- |
| `PRODUCT.md` | Користувачі, задачі, терміни, умови роботи й продуктові обмеження Echo web UI |
| `DESIGN.md` | Наявні візуальні правила, компоненти, теми й посилання на канонічні джерела |
| `.github/skills/echo-ui-brief/SKILL.md` | Підготовка UI-задачі до реалізації |
| `.github/skills/echo-ui-review/SKILL.md` | Перевірка реалізації та явне позначення неперевірених станів |
| `.agents/skills/` | Відносні посилання на власні навички та upstream project skill Impeccable |
| `.impeccable/config.json` | Командні defaults без локальної згоди на hooks |
| `.gitignore` | Вузькі винятки для спільних skills; ігнорування персональних і runtime-файлів |
| `.gitattributes` | Збереження точних bytes/CRLF підписаного upstream bundle без formatter-змін |
| `docs/frontend/design-workflow.md` | Короткий командний процес і шаблон UI-brief |
| `docs/frontend/design-tools.md` | Матриця клієнтів/ОС, версії й походження Impeccable, prerequisites, setup, перевірка, оновлення й усунення проблем |
| `AGENTS.md` | Коротка маршрутизація UI-роботи до контексту й skills |
| `.github/CODEOWNERS` | Власники нових контекстних і tooling-файлів |

## Task 1: Продуктовий контекст

**Files:** Create `PRODUCT.md`.

**Interfaces:** Читає наявні README, маршрути й behavior contracts. Дає всім агентам один опис продукту, без персонального plugin state.

- [x] Зібрати факти про основний web UI, користувацькі ролі й сценарії з `README.md`, `docs/README.md`, `docs/frontend/react-behavior-contracts/` і відповідних маршрутів. Не поширювати правила Echo UI на окремі GOI/docs-застосунки.
- [ ] Перед написанням підтвердити з власником продукту лише істотні прогалини: основну аудиторію, три пріоритетні задачі та умови використання. Код є доказом можливостей, але не підтвердженням пріоритетів користувачів.
- [x] Створити короткий файл у форматі Impeccable: `<!-- impeccable:product-schema 1 -->`, `## Platform` зі значенням `web`, далі відповідні `Users`, `Product Purpose`, `Operating Context`, `Capabilities and Constraints`, `Evidence on Hand`, `Product Principles`. Додаткові секції — лише для підтверджених фактів.
- [x] Описати збереження контексту роботи, зрозумілі помилки й права доступу через наявні контракти; непідтверджені умови використання й доступності позначити відкритими рішеннями. Не переносити сюди палітру чи рецепти верстки.
- [x] Перевірити кожне суттєве твердження за репозиторієм або відповіддю власника продукту; перевірити посилання. Приймання: файл пояснює, кому й для чого потрібен Echo, і не є переліком усіх функцій.

## Task 2: Дизайн-контекст без другого джерела токенів

**Files:** Create `DESIGN.md`; read `docs/frontend/layout-component-contract.md`, `wdintel-web/src/design-system/tokens.json`, `wdintel-web/src/ts/react/mui-theme.ts`, `wdintel-web/src/styles/_variables.css`, `wdintel-web/src/ts/react/components/README.md`.

**Interfaces:** Використовує продуктові обмеження Task 1. Дає skills правила застосування чинної системи; не генерує CSS або тему.

- [x] Явно обмежити документ `wdintel-web`; окремі GOI/docs-застосунки не успадковують продуктові й візуальні рішення Echo лише через розташування файлу в корені. Описати чинну систему з коду. Використати канонічний порядок секцій Impeccable: `Overview`, `Colors`, `Typography`, `Layout`, `Elevation & Depth`, `Shapes`, `Components`, `Do's and Don'ts`.
- [x] Зберегти числові значення в канонічних файлах; у `DESIGN.md` описати семантичні ролі та дати відносні посилання. Frontmatter першої версії — тільки `name` і `description`, без вручну скопійованих шкал.
- [x] Зафіксувати співіснування Echo-токенів, legacy aliases і compatibility-first MUI palette. Розрізнити MUI та Echo spacing/breakpoints; не оголосити глобальну палітру вже уніфікованою.
- [x] Послатися на контракт меж Tailwind/MUI/Power, відмінність `EchoChip`/`PowerChip` і локальні обмеження Duty/MessageCard. Для error/loading/empty-сценаріїв посилатися на наявні behavior contracts.
- [x] Описати спосіб розв'язання суперечностей: зафіксувати різницю між документацією, кодом і підтвердженим рішенням; не виправляти її побічним редизайном. Відомі проблеми контрасту не перетворювати на нормативні правила.
- [x] Перевірити приклад із `createNeoMuiTheme`: читач має правильно пояснити, що `theme.echo` доступний, але глобальна MUI palette ще не замінена. На підготовленому frontend checkout запустити `cd wdintel-web && npm run tokens:check`; очікується exit 0 без змін outputs. Команда використовує встановлений `prettier`; у чистому checkout спершу потрібен чинний frontend setup із README, включно з доступом до приватних пакетів. Відсутність залежностей записати як незавершену перевірку, а не дефект токенів. Читання контексту й використання brief/review skills не потребують frontend build.

Мінімальний frontmatter підтримується форматом DESIGN.md. Він дає контекст агенту, але не повні машинні шкали для перевірки design-system drift. Генерація таких проєкцій і `.impeccable/design.json` для live panel відкладена; не обіцяти ці можливості в першій ітерації.

## Task 3: Командні skills і виявлення в Codex

**Files:** Create дві `.github/skills/echo-ui-*/SKILL.md`, `docs/frontend/design-workflow.md`, `docs/frontend/design-tools.md`, відносні symlinks у `.agents/skills/`; modify `.gitignore`, `AGENTS.md`.

**Interfaces:** Обидві навички спочатку читають `PRODUCT.md`, `DESIGN.md` та чинний layout contract. Установлені Product Design/Impeccable — доступні помічники, не обов'язкові залежності навичок Echo.

- [ ] У `design-tools.md` зафіксувати клієнти, їхні версії й ОС, які реально використовує команда, та спосіб виклику skills. Codex — перша ціль перевірки, не доказ підтримки всіх клієнтів. Для інших потрібних клієнтів перевірити discovery наявних `.github/skills` або додати лише необхідний підтримуваний адаптер без дублювання змісту; непідтримане позначити. Якщо ОС не відновлює Git symlinks, задокументувати перевірений спосіб checkout, наприклад WSL, або залишити цю конфігурацію неприйнятою.
- [x] Написати `echo-ui-brief`: derive цільову роль, задачу, поточний маршрут, критерій успіху, потрібні стани й повторно використані компоненти. Вихід — короткий brief у поточній задачі; skill не запускає реалізацію чи генерацію макетів без відповідного запиту.
- [x] Написати `echo-ui-review`: зіставити зміну з brief і локальними контрактами, перевірити відповідні стани/теми/ширини та застосовні keyboard/focus/API-error вимоги. Вихід — знахідки з доказами й перелік неперевіреного; без браузера це перевірка коду, а не візуальний аудит.
- [x] Зберегти skills короткими: YAML `name`/`description`, тригери для Echo web UI, вхід, результат і посилання на джерела. Посилання мають працювати як із `.github/skills`, так і через `.agents/skills`; context paths розв’язувати від Git root, а skill references — від фактичного skill-каталогу. Не дублювати чинні implementation-skills, не робити всі UI-зміни приводом для повного редизайну чи тривалого інтерв'ю.
- [x] Створити `docs/frontend/design-workflow.md`: brief → перевірка сценарію → реалізація → review. Включити один компактний шаблон brief, посилання на brief/критерій успіху й докази перевірки в описі UI PR та правило оновлювати контекст лише коли змінюються довготривалі рішення. Наявний PR template не потребує зміни в цій ітерації.
- [x] Змінити blanket-ignore `.agents` на root-scoped allowlist: дозволити лише погоджені `.agents/skills` entries. Інші персональні файли залишити ignored. `.codex` залишається ignored.
- [x] Додати symlinks для двох нових skills і п'яти чинних: `frontend-react-mui-implementation`, `frontend-elm-implementation`, `frontend-html-css-accessibility`, `frontend-regression-safety`, `power-wrapper-components`. Кожне посилання має вигляд `../../.github/skills/<name>`. Не підключати автоматично весь каталог; Duty skill залишається reference-only, як вимагає контракт.
- [x] Додати в `AGENTS.md` коротке правило: перед UI-роботою читати спільний контекст і відповідні локальні інструкції. Деталі workflow залишити за посиланням.
- [ ] Перевірити `git check-ignore`, цілі symlinks і staged file list; у новій Codex-сесії перевірити вибір skills із кореня та `wdintel-web`. Після коміту — повторити в чистому checkout. Приймання: знайдені сім власних/чинних skills без копій їхнього змісту та без випадково відстежуваного особистого стану.

## Task 4: Відтворюване локальне налаштування Impeccable

**Files:** Create `.agents/skills/impeccable/` зі штатного upstream project bundle, `.impeccable/config.json`; modify `.gitignore`, `.gitattributes`, `docs/frontend/design-tools.md` із Task 3. Інші provider-файли — тільки для підтверджених клієнтів із матриці Task 3.

**Interfaces:** Impeccable читає контекст Tasks 1–2; власні skills Task 3 працюють і без нього. Спільні налаштування не є особистою згодою на виконання hooks.

- [x] Перевірити офіційний release й інсталятор у тимчасовому каталозі. Зафіксувати точні CLI/skill/engine версії, source commit, release artifact URL, SHA-256 bundle та спосіб перевірки походження. Pin `npx impeccable@<version>` сам по собі не фіксує bundle, який installer завантажує окремо. Перевірити фактичні bytes і pin launcher/engine; не підміняти це номером персонального plugin, `latest` або копією plugin cache.
- [x] Отримати project skill із зафіксованого офіційного bundle для Codex у тимчасовому каталозі, з явними project scope/provider і `--no-hooks`; записати точну перевірену команду та джерело bundle. Для локального archive перевірити походження до передавання installer: local override може обходити перевірку remote-підпису. Перенести лише потрібні upstream skill, references, launcher і license/notice-файли. Не комітити platform binaries, download caches, абсолютні шляхи чи credentials; не змінювати сім skill-посилань із Task 3.
- [ ] Для `.agents/skills/impeccable/` додати вузький Git allowlist. Перевірити executable bit launcher, внутрішні references і роботу після видалення тимчасового каталогу. У fresh clone використовувати закомічені bytes: не запускати `install`/`update` для звичайного onboarding, бо вони можуть замінити skill новішим bundle. Окремо описати prerequisites і точну локальну команду отримання pinned engine для кожної підтримуваної ОС; перше завантаження потребує мережі.
- [x] Створити спільну конфігурацію з `projectRoots: ["wdintel-web"]` для Rust-root monorepo, native hook limits (`maxFindings: 5`, `maxChars: 8000`) для повторного setup без shared diff, і `buildPath: "code"`, `hook.enabled: true`, `hook.quiet: true`, `detector.designSystem.enabled: false`. Вимкнені лише drift-перевірки, яким у Task 2 ще не надано машинних шкал; загальні detector-перевірки залишаються доступними. Не додавати широких ignores заради чистого звіту.
- [x] У runbook розділити setup: установка потрібного engine на локальній машині → перевірка `context --target` → за бажанням `$impeccable hooks on` → окрема перевірка й довіра до hook definitions у Codex. Не вмикати hooks через `npm install`/postinstall Echo та не змінювати trust автоматично.
- [x] Залишити `.impeccable/config.local.json`, consent, logs, caches і локальні hook manifests поза Git. Перевірити фактичні runtime-шляхи обраного release і додати точні ignore-patterns; не ігнорувати весь `.impeccable`.
- [x] Перевірити встановлений launcher із кореня на `wdintel-web/src/ts/react/routes/rer-duty-neo/index.tsx` і з `wdintel-web` на `src/ts/react/routes/rer-duty-neo/index.tsx`. Обидва мають знайти кореневі `PRODUCT.md` і `DESIGN.md`. Явний target потрібен для monorepo; для GoI/docs він має визначатися окремо.
- [x] На тимчасовому підтримуваному UI-fixture із відомою проблемою перевірити manual detector: файл справді просканований і очікувана знахідка присутня; порожній список після пропуску файлу не є успіхом.
- [ ] Окремо перевірити hooks після особистої довіри; без неї статус — «manual checks доступні, hooks не активовані». При недоступному engine/download — точна причина, без мовчазного оновлення чи заяви про успішний setup.
- [x] Задокументувати межу Elm: поточні built-in detector/hooks не підтримують `.elm`. Не оголошувати HTML-extension заміною Elm-аналізатора. Для Elm використовувати чинний implementation skill, code review та перевірку відрендереного UI у браузері; без браузера візуальна перевірка залишається незавершеною. Відсутність detector findings не доводить доступність, коректність UX чи відповідність усій дизайн-системі.
- [x] Описати повторний setup і конфлікт із персональним plugin: показати знайдені копії/версії та явно обрати repo-skill за джерелом. Однойменні skills не вважати автоматично об’єднаними чи перевизначеними. Не використовувати `--force`, uninstall або зміну глобальних конфігів. Повторний onboarding не повинен змінювати tracked files або особисті налаштування без окремої дії користувача. Оновлення — окремий review з версіями/hashes до й після; rollback — повернення skill/config до погодженого коміту, перевірка відповідного engine і повторна локальна перевірка hooks.

`code` — запропонований командний default для наявного Echo UI, щоб ImageGen не був залежністю щоденної роботи. Це не забороняє окремо запитані візуальні альтернативи.

## Task 5: Командне приймання й підтримка

**Files:** Modify `.github/CODEOWNERS`, `docs/frontend/design-tools.md`, `docs/frontend/design-workflow.md`, за потреби уточнити дві нові навички після перевірки. Результати запусків — у звіті пілота/PR, не в системних overview.

**Interfaces:** Перевіряє весь комплект Tasks 1–4. Успіх базового комплекту й успіх додаткових інтеграцій звітуються окремо.

- [x] Додати для нових root context, skills і shared config тих самих frontend-reviewers, які вже вказані в `.github/CODEOWNERS`. Не призначати нових людей без домовленості.
- [x] Описати Product Design як необов'язкову персональну інтеграцію: встановлення у підтримуваному клієнті, надання тих самих repo-context файлів і перевірка браузера. Не копіювати особистий `user-context.md` і не гарантувати команді доступ до інструментів лише через Git clone.
- [ ] До пілота визначити однакові за обсягом задачі й рубрику якості: роль/ціль/критерій успіху, потрібні стани, повторне використання контрактів/компонентів, докази та межі review. Зняти baseline поточного процесу, потім повторити зі спільним контекстом. Без нової телеметрії записати час від постановки задачі до прийнятого brief/review, кількість виправлень до приймання, успішні setup / усі спроби та розробники з доступним базовим комплектом / уся команда; поряд — клієнт/ОС/версії та причини збоїв. Порівнювати час лише за виконаної рубрики; результати двох людей — сигнал пілота, а не статистичний доказ покращення UX.
- [x] Провести dry run `echo-ui-brief` для одного наявного сценарію, наприклад перегляду вкладення з поверненням до стрічки. Skill має повторно використати наявні компоненти, вказати потрібні стани й не почати реалізацію.
- [x] Провести `echo-ui-review` на представницьких React- та Elm-змінах без Product Design і браузера: очікується коректний code review з явними межами. За доступного браузера окремо перевірити сценарій і захоплення/перегляд локального скриншота на синтетичних даних. Не називати ці режими рівнозначними. На backend-only і GOI/docs-запитах перевірити, що Echo UI skills не нав’язують контекст основного застосунку.
- [x] У тимчасовому checkout підкласти суперечливу чернетку правила палітри й перевірити, що review виявляє її відносно layout contract/MUI source, без редагування production-коду. Видалити fixture після перевірки.
- [ ] Перевірити onboarding на чистому checkout та з уже встановленим персональним plugin, із кореня й підкаталогу, включно з повторним запуском. Провести хоча б один пілот із другим розробником; коли він ще не відбувся, позначити пілот незавершеним. Підтримку команди загалом приймати лише після перевірки кожної потрібної комбінації клієнт/ОС із Task 3 та доступу кожного розробника; два успішні запуски на однаковій конфігурації цього не доводять.
- [ ] Приймання пілота: обидва учасники отримали придатні brief і review без Product Design; hooks мають підтверджений статус. Для майбутнього UI-пілота зберегти в workflow протокол до/після: одна роль, одна задача й умови; успішні завершення / спроби, медіанний час виконання успішних спроб, помилки/повернення на спробу. Ціль покращення визначити до зміни UI за baseline; перегляди сторінок і heartbeat не зараховувати як успішність задачі. Зараз UI не змінюється, тому ці результати не оголошувати досягнутими.
- [ ] Перевірити `git diff --check`, staged diff, посилання, Git allowlist та відсутність змін токенів/теми/сторонніх файлів. Після змін JSON-конфігурації застосувати вимогу форматування з `AGENTS.md`; оскільки конфіг лежить поза frontend, окремо перевірити, чи staged formatter охоплює його, й не форматувати весь frontend. Для документації й skills не додавати формальних unit-тестів; admission будь-яких нових тестів — за `CODE_REVIEW.md`. `cargo check`/clippy і повний frontend build потрібні лише якщо виконання вийде за цей tooling/docs scope й змінить відповідний код.

## Послідовність і результат

Виконувати Tasks 1 → 2 → 3 → 4 → 5 послідовно. Після Tasks 1–3 команда вже має спільний контекст і власний workflow; Task 4 додає Impeccable, Task 5 підтверджує придатність на іншому робочому місці. Встановлення пакетів і особисте налаштування колег не виконуються під час підготовки цього плану.

## Джерела для реалізації

- [Impeccable installation and team distribution](https://impeccable.style/tutorials/getting-started/)
- [Impeccable installer contract: bundle source and verification](https://github.com/pbakaus/impeccable/blob/main/docs/CLI-CONTRACT.md)
- [Impeccable context format and resolution](https://impeccable.style/docs/context/)
- [Impeccable shared and local config](https://impeccable.style/docs/config/)
- [Impeccable hooks and per-user trust](https://impeccable.style/docs/hooks/)
- [Codex repository skills and symlink support](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)

Публічна документація описує актуальний upstream і може відрізнятися від обраного release. Інсталятор, config keys, формат контексту та engine перевірити разом на одній зафіксованій версії перед комітом.

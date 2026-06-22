# План і контекст: регіональні `settlements.json` та вибір файлів для AOR

## Запит користувача

Потрібно було розібратися з неочевидною схемою використання файлів населених пунктів у ECHO, повернути зрозумілий вибір кількох регіональних файлів для кожного AOR в адмін-панель і написати українську інструкцію `SETTLEMENTJSON.md` для людини без глибокого технічного контексту.

Окремо користувач уточнив, що інструкція має повністю пояснювати `settlements_sources` і його зв’язок із вибором файлів для AOR.

## Що було з’ясовано

### Походження та формат даних

- Регіональні JSON-файли генеруються в проєкті `milgeo-rs`; ECHO їх не генерує і не редагує.
- У репозиторії вони лежать у `wdintel-rs/data/settlements_json/`.
- Debian-пакет копіює їх у `/etc/echo/settlements_json/`.
- Кожен файл відповідає одному регіону. Зараз у репозиторії є 14 файлів:
  - `bilhorodska_oblast_rf.json`;
  - `brestska_oblast_rb.json`;
  - `bryanska_oblast_rf.json`;
  - `dnipropetrovska_oblast.json`;
  - `donetska_oblast.json`;
  - `homelska_oblast_rb.json`;
  - `kharkivska_oblast.json`;
  - `khersonska_oblast.json`;
  - `krym.json`;
  - `kurska_oblast_rf.json`;
  - `luhanska_oblast.json`;
  - `mykolayivska_oblast.json`;
  - `sumska_oblast.json`;
  - `zaporizka_oblast.json`.
- Старий `/etc/echo/settlements.json` є спільним файлом із багатьма регіонами та зберігається для сумісності.

### Роль `settlements_sources`

- `settlements_sources` у `/etc/echo/config.toml` визначає глобальний набір населених пунктів за замовчуванням.
- Значення — назви регіональних файлів без каталогу та `.json`, розділені комами. Наприклад:

  ```toml
  settlements_sources = "kharkivska_oblast, sumska_oblast"
  ```

  перетворюється на:

  ```text
  settlements_json/kharkivska_oblast.json
  settlements_json/sumska_oblast.json
  ```

- Якщо параметр відсутній або порожній, ECHO використовує старий `settlements.json` як набір за замовчуванням.
- Набір за замовчуванням використовується, коли AOR невідомий або для AOR лишено порожній явний вибір.
- Явний вибір одного чи кількох файлів для AOR перевизначає глобальний набір для цього AOR.
- Важливе рішення в поточній реалізації: `settlements_sources` більше не є переліком файлів, дозволених в адмінці. Адмінка має показувати всі регіональні `.json`, які фізично є в `settlements_json/`.

### Як дані використовуються в ECHO

- JSON містить назву населеного пункту, регіон, координати, ідентифікатор і мовний варіант.
- Backend завантажує дані у структури швидкого пошуку в пам’яті.
- Коли відомий `aor_id`, пошук використовує набір, закріплений за цим AOR.
- Без `aor_id` або без окремої конфігурації використовується серверний набір за замовчуванням.
- Цей механізм використовується для пошуку населених пунктів і регіонів через API, автоматичного розпізнавання локацій у повідомленнях та імпортах, а також розбору згадок про підрозділи й локації.
- Збереження конфігурації AOR викликає оновлення наборів у пам’яті одразу. Уже збережені результати автоматично не перераховуються.

### Причина зниклої/неповної функціональності

- Backend раніше формував `available_settlements_configs` лише зі шляхів, отриманих із `settlements_sources`.
- Якщо `settlements_sources` був порожній, доступним фактично лишався старий `settlements.json`; регіональні файли з каталогу не потрапляли до API та списку в адмінці.
- Окрема сторінка `Admin/LocationConfigsNeo` і React-компонент існували, але пункт меню `Адмін → локації по смугах` раніше був видалений.
- Вибір також існував як малопомітна дія з іконкою налаштувань у таблиці AOR.
- Збереження кількох файлів уже підтримувалося: API приймає `settlements_configs: string[]`, а база зберігає масив у `aor_location_config.settlements_configs`.

## Виконані зміни

### Backend

- `wdintel-rs/src/config.rs`
  - додано централізовані константи для старого файла, каталогу регіональних файлів і розширення;
  - `get_settlement_paths` використовує ці константи;
  - семантика `settlements_sources` як набору за замовчуванням збережена.
- `wdintel-rs/src/location/mod.rs`
  - додано сканування каталогу `settlements_json/`;
  - усі звичайні файли з розширенням `.json` повертаються в алфавітному порядку як доступні варіанти для адмінки;
  - якщо каталогу немає або він порожній, лишається сумісний fallback до шляхів набору за замовчуванням;
  - додано unit test `location::tests::lists_all_regional_settlements_configs`.
- `wdintel-rs/src/server/mod.rs`
  - прибрано тихий `.unwrap_or_default()` під час завантаження довідників;
  - помилковий `settlements_sources`, відсутній файл або пошкоджений JSON тепер мають зупиняти запуск із помилкою, а не запускати ECHO з порожнім довідником.

API-контракти не змінювалися, тому `just gen-front` не потрібен.

### Адмін-панель

- `wdintel-web/src/Shared/Components/Navbar.elm`
  - повернуто окремий пункт `Адмін → Населені пункти AOR`.
- `wdintel-web/src/Pages/Admin/LocationConfigsNeo.elm`
  - виправлено активний пункт навігації;
  - оновлено заголовок сторінки.
- `wdintel-web/src/ts/react/routes/admin-location-configs-neo/index.tsx`
  - сторінку перейменовано на «Файли населених пунктів для AOR»;
  - додано коротке пояснення призначення вибору;
  - явно показано, що можна вибирати кілька файлів;
  - додано checkbox для кожного файла;
  - у вибраному значенні показуються зрозуміліші basename-файли без `settlements_json/`;
  - порожній вибір названо «Набір сервера за замовчуванням»;
  - додано попередження, якщо регіональних файлів немає.
- `wdintel-web/src/ts/react/routes/admin-aor-neo/index.tsx`
  - колонку та дію перейменовано на «Файли населених пунктів»;
  - діалог і fallback-підпис зроблено зрозумілішими;
  - у таблиці показуються basename-файли.

### Документація

- Створено український `SETTLEMENTJSON.md`.
- Документ пояснює:
  - що це за файли та звідки вони беруться;
  - навіщо обмежувати довідники для конкретного AOR;
  - де і як ECHO використовує дані;
  - як вибрати кілька файлів в адмінці;
  - значення порожнього вибору;
  - шляхи файлів у репозиторії та на сервері;
  - роль, синтаксис і fallback-поведінку `settlements_sources`;
  - відмінність між `settlements_sources` та доступними варіантами в адмінці;
  - старий спільний `settlements.json`;
  - практичний приклад вибору сусідніх регіонів.

## Перевірки, які вже виконано

- `cargo fmt --all -- --check` — успішно після останніх змін.
- `cargo check -p wdintel-rs` — успішно після зміни fail-fast завантаження в `server/mod.rs`.
- `cargo clippy -p wdintel-rs --all-targets -- -D warnings` — успішно до останньої однорядкової зміни в `server/mod.rs`.
- `git diff --check` — успішно.
- Повний `cargo check` для workspace також був успішним до останньої однорядкової зміни в `server/mod.rs`; актуальний пакет `wdintel-rs` перевірено після неї.

## Перевірки, які не завершено

### Frontend

- `just build-front` запустив `npm ci`, але завершився з `E401 Unauthorized` для приватного пакета `@echoua/echo-audio-player` з GitHub Packages. Потрібен дійсний `GITHUB_TOKEN` із доступом `read:packages`.
- Після невдалого `npm ci` каталог `node_modules` став частково встановленим. Повторний `npm run build` дійшов до Elm Land/TypeScript, але завершився великою кількістю `Cannot find module` через неповні залежності. Це не є валідною перевіркою змінених frontend-файлів.
- Прямий `elm make src/Pages/Admin/LocationConfigsNeo.elm --output=/dev/null` раніше не запустився, бо глобальної команди `elm` не було. Після коректного `npm ci` її має забезпечити локальний toolchain проєкту/повна збірка.

### Rust tests/clippy після фінальної зміни

- Команда для нового тесту була запущена як `cargo test -p wdintel-rs lists_all_regional_settlements_configs -- --exact`, але її зупинено під час тривалого чистого збирання test-profile. Крім того, `--exact` варто прибрати або вказати повне ім’я тесту.
- Фінальний `cargo clippy -p wdintel-rs --bin wdintel-rs -- -D warnings` був запущений після зміни `server/mod.rs`, але перерваний разом із попереднім turn. Попередній повний clippy був чистим.

## Наступні кроки

1. Надати коректний `GITHUB_TOKEN` із `read:packages` і відновити frontend-залежності:

   ```bash
   export GITHUB_TOKEN=...
   just build-front
   ```

2. Повторно запустити актуальний clippy:

   ```bash
   cargo clippy -p wdintel-rs --all-targets -- -D warnings
   ```

3. Запустити новий unit test без неправильного `--exact`:

   ```bash
   cargo test -p wdintel-rs lists_all_regional_settlements_configs
   ```

4. За можливості виконати runtime smoke test із локальною БД та Admin-користувачем:
   - відкрити `Адмін → Населені пункти AOR`;
   - переконатися, що видно всі 14 регіональних файлів, навіть коли `settlements_sources = ""`;
   - вибрати 2–3 файли для AOR і зберегти;
   - оновити сторінку та перевірити збережений вибір;
   - перевірити пошук населеного пункту, який є в одному з вибраних регіонів;
   - очистити вибір і перевірити повернення до серверного набору за замовчуванням.

5. Переглянути фінальний diff і статус:

   ```bash
   git status --short
   git diff
   git diff --check
   ```

6. Не комітити й не пушити без окремого дозволу користувача.

## Поточний стан робочого дерева

Змінені файли:

```text
wdintel-rs/src/config.rs
wdintel-rs/src/location/mod.rs
wdintel-rs/src/server/mod.rs
wdintel-web/src/Pages/Admin/LocationConfigsNeo.elm
wdintel-web/src/Shared/Components/Navbar.elm
wdintel-web/src/ts/react/routes/admin-aor-neo/index.tsx
wdintel-web/src/ts/react/routes/admin-location-configs-neo/index.tsx
```

Нові файли:

```text
SETTLEMENTJSON.md
plan.md
```

Комітів і push не виконувалося.

## Зауваження для продовження

- Не змінювати старі міграції: підтримка масиву файлів для AOR вже існує в поточній схемі.
- Не потрібно змінювати/generated frontend bindings: API-поля `available_configs`, `selected_configs` і `settlements_configs` лишилися тими самими.
- Не повертати залежність списку адмінки від `settlements_sources`: це була основна причина, чому регіональні файли не було видно.
- Порожній вибір для AOR навмисно означає fallback, а не порожній довідник.
- Видалені або перейменовані регіональні файли відфільтровуються з раніше збереженого AOR-вибору на backend; такий AOR повернеться до fallback-набору, якщо валідних файлів не лишиться.

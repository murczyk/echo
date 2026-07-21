# Технічна специфікація «Пристрої»: етап 1 — створення й редагування пристроїв та синхронізація сирих даних джерела

- **Статус:** Чернетка
- **Версія:** 0.14
- **Дата:** 2026-07-21
- **Етап:** 1
- **Функціональний дизайн:** [`DEVICES.md`](./DEVICES.md), версія 0.13, статус «Прийнятий»

## Призначення документа

Документ визначає технічну реалізацію лише першого етапу функціоналу «Пристрої»: створення й редагування супровідних технічних відомостей пристрою, його аналітичної назви, AOR і підрозділу, синхронізацію накопичувального реєстру файлових метаданих із джерела та ієрархічне отримання цих відомостей.

Кожен наступний етап описується в окремому документі. Залежності від майбутніх етапів тут можна зазначати лише як межі або передумови без проєктування їхньої реалізації.

### Статус реалізації v0.14

Версія 0.14 реалізує лише підготовку схеми даних і сумісний persistence/rendering чинного device API: перетворення `main.device` та створення порожньої `wd_files.public.file_entry`. Логіка file registry, API cutover, frontend і перенесення legacy file rows не входять до цієї реалізації; чинні file routes продовжують працювати з `main.device_file`.


## Межі першого етапу

### Мета

Надати наскрізну реалізацію чотирьох потоків:

1. створення пристрою лише з джерельними технічними відомостями;
2. рольове редагування супровідних технічних відомостей, аналітичної назви, AOR і підрозділу пристрою;
3. синхронізація поточних метаданих відомих файлових об’єктів за абсолютними шляхами з автоматичним визначенням коренів і похідної ієрархії;
4. root listing, folder browsing, breadcrumbs і scoped search із cursor pagination над накопичувальним файловим реєстром.

### У межах етапу

- схема зберігання пристроїв, їхніх супровідних технічних відомостей, аналітичної назви, AOR, підрозділу та єдиного ієрархічного набору файлових entries;
- створення стабільних ключів пристроїв і файлів та автоматичне створення кореневих і віртуальних директорій;
- рольові межі `DeviceSource` для створення й синхронізації джерельних даних та `DeviceAnalyst` для подальшого редагування визначених аналітичних полів;
- валідація, атомарність, конкурентні інваріанти та оброблення помилок;
- синхронізація технічних метаданих файлів без передавання або зберігання файлового контенту;
- root listing, direct-child browse, breadcrumbs, scoped search і opaque keyset cursor без mandatory file count;
- бекенд-операції, API-контракти та фронтенд-потоки, потрібні для цих можливостей;
- нова міграція схеми, перевірка та введення першого етапу в експлуатацію.

### Поза межами етапу

- передавання, зберігання, отримання й аналіз файлового контенту, стани його наявності та інтеграція з S3;
- інші аналітичні відомості пристрою, зокрема опис, важливість і майбутні аналітичні поля;
- ручний аналіз файлів і редагування їхніх аналітичних відомостей;
- формування та відображення загальної картини пристрою;
- архівування та відновлення пристроїв;
- приховування та відновлення файлів як окремі користувацькі операції;
- нові типи сирих даних, відмінні від файлів;
- повні filesystem snapshots, неявне видалення відсутніх у batch файлів і first-class порожні директорії;
- hard links, symlinks, inode identity та публічні операції створення, rename, move або delete директорії;
- реалізація продуктових рішень, які у функціональному дизайні залишаються відкритими.

### Критерій межі етапу

Етап вважається технічно завершеним, коли створення й рольове редагування визначених полів пристрою, синхронізація файлових метаданих за абсолютними шляхами з автоматичними коренями та ієрархічні browse/search потоки працюють наскрізно через схему даних, бекенд, фронтенд і API та перевірені за відповідними вимогами функціонального дизайну.

## Трасування до функціонального дизайну

Трасування першого етапу:

| Потік | Функціональні вимоги | Сценарії | Технічні секції | Перевірка |
| ----- | -------------------- | -------- | ----------------- | --------- |
| Створення й рольове редагування пристрою | `DEV-ID-001`, `DEV-ID-007`, `DEV-ID-012`, `DEV-ACC-011`, `DEV-ACC-012`, `DEV-INT-010`, `DEV-INT-011` | `SC-01`, `SC-02`, `SC-07` | `main.device`, `DeviceService`, create/update API та drawers | Transaction, role й contract tests; browser create/edit. |
| Абсолютні шляхи, корені й path identity | `DEV-FILE-020`, `DEV-FILE-021`, `DEV-FILE-022`, `DEV-FILE-023` | `SC-03`, `SC-11` | Source path parser, parentless `file_entry`, automatic root upsert і absolute-path sync | Parser/schema invariants, duplicate-path contract і multi-root sync smoke test. |
| Накопичення та move між коренями | `DEV-FILE-019`, `DEV-FILE-024`, `DEV-FILE-025`, `DEV-LC-007`, `DEV-INT-012` | `SC-03`, `SC-04` | Per-item transaction, ordered root row locks, directory upsert/prune і file lock | Cross-root move/concurrency tests; same ID and preserved out-of-stage state. |
| Ієрархічне отримання | `DEV-INT-019`, `DEV-INT-020`, `DEV-INT-021`, `DEV-INT-022`, `DEV-UX-010`, `DEV-UX-011`, `DEV-UX-012`, `DEV-NFR-009` | `SC-11` | `ltree`, children/search indexes, browse/search API та file panel | Query-plan fixtures, cursor contracts і browser navigation/search. |
| Частковий batch і явні помилки | `DEV-INT-005`, `DEV-NFR-004`, `DEV-UX-005`, `DEV-UX-006` | `SC-03`, `SC-04` | Ordered result union, error mapping і independent commits | Mixed accepted/rejected, dependency and commit-uncertainty tests. |

## Модель даних (схема бази)

### Топологія зберігання

Перший етап використовує дві незалежні бази PostgreSQL:

| База даних | Відповідальність |
| ---------- | ---------------- |
| Основна база ЕХО (`main`) | Пристрої, аналітичні й супровідні технічні відомості пристроїв, зв’язки з AOR, підрозділами, користувачами та іншими чинними довідниками. |
| Реєстр файлів (`wd_files`) | Накопичувальні поточні технічні метадані відомих файлових об’єктів і їхня похідна ієрархія; кожен entry логічно пов’язаний зі стабільним ключем пристрою. |

`wd_files` є окремою базою даних із точним ім’ям `wd_files`, а не схемою або набором таблиць в основній базі. Вона може бути розгорнута на тому самому або на іншому сервері PostgreSQL; реалізація не покладається на спільний інстанс.

Після переходу основна база не містить робочої таблиці файлового реєстру. `wd_files` не містить користувачів, ролей, AOR, підрозділів, аналітичних відомостей, файлового контенту, стану контенту або посилань на S3.
У цій секції `timestamp` означає чинний для проєкту `timestamp without time zone`; бекенд і SQL-значення за замовчуванням нормалізують такі часові мітки до UTC.

### Цільова таблиця `main.device`

| Колонка | Тип і допустимість | Призначення та обмеження |
| ------- | ------------------ | ------------------------ |
| `id` | `uuid not null` | Первинний стабільний ключ, який генерує бекенд ЕХО. |
| `source_label` | `text not null` | Обов’язкова непорожня джерельна мітка. Не є унікальною та не використовується як ключ. |
| `name` | `text null` | Аналітична назва. Якщо задана, після `btrim` не може бути порожньою; унікальність не вимагається. |
| `unit_id` | `bigint null` | Зовнішній ключ на чинний `sigint_unit(id)`. |
| `external_url` | `text null` | Необов’язкове зовнішнє посилання; порожній рядок не зберігається. |
| `custom_fields` | `jsonb not null` | JSON-об’єкт поточних пар `ключ:значення`. Ключі унікальні в межах об’єкта, а значення є рядками. |
| `created_by` | `text not null` | Зовнішній ключ на `login(login)` для аудиту створення; не визначає власника або права на пристрій. |
| `archived` | `boolean not null default false` | Наявний життєвий стан, який етап читає для блокування змін; операції архівування не входять до етапу. |
| `archived_at` | `timestamp null` | Час архівування в UTC; має бути заданий тоді й лише тоді, коли `archived = true`. |
| `created_at` | `timestamp not null` | Час створення в ЕХО в UTC, задається сервером і не змінюється. |
| `updated_at` | `timestamp not null` | Час останньої прийнятої зміни в UTC, задається сервером. |

Аналітична назва `name`, підрозділ `unit_id` і зв’язки `device_aor` входять до першого етапу лише для читання та редагування вже створеного пристрою. Команда створення їх не приймає: новий пристрій завжди отримує `name = NULL`, `unit_id = NULL` і не має рядків `device_aor`, тому в API його початкове `aor_ids` є порожнім масивом.

Для `device` база гарантує:

- первинний ключ `device(id)`;
- зовнішні ключі `unit_id` і `created_by`;
- `check (btrim(source_label) <> '')`;
- `check (name is null or btrim(name) <> '')`;
- заборону порожнього `external_url`, якщо його задано;
- `check (jsonb_typeof(custom_fields) = 'object')`;
- `check (archived = (archived_at is not null))`;
- відсутність унікальних індексів на `source_label` або `name`.

Бекенд додатково перевіряє, що всі значення `custom_fields` є рядками, а їхні ключі й значення відповідають межам API. `hostname` і `ssh_port` не мають окремих колонок; за наявності вони зберігаються як звичайні ключі `custom_fields`. Наявні позаетапні аналітичні колонки, зокрема `tags` та `importance`, цей етап не змінює й не включає до API-контрактів.

Для основного списку зберігається індекс `(archived, updated_at desc, id)`, а для чинних зв’язків — індекси на `unit_id` і `created_by`. Індекс за `custom_fields` не створюється, доки етап не визначить запити фільтрації за кастомними ключами.

### Чинна таблиця `main.device_aor`

| Колонка | Тип і допустимість | Призначення та обмеження |
| ------- | ------------------ | ------------------------ |
| `id` | `uuid not null` | Первинний технічний ключ зв’язку. |
| `device_id` | `uuid not null` | Зовнішній ключ на `device(id)` з каскадним видаленням технічного зв’язку. |
| `aor_id` | `bigint not null` | Зовнішній ключ на `area_of_responsibility(id)`. |
| `created_at` | `timestamp not null` | Час створення зв’язку в UTC. |

Унікальне обмеження `(device_id, aor_id)` не допускає повторного AOR одного пристрою. Індекси `(device_id)` та `(aor_id, device_id)` підтримують читання й повну заміну набору AOR. Редагування перевіряє кожен переданий AOR і `unit_id` за чинними довідниками в тій самій транзакції `MainDb`.

Зміна `source_label`, `external_url`, `custom_fields`, `name`, `unit_id` і набору AOR виконується в одній транзакції основної бази. Поточний рядок `device` блокується до завершення patch, тому невалідне або заборонене поле не залишає частково зміненого стану.

### Вибір ієрархічної моделі

Розглянуті варіанти та рішення:

| Варіант | Перевага | Причина не використовувати як canonical model |
| ------- | -------- | ---------------------------------------------- |
| Лише raw pathname у file row | Простий джерельний контракт без знання дерева ЕХО | Немає first-class direct children і кожен browse потребує parsing; exact `absolute_path` зберігається як джерельне значення, але не замінює canonical adjacency. |
| `text[]` компонентів | Зберігає точні Unicode-компоненти без escaping | Ordered-prefix retrieval не має повноцінної штатної ієрархічної індексації; directory identity лишається неявною. |
| Лише adjacency list | Сильні FK та дешеві direct-child mutation | Кожен subtree/ancestor/breadcrumb query потребує recursive CTE. |
| `ltree` із людськими назвами | Швидкі ancestor/subtree operators | Label grammar не покриває довільні файлові імена, а rename переписує paths descendants. |
| Closure table | Прості indexed ancestor/subtree joins | `O(depth)` rows на entry і дорожчі insert/move без доведеного навантаження, яке це виправдовує. |
| Зовнішній graph/document/object store | Природний для загальних графів або immutable snapshots | Додає окремий сервіс та consistency boundary для задачі rooted tree; не потрібний для чинної accumulated registry semantics. |
| **Adjacency + UUID-based `ltree`** | FK/direct children із швидкими subtree/ancestor queries | **Обрано:** `parent_id` є canonical структурним зв’язком, `hierarchy_path` — синхронна похідна проєкція. |

Джерело передає exact `absolute_path` і `path_syntax`; backend детерміновано виводить canonical root та ordered relative names. `absolute_path` є поточним джерельним значенням, а `parent_id`, `name` і `hierarchy_path` — перевіреною структурною проєкцією для навігації. `ltree` містить лише immutable UUID labels, тому filesystem semantics не залежать від label grammar, а move файла, зокрема між коренями, переписує лише один leaf path.

### Цільова таблиця `wd_files.public.file_entry`

`file_entry` зберігає весь файловий forest без окремої таблиці namespace. `parent_id IS NULL` є єдиною ознакою кореневої директорії; окремих `namespace_id`, `root_id`, `source_key`, `display_root` або `kind = 'root'` немає. `parent_id` забезпечує direct-child операції та цілісність, а UUID-based `hierarchy_path ltree` є синхронною похідною проєкцією для subtree, ancestors і breadcrumbs. Людські назви ніколи не кодуються в `ltree`.
У реалізації 0.14 migration створює `file_entry` порожньою: вона не копіює, не імпортує, не зіставляє та не перевіряє coverage рядків із `main.device_file` або `wd_files.public.device_file`.


| Колонка | Тип і допустимість | Призначення та обмеження |
| ------- | ------------------ | ------------------------ |
| `id` | `uuid not null` | Первинний стабільний entry key. Для нових entries ЕХО генерує UUIDv7. Для file це публічний `file_id`; IDs root і вкладених directory є структурними ключами навігації. |
| `device_id` | `uuid not null` | Логічне посилання на `main.device(id)` без міжбазового зовнішнього ключа; дублюється в entries для scope та composite self-FK. |
| `parent_id` | `uuid null` | `NULL` лише для кореневої directory; кожен інший entry посилається на directory того самого пристрою. |
| `kind` | `text not null` | Одне з `directory`, `file`; після створення не змінюється. |
| `name` | `text not null` | Точна непорожня назва без `trim` або Unicode-нормалізації. Для root це канонічні `/`, uppercase drive root на кшталт `C:\` або UNC share на кшталт `\\server\share\`; для інших entries — один виведений компонент. |
| `name_key` | `bytea not null` | Точні UTF-8 bytes `name`, використані для identity та ordering незалежно від locale collation. |
| `path_syntax` | `text null` | Одне з `posix`, `windows` для root і file; `NULL` для synthetic directory. Для file зберігає синтаксис, за яким розібрано `absolute_path`. |
| `absolute_path` | `text null` | Exact рядок джерела лише для file; `NULL` для всіх directory. Не є ключем і може дублюватися. |
| `hierarchy_path` | `ltree not null` | Послідовність immutable entry labels від parentless root до цього entry. |
| `mime_type` | `text null` | Допустиме лише для file; передане або виведене значення. |
| `extension` | `text null` | Допустиме лише для file; передане або виведене значення без початкової крапки. |
| `file_metadata_created_at` | `timestamp null` | Допустиме лише для file; файлова дата створення в UTC. |
| `file_metadata_modified_at` | `timestamp null` | Допустиме лише для file; файлова дата зміни в UTC. |
| `created_at` | `timestamp not null` | Час створення entry в ЕХО. |
| `updated_at` | `timestamp not null` | Час останньої прийнятої зміни entry. |

Кожен label має форму `n` + UUID без дефісів, наприклад `n019bc8d4acdf7f42a5d1c2726bfc1880`. Root path містить label його власного `id`; child path дорівнює `parent.hierarchy_path || own_label`. File move в тому самому або іншому root переписує лише його leaf path. Публічного root або directory move в етапі немає.

База й repository разом гарантують:

- первинний ключ `file_entry(id)` і додатковий `unique (device_id, id)` для composite self-FK;
- `foreign key (device_id, parent_id) references file_entry(device_id, id) on delete restrict`;
- `parent_id IS NULL` допускається лише для directory; file завжди має parent;
- parent кожного descendant є directory того самого device;
- `name_key = convert_to(name, 'UTF8')`;
- row-shape check задає рівно три форми: root directory має `parent_id IS NULL`, заданий `path_syntax` і `absolute_path IS NULL`; synthetic directory має parent і обидва path-поля `NULL`; file має parent і обидва path-поля `NOT NULL`;
- `path_syntax` належить `posix | windows`; file `absolute_path` непорожній, не перевищує визначені character/UTF-8 byte limits, а його синтаксис збігається із синтаксисом root;
- файлові метадані `NULL` для directory, а задані `mime_type` та `extension` непорожні;
- `unique (device_id, hierarchy_path)` і constraint trigger, який перевіряє parent kind, відсутність циклу та точну відповідність похідного path;
- root identity `unique (device_id, path_syntax, name_key) where parent_id is null`;
- synthetic directory sibling identity `unique (device_id, parent_id, name_key) where kind = 'directory' and parent_id is not null`;
- repository перевіряє, що root, components, file `name`, `path_syntax` і `absolute_path` є результатом одного нормативного parse;
- file sibling absolute path не є унікальним: файли з однаковим parent, `name_key` і `absolute_path` мають різні IDs та співіснують;
- file і directory можуть мати однакові `parent_id` та `name_key`; kind та IDs однозначно розрізняють їх у відповідях.

Порожні synthetic directory entries не зберігаються. Parentless root автоматично створюється в транзакції першого прийнятого file item для відповідного canonical root і зберігається навіть без дітей. Backend upsert-ить один root та chain для розібраних шляхів і після move прибирає порожні старі ancestors до root.

### Індекси та query shapes

```sql
CREATE UNIQUE INDEX file_entry_roots_uidx
    ON file_entry (device_id, path_syntax, name_key)
    WHERE parent_id IS NULL;

CREATE UNIQUE INDEX file_entry_hierarchy_uidx
    ON file_entry (device_id, hierarchy_path);

CREATE INDEX file_entry_children_idx
    ON file_entry (device_id, parent_id, kind, name_key, id)
    WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX file_entry_directory_sibling_uidx
    ON file_entry (device_id, parent_id, name_key)
    WHERE kind = 'directory' AND parent_id IS NOT NULL;

CREATE INDEX file_entry_hierarchy_gist_idx
    ON file_entry USING gist (hierarchy_path);

CREATE INDEX file_entry_search_order_idx
    ON file_entry (device_id, kind, name_key, id)
    WHERE parent_id IS NOT NULL;

CREATE INDEX file_entry_name_trgm_idx
    ON file_entry USING gin (name gin_trgm_ops)
    WHERE parent_id IS NOT NULL;

CREATE INDEX file_entry_file_mime_idx
    ON file_entry (device_id, mime_type, id)
    WHERE kind = 'file' AND mime_type IS NOT NULL;

CREATE INDEX file_entry_file_extension_idx
    ON file_entry (device_id, extension, id)
    WHERE kind = 'file' AND extension IS NOT NULL;

CREATE INDEX file_entry_file_modified_idx
    ON file_entry (device_id, file_metadata_modified_at, id)
    WHERE kind = 'file' AND file_metadata_modified_at IS NOT NULL;
```

Root listing використовує `file_entry_roots_uidx` і порядок `(path_syntax, name_key, id)`. Direct children використовують composite B-tree і keyset tuple `(kind, name_key, id)`. Device-wide unfiltered search може йти `file_entry_search_order_idx`; selective subtree застосовує `hierarchy_path <@ scope_path`, ancestors — `hierarchy_path @> entry_path`. Scoped name search поєднує GiST і trigram GIN через bitmap scan, а MIME/extension/time filters — відповідні partial B-tree indexes.

`name_query` має щонайменше три Unicode scalar values, бо коротший substring не дає селективного trigram key. `%`, `_` і `\` escape-яться як literals. Default GiST signature змінюють лише за результатом `EXPLAIN (ANALYZE, BUFFERS)` на representative depth/cardinality fixture.

Оператори, index classes і обмеження labels визначені в [PostgreSQL `ltree`](https://www.postgresql.org/docs/current/ltree.html), а поведінка indexed `ILIKE` — у [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html). Exact `absolute_path` зберігається у file row; похідний `path_components` не дублюється окремою колонкою й будується з ordered ancestors, виключаючи parentless root. Для search page результати та ancestors завантажуються одним batch-запитом, а не N+1.

### SeaORM і безпечний SQL

`sea-orm-codegen 1.1.19` генерує custom `ltree` як `String`, але без cast runtime SELECT несумісний із `TEXT`. Генерація `wd_files` entities детерміновано додає:

```rust
#[sea_orm(
    column_type = "custom(\"ltree\")",
    select_as = "text",
    save_as = "ltree"
)]
pub hierarchy_path: String,
```

`just gen-seaorm-files` виконує цей post-codegen крок і CI перевіряє його повторюваність. Hierarchy predicates інкапсулює repository та передає значення параметрами:

```rust
Expr::cust_with_values(
    "file_entry.hierarchy_path <@ $1::ltree",
    [scope_path],
)
```

String interpolation для `ltree`, `ILIKE`, cursors або компонентів заборонена. SQLx `PgLTree` можна використовувати всередині того самого repository, але wire DTO ніколи не містить внутрішній `hierarchy_path`.

### Міжбазова цілісність

PostgreSQL не підтримує зовнішній ключ між окремими базами, тому `file_entry.device_id` є логічним посиланням. Його цілісність забезпечує прикладна послідовність:

1. бекенд у `main` автентифікує користувача та перевіряє існування, видимість і допустимий життєвий стан пристрою;
2. транзакція й з’єднання `main` звільняються;
3. бекенд читає або змінює лише entries з перевіреним `device_id`;
4. file, parent і browse/search scope адресуються одночасно `file_entry.id` та `file_entry.device_id`; sync не приймає directory IDs;
5. parent перевіряється composite FK, а root і components для sync виводяться лише з `path_syntax` та `absolute_path`.

Етап не виконує фізичного видалення пристроїв. File move між автоматично визначеними коренями входить до етапу й виконується однією транзакцією `FileRegistryDb`; майбутнє фізичне видалення потребуватиме окремого протоколу координації та очищення.

### Provisioning, міграції та права

Чинна топологія підключень не змінюється: `main` використовує `pg_host`, `pg_port`, `pg_user`, `pg_password`, `pg_dbname`, а `wd_files` — `pg_wdfile_host`, `pg_wdfile_port`, `pg_wdfile_user`, `pg_wdfile_password`, `pg_wdfile_dbname`. Налаштований користувач кожної бази, як і раніше, виконує runtime queries і відповідний migration chain. Бази та їхні `seaql_migrations` незалежні, але ця зміна не додає users, passwords, pools, окремих migrator binaries або readiness protocols.

Чинний `oneoff-create-file-registry-database` створює лише database. `file_registry::run_migrations` через `wdfiles_migration::Migrator` встановлює extensions і schema у file database; він є єдиним шляхом file migration. Нова pure-SQL migration починається з:

```sql
CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
```

Після цього вона створює порожню `public.file_entry` з описаними constraints, triggers та indexes. Вона не читає, не `ALTER`-ить і не `DROP`-ить `public.device_file`; extensions не видаляються під час rollback, бо migration не може довести ownership.

Нова main migration в одній transaction перетворює саму таблицю `main.device`: додає `source_label` і object `custom_fields`, переносить у них значення чинних `name`/`hostname`/`ssh_port`, а потім прибирає legacy columns. Це не є file backfill і не змінює `updated_at`.

`main.device_file` і `wd_files.public.device_file` лишаються незалежними legacy tables: їхні rows не імпортуються, не зіставляються та не перевіряються на coverage. Немає manifest, resumable backfill, checkpoint, checksum, cutover або privilege-phase протоколу. Майбутній окремий Logic/API етап почне писати `file_entry` без автоматичного перенесення legacy rows; до нього чинні file routes залишаються на `main.device_file`.


## Логіка (бекенд)

### Прикладний контекст і межі сервісів

HTTP-обробники не реалізують доменні правила самостійно. UI та API викликають один прикладний шар, а той працює з двома типізованими ресурсами:

- `MainDb` — автентифікація, ролі, видимість, супровідні технічні та визначені цим етапом аналітичні відомості пристроїв;
- `FileRegistryDb` — parentless roots, synthetic hierarchy та поточні метадані відомих файлів.

Прикладний шар складається з таких компонентів:

| Компонент | Відповідальність |
| --------- | ---------------- |
| `DeviceActorResolver` | За поточною `Identity` читає логін і ролі з `main`, перевіряє прапорець доступності розділу та формує серверний контекст можливостей. |
| `DeviceVisibility` | Додає до запитів `main.device` єдиний предикат видимості й окремо перевіряє допустимий життєвий стан. |
| `DeviceService` | Створює, читає й атомарно редагує пристрої тільки через `MainDb`. |
| `FileMetadataService` | Після перевірки пристрою через `MainDb` синхронізує file entries, автоматично upsert-ить derived roots/hierarchy та обслуговує root list, folder browse, breadcrumbs і scoped search через `FileRegistryDb`. |
| `SourcePathParser` | Строго розбирає exact absolute path за `posix` або `windows`, повертає canonical root і точні компоненти та не звертається до локальної файлової системи backend-а. |
| `FileCursorCodec` | Канонічно серіалізує fingerprint/sort tuple, підписує continuation cursor і відхиляє version, MAC або parameters mismatch. |
| `DeviceValidation` | Нормалізує значення, класифікує наявні поля за групами й формує помилки з точними шляхами полів. |

У прикладні функції передається не список ролей із запиту, а серверний `DeviceActor` щонайменше з `login`, `can_read`, `can_write_source_data` і `can_write_analytical_data`. Контекст формується заново для кожної операції. Відкликана роль перестає діяти з наступного запиту; клієнт не може передати, розширити або кешувати ефективні можливості.

Репозиторій пристроїв приймає лише `MainDb`, а репозиторій файлового реєстру — лише `FileRegistryDb`. HTTP-обробник не отримує нетипізований пул для вибору бази й не виконує SQL напряму. Це робить випадковий запит до таблиці іншої бази помилкою структури коду.

`FileCursorCodec` читає окремий `device_file_cursor_hmac_key` із `config.toml`/secret injection. Runtime не стартує без щонайменше 32 random bytes, не журналює key і не перевикористовує cookie/session secrets; його ротація може явно інвалідувати короткоживучі cursors.

### Ефективні можливості та видимість

Ролі зводяться до можливостей один раз на початку операції:

| Роль | Читання даних етапу | Технічні відомості й сирі дані | `name`, `aor_ids`, `unit_id` |
| ---- | ------------------- | ------------------------------ | ---------------------------- |
| `Cyber` | так | ні | ні |
| `DeviceSource` | так | так | ні |
| `DeviceAnalyst` | так | так, як успадкована можливість `DeviceSource` | так |
| `Admin` | так | так | так |

Кілька ролей дають об’єднання можливостей. Створення пристрою, зміна його супровідних технічних відомостей і синхронізація файлових метаданих вимагають `can_write_source_data`. Команда створення пристрою не містить `name`, `aor_ids` або `unit_id` і відхиляє їхню присутність незалежно від ролі та значення. Під час редагування фактично передані `name`, `aor_ids` або `unit_id`, навіть із `null` чи порожнім масивом, вимагають `can_write_analytical_data`.

На першому етапі не додається окреме row-level володіння за автором, `source_label`, AOR або підрозділом. За чинної політики видимими є всі пристрої дозволеного життєвого стану для користувача з правом читання розділу. Проте кожен запит на наявний пристрій уже використовує спільний `DeviceVisibility`, а не безумовний `find_by_id`, щоб майбутня зміна політики не вимагала переписувати прикладні операції.

Перевірки виконуються в такому порядку:

1. автентифікувати користувача, перевірити доступність розділу й обчислити можливості;
2. класифікувати фактично наявні в команді групи полів і перевірити можливість для кожної групи;
3. для наявного пристрою знайти його в межах `DeviceVisibility`;
4. для зміни перевірити активний стан пристрою;
5. нормалізувати значення;
6. виконати запис у транзакції цільової бази.

Пошук у межах видимості не розкриває, чи існує невидимий ключ. Автор створення та канал попередньої операції не беруть участі в дозволі. Читання метаданих файлів дозволене також для видимого архівного пристрою, але створення або оновлення метаданих вимагає активного пристрою.

### Групи полів і перевірка ролі

Під час редагування дозвіл визначається за присутністю поля в команді до нормалізації його значення. Заборонене поле не ігнорується, навіть якщо воно має `null`, порожній масив або значення, тотожне поточному. DTO створення окремо не містить `name`, `aor_ids` і `unit_id`, тому будь-яка спроба передати їх відхиляється як невалідна структура до рольової перевірки.

| Група | Поля першого етапу | Можливість запису |
| ----- | ------------------ | ----------------- |
| Технічні відомості пристрою | `source_label`, `external_url`, patch `custom_fields` | `can_write_source_data` |
| Аналітичні відомості пристрою | `name`, `aor_ids`, `unit_id` | `can_write_analytical_data` |
| Технічні метадані файла | `device_id` як адреса batch, обов’язковий `path_syntax`, optional `file_id`, `absolute_path`, `mime_type`, `extension`, `file_metadata_created_at`, `file_metadata_modified_at` під час sync | `can_write_source_data` |
| Системні поля | UUID, `created_by`, `created_at`, `updated_at` | лише бекенд |
| Файловий контент і його стан | відсутні в DTO етапу | поза межами етапу |
| Аналітика файла, ознака оброблення, приховування | відсутні в DTO етапу | поза межами етапу |
| Архівування й відновлення пристрою | відсутні у звичайному patch | поза межами етапу |

DTO створення приймає лише `source_label`, `external_url` і `custom_fields`. DTO редагування приймає patch цих самих полів, а також `name`, `aor_ids` і `unit_id`; дозвіл перевіряється окремо для кожної фактично наявної групи.

Усі вхідні структури використовують відхилення невідомих полів. У команді створення `name`, `aor_ids` і `unit_id` заборонені навіть зі значеннями `null` або `[]`. У команді редагування аналітичне поле поза цією трійкою, застаріла назва поля або спроба передати системне значення відхиляє команду цілком і не створює «успішний» no-op.

### Валідація і нормалізація

Чисті перевірки виконуються до відкриття транзакції. Видимість і поточний стан перевіряються через `MainDb` у межах транзакції відповідної зміни пристрою.

#### Пристрій

- `device_id` має бути канонічно декодованим UUID; новий UUIDv7 створює тільки бекенд.
- `source_label` після `trim` має бути непорожнім. Під час створення воно обов’язкове; у patch його можна пропустити або замінити непорожнім значенням, але не очистити.
- У patch `name` пропущене поле не змінюється, `null` очищує назву, непорожній рядок після `trim` замінює її, а порожній рядок відхиляється.
- У patch `aor_ids` пропущене поле не змінюється, масив чинних унікальних AOR повністю замінює зв’язки, порожній масив очищує їх, а `null` відхиляється.
- У patch `unit_id` пропущене поле не змінюється, `null` очищує підрозділ, а заданий ідентифікатор має посилатися на чинний підрозділ і замінює поточне значення.
- Непорожній `external_url` має бути абсолютним URL зі схемою `http` або `https`; порожній рядок не використовується замість `null`.
- Під час створення відсутні `custom_fields` означають `{}`, а кожне надане значення має бути рядком. Під час оновлення це об’єкт-patch: рядкове значення створює ключ або замінює його поточне значення, `null` видаляє ключ, а пропущений ключ не змінюється. Саме поле `custom_fields: null` і `null` усередині об’єкта створення відхиляються.
- Ключ кастомного поля нормалізується через `trim` і має бути непорожнім; колізія двох ключів після нормалізації відхиляє команду. Рядкове значення зберігається без спеціальної семантики або перетворення за назвами на кшталт `hostname` чи `ssh_port`.
- `created_by`, `created_at` і `updated_at` не приймаються від клієнта. Час створює бекенд в UTC.

Граничні розміри рядків, кількість кастомних полів і розмір команди задаються окремими константами групи `DEVICE_*` у `config.rs`; однакові валідатори використовуються всіма каналами. Константи не дублюються в HTTP-обробниках або фронтенді.

#### Абсолютний шлях і метадані файла

- Команда sync адресує рівно один `device_id`, задає один обов’язковий `path_syntax` зі значенням `posix` або `windows` і містить від 1 до `DEVICE_FILE_SYNC_BATCH_MAX_COUNT` елементів; для першого етапу значення константи — `100`.
- Один batch може містити файли з кількох roots, якщо всі їхні шляхи мають заявлений синтаксис.
- `file_id` відсутній для створення і є UUID для зміни наявного файла. Невідомий ключ або ключ іншого пристрою не створює новий файл.
- `absolute_path` required, зберігається exact без `trim` і не використовується для доступу до файлової системи backend-а.
- `absolute_path` має від 1 до `DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS = 16384` Unicode scalar values і не більш як `DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES = 65536` UTF-8 bytes.
- `posix` приймає лише шлях з одним початковим `/` і щонайменше одним file component; separator — `/`, canonical root — `/`, а trailing або repeated separator заборонений.
- `windows` приймає лише fully qualified drive path на кшталт `C:\dir\file` або UNC path `\\server\share\dir\file`; separator — `\`, canonical root — uppercase `C:\` або exact `\\server\share\`, а `/`, drive-relative, root-relative і device-namespace `\\?\`/`\\.\` форми відхиляються.
- UNC server, share і кожен file component мають бути непорожніми. Обов’язковий початковий `\\` не вважається repeated separator.
- NUL, порожні компоненти, `.` і `..` та шлях, що закінчується separator-ом або позначає лише root, відхиляються. Backend не case-fold-ить і не Unicode-normalize-ить server, share або file components та не застосовує залежні від NTFS/ext4 правила допустимих імен.
- Parser повертає canonical root і щонайменше один точний relative component. Ефективна `name` файла завжди є останнім компонентом; незалежних request-полів `name`, `root_entry_id` або `path_components` немає.
- Якщо `extension` не передано, backend виводить її з суфікса `name` після останньої крапки, не враховуючи крапку на початку або в кінці; якщо суфікса немає, повертає `null`.
- Якщо `mime_type` не передано, backend визначає його через `mime_guess` за extension/name; якщо відповідності немає, повертає `null`. Явні непорожні `extension` і `mime_type` мають пріоритет.
- Файлові часові мітки декодуються як RFC 3339 з timezone і нормалізуються до UTC. Для update пропущене або `null` значення очищується, бо елемент передає повний поточний технічний стан.
- Однакові `path_syntax` і `absolute_path` дозволені для різних UUID. Ідентичність визначає лише `file_id`.
- Update може змінити absolute path, syntax, root, parent, name та metadata зі збереженням `file_id`, `device_id` і `created_at`.

Помилка містить точний шлях на кшталт `files[3].absolute_path`. Перед записом backend декодує всі `file_id`; якщо один ключ повторюється, кожен елемент із ним отримує validation error, а незалежні елементи можуть бути прийняті.

### Створення пристрою

`DeviceService::create` виконує таку послідовність:

1. перевіряє `can_write_source_data` і присутність `source_label`;
2. нормалізує чисті значення й генерує UUIDv7 до побудови `ActiveModel`;
3. відкриває транзакцію `MainDb`;
4. вставляє один рядок `main.device` із `name = NULL` і `unit_id = NULL`, не створюючи рядків `main.device_aor`;
5. формує поточне представлення з порожнім `aor_ids`, фіксує транзакцію й повертає створений UUID.

Створення не приймає `device_id`, файли, `name`, `aor_ids` або `unit_id`; останні три поля відхиляються незалежно від ролі, навіть якщо передано `null` або порожній масив. Створення записує лише один рядок пристрою й не створює AOR-зв’язків. `source_label` не перевіряється на унікальність. Повтор окремої команди створення без ключа навмисно створює інший пристрій; транспортний retry не може непомітно підставляти попередній UUID.

Новий пристрій завжди має `name = NULL`, `unit_id = NULL` і порожній `aor_ids`. Відсутній `external_url` зберігається як `NULL`, а відсутні `custom_fields` — як порожній об’єкт. `name`, `aor_ids` і `unit_id` можна вперше задати лише окремим наступним patch користувача з `can_write_analytical_data`.

### Редагування пристрою

`DeviceService::update` приймає один UUID і непорожній patch:

1. класифікує фактично передані поля та перевіряє `can_write_source_data` і `can_write_analytical_data` для відповідних груп;
2. нормалізує значення, відкриває транзакцію `MainDb` і вибирає видимий активний пристрій через `SELECT … FOR UPDATE`;
3. перевіряє чинність переданих AOR і підрозділу та блокує відповідні рядки довідників через `FOR SHARE`;
4. обчислює наступний стан, зокрема зливає patch кастомних полів і повністю замінює AOR-зв’язки, якщо передано `aor_ids`;
5. якщо ефективних змін немає, завершує без `UPDATE`, не змінює AOR-зв’язки та не змінює `updated_at`;
6. інакше атомарно змінює лише передані поля й AOR-зв’язки та один раз встановлює `device.updated_at`;
7. повертає представлення, сформоване з нового поточного стану.

Помилка будь-якого поля, ролі, довідникового посилання або SQL-операції відкочує весь patch. Порівняння no-op відбувається після нормалізації, тому зміна лише зовнішнього форматування рядка не створює нового поточного стану.

### Читання поточного стану

- Список і деталі пристрою читаються лише з `MainDb`; фільтр активного або архівного стану є явним.
- Відповіді пристрою повертають `source_label`, зовнішнє посилання, кастомні й системні поля, `name`, `aors` і `unit` із поточними назвами довідників.
- Файлова операція спочатку перевіряє видимість пристрою в `MainDb`, звільняє з’єднання, а потім читає `FileRegistryDb`.
- Root list повертає всі directory з `parent_id IS NULL` для device. Відсутність roots є успішним порожнім масивом.
- Folder browse читає лише direct children через B-tree та вимагає explicit `parent_entry_id` кореневої або вкладеної directory. Breadcrumbs містять root і current directory в порядку зростання `nlevel`; для root це масив з одним breadcrumb.
- Scoped search вимагає explicit directory `scope_entry_id`, визначає її path, застосовує `<@` разом із `id <> scope_entry_id`, literal escaped `ILIKE` та технічні фільтри, а relative path components сторінки збирає batch-ом.
- Browse і search читають `limit + 1`, повертають `next_cursor` за наявності наступного entry та не виконують mandatory `COUNT(*)`.
- Cursor є versioned authenticated base64url payload із query fingerprint і останнім sort tuple. Fingerprint включає device, operation, scope, filters і fixed sort, але не `limit` чи `include_breadcrumbs`; dedicated secret не перевикористовує session-cookie key.
- Cursor не закріплює database snapshot між HTTP requests: кожна сторінка цілісна, а гарантія відсутності повторів діє за незмінного набору. Конкурентний rename/move може змінити положення entry між сторінками.
- Недоступність `wd_files` повертає помилку, а не порожній результат. Стабільний UUID є остаточним tie-breaker.

### Синхронізація метаданих файлів і автоматичне створення ієрархії

`FileMetadataService::sync` не відкриває міжбазову транзакцію:

1. перевіряє `can_write_source_data`, `device_id`, `path_syntax`, розмір batch і повторені `file_id`;
2. через `MainDb` одним запитом перевіряє видимий активний пристрій, завершує запит і звільняє з’єднання;
3. незалежно розбирає `absolute_path` кожного file item через `SourcePathParser`, зберігаючи позицію, exact path, canonical root, components та локальну помилку;
4. обробляє валідні унікальні елементи послідовно, кожен у власній транзакції `FileRegistryDb`;
5. повертає один ordered result для кожної вхідної позиції; accepted result містить canonical file і його derived root.

Для нового файла backend генерує file UUIDv7 і candidate UUIDv7 для можливих structure rows до транзакції, забезпечує існування root через `INSERT … ON CONFLICT DO NOTHING`, блокує resolved root row, exact-компонентами знаходить або створює synthetic directory chain і вставляє leaf з exact `absolute_path`. Unique constraints узгоджують конкурентні root/directory inserts; безпечний retry використовує ті самі candidate IDs.

Для update repository спочатку читає поточний root файла, забезпечує існування target root через `INSERT … ON CONFLICT DO NOTHING`, а потім одним `SELECT … ORDER BY id FOR UPDATE` блокує distinct old/target root rows у bytewise UUID order. Після цього він вибирає file за `(file_id, device_id)` через `FOR UPDATE`; якщо root змінився між initial read і leaf lock, item transaction перезапускається. Після revalidation вона upsert-ить target parent chain, атомарно змінює `parent_id`, `name`, `name_key`, `path_syntax`, `absolute_path`, `hierarchy_path` і metadata leaf та знизу вгору видаляє порожні старі synthetic directories. `file_id`, `device_id`, `created_at`, аналітичні дані й контент не змінюються.

Автоматичне знаходження наявного root не змінює його `updated_at`; створення нового root і file відбувається в одній item transaction. Кожен file item має незалежний результат, тому успішний commit ніколи не відкочується через помилку іншої позиції.

Повторний update із тим самим `file_id` і значеннями все одно є новим прийнятим сирим станом: leaf отримує новий `updated_at`.

Помилка з невідомим результатом `COMMIT` ніколи не кодується як `rejected`: service через нове з’єднання намагається звірити resolved root ID, file ID і очікуваний canonical state. Якщо факт commit неможливо довести, HTTP request завершується internal/connection failure без хибного per-item результату, а клієнт виконує root list/browse reconciliation перед keyless retry.

Sync не змінює `main.device.updated_at`, нічого не видаляє через відсутність `file_id` у batch і не створює rows у `main`.

### Транзакції, конкурентність і порядок

- Транзакція `MainDb` ніколи не лишається відкритою під час отримання з’єднання або запиту до `FileRegistryDb`, і навпаки.
- Зміни пристрою серіалізуються row lock на `main.device`.
- Структурні зміни серіалізуються row locks усіх distinct old/target parentless roots одного item, узятих одним `SELECT … ORDER BY id FOR UPDATE` у bytewise UUID order; один root блокується один раз.
- Новий root захищається unique `(device_id, path_syntax, name_key)` та `INSERT … ON CONFLICT DO NOTHING`; конкурентний insert після очікування вибирає вже створений root замість дубліката.
- File update після root locks додатково блокує leaf row й повторно перевіряє його поточний root; зміна під час optimistic read спричиняє bounded retry item transaction.
- Unique synthetic-directory sibling constraint перетворює конкурентне створення того самого chain на один directory entry. Retry повторює всю транзакцію одного file item з уже згенерованими candidate IDs.
- Readers бачать старе або нове цілісне дерево за MVCC, а не частково переміщений leaf чи напівочищений chain.
- Елементи одного batch запускаються послідовно в request order. Конкурентні batches можуть чергуватися лише між уже committed item transactions; клієнтські часові мітки не визначають переможця.
- First-class directory move надалі потребуватиме перевірки циклу та атомарного rewrite всього subtree вартістю `O(descendants)`; етап навмисно не відкриває цю операцію.

Архівування та відновлення не реалізуються цим етапом і не лишаються доступними через старі маршрути. Їх наступна специфікація повинна визначити координацію з `wd_files`.

### Помилки та атомарність

Очікувані помилки використовують наявну модель `AppError`:

| Умова | Доменний результат |
| ----- | ------------------ |
| Немає чинної автентифікації | `Unauthenticated` |
| Немає рольової можливості | `Forbidden` без розкриття значень |
| Ключ не існує, невидимий або файл належить іншому пристрою | `NotFound` |
| Невалідне поле чи стан | `Form` із шляхом поля |
| Порушення очікуваного доменного інваріанта | стислий `BL` без технічних деталей |
| Неочікувана помилка PostgreSQL, пулу або серіалізації | `.c(h!())?`, журналювання контексту й узагальнена внутрішня помилка |

Неочікувана помилка `FileRegistryDb` не перетворюється на успішний порожній результат. SQL, назви підключень, credentials і внутрішній стек не повертаються користувачу.

Створення або patch пристрою мають один результат для всієї команди. Sync має верхньорівневу помилку лише для автентифікації, ролі, невалідних `device_id`, `path_syntax`, batch envelope або непридатного цільового пристрою; після цього кожен файловий елемент має окремий результат:

- успіх із поточним `file_id`, exact absolute path, derived root і метаданими;
- помилка валідації exact `absolute_path` або іншого item field;
- `not_found` для невідомого або належного іншому пристрою `file_id`;
- конфлікт конкурентної зміни, якщо bounded retry вичерпано;
- помилка залежності або внутрішня помилка без деталей інфраструктури.

Жодна помилка не повинна створювати рядок із порожніми обов’язковими даними, змінювати `main` замість `wd_files` або повертати непідтверджений запис як успішний.

Після успішного commit втрата транспортної відповіді лишається мережевою невизначеністю: бекенд не відкочує вже зафіксований стан і не повторює створення з новим UUID. Перед повтором створення клієнт перечитує поточний список, а повтор зміни з відомим ключем застосовує звичайну семантику цієї зміни.

### Журналювання й спостережуваність

Для кожної операції журналюються тип, login, device UUID, root/entry/file UUID за наявності, `path_syntax`, scope kind, кількість повернених рядків, результат, тривалість і цільова база. Для file batch окремо рахуються accepted, validation, not-found, conflict, dependency, internal, retries і lock-wait; для browse/search — page size, cursor presence та returned count.

Exact absolute paths, root names, компоненти, file/directory names, custom field values і майбутній content за замовчуванням не журналюються. Метрики pool, timeout і помилки `main` та `wd_files` мають різні labels.

## Інтерфейс (фронтенд)

### Принцип і межі реалізації

Фронтенд першого етапу є мінімальним наскрізним інтерфейсом для перевірки реального функціоналу етапу, а не завершеним продуктовим інтерфейсом Devices. Він працює з робочими backend-операціями без mock, тимчасових локальних сховищ або підміни успішних відповідей.

Зміни виконуються як вузька адаптація наявних сторінок:

- зберігаються Elm-маршрути `/devices` і `/devices/:id` та чинне монтування React custom elements;
- зберігаються наявні навігація, компонування списку й деталей, MRT-таблиця, drawer створення та редагування, права панель файлів і файловий batch-діалог;
- не створюються нові сторінки, окремий маршрут редагування, новий layout або повний filter builder;
- чинні компоненти розширюються лише настільки, щоб через UI можна було перевірити створення й рольове редагування пристрою, absolute-path файловий sync, folder browsing, breadcrumbs і scoped search;
- із наявного UI прибираються елементи, поля й виклики маршрутів, що не входять до етапу: архівування та відновлення пристрою, приховування та відновлення файла, файловий контент, файлова аналітика, `hostname`, `ssh_port`, теги й окремий опис пристрою;
- значення `hostname`, `ssh_port` або інші довільні джерельні значення можуть існувати лише як звичайні пари `custom_fields`; окремих спеціалізованих контролів для них етап не додає.

Elm-сторінки лишаються тонкими маршрутними оболонками. React-частина використовує згенеровані frontend bindings і типізовані функції API-сервісу; ручні копії backend DTO, старі назви полів або сумісні виклики вилучених маршрутів не допускаються.

### Маршрути й початкове завантаження

#### `/devices`

Маршрут показує наявну сторінку списку. Під час завантаження UI паралельно отримує першу сторінку `/api/device/list` і `/api/device/unit-stats`. Помилка статистики підрозділів показується окремо й не перетворює успішно отриманий список на помилку.

На цьому самому маршруті:

- чинний drawer створення відкривається кнопкою, доступною за `can_write_source_data`;
- чинний drawer редагування відкривається з дії рядка для активного пристрою, якщо користувач має хоча б одну можливість запису;
- вибір рядка або його заголовка переходить до `/devices/:id`.

#### `/devices/:id`

Маршрут показує наявне компонування деталей: відомості пристрою ліворуч і файловий browser у правій панелі. `/api/device/detail` викликається з `include_archived: true`. Після деталей UI окремо завантажує `/api/device/files/roots`, відкриває обраний root через `/files/browse` з його `entry_id` і не блокує початковий показ пристрою помилкою файлового реєстру.

Зміна `id`, повторне завантаження або вихід зі сторінки скасовують чи знецінюють попередні запити, щоб пізня відповідь не замінила стан іншого пристрою.

### Список пристроїв

Наявні пошук, перемикачі активних та архівних записів, статистика за підрозділами й дозавантаження сторінок зберігаються:

- пошук передає `filter_text`;
- перемикачі стану передають `archived_filter` і показують значення `status_counts`;
- вибір підрозділу в наявній бічній панелі передає відповідний `unit_ids`;
- зміна пошуку, стану, підрозділу або сортування скидає `offset` до `0`;
- наступна сторінка додається лише до результату того самого набору фільтрів і сортування; `has_more` визначає доступність дозавантаження.

Повний UI для `needs_analytical_name` та фільтра AOR у цьому етапі не додається: ці параметри перевіряються на рівні API. Відсутність окремого UI-контролу не змінює wire-контракт `/api/device/list`.

MRT-таблиця показує мінімально потрібні колонки:

| Колонка | Відображення |
| ------- | ------------ |
| Назва | Похідний заголовок `name ?? source_label`; за `name === null` поруч показується ознака «Потребує аналітичної назви». |
| Джерельна мітка | `source_label`, навіть якщо вона вже використана як похідний заголовок. |
| AOR | Поточні назви з `aors`; порожній масив показується як відсутнє значення. |
| Підрозділ | Поточна `unit.name` або відсутнє значення. |
| Створено | Локалізоване представлення `created_at`. |
| Оновлено | Локалізоване представлення `updated_at`. |

Сортування таблиці є серверним. Для колонки назви UI передає `display_title_asc` або `display_title_desc`, для дат — відповідний `created_at_*` або `updated_at_*`; UI не пересортовує окремо вже завантажену частину списку. Якщо користувач не задав сортування, застосовується серверне `updated_at_desc`.

Активний або архівний стан рядка має видиму текстову ознаку. Архівний рядок можна відкрити для читання, але він не має дій редагування чи синхронізації.

### Створення пристрою

Наявний drawer створення містить лише:

- обов’язковий `source_label`;
- необов’язковий `external_url`;
- редактор довільних пар `custom_fields`.

Редактор `custom_fields` використовує рядки «ключ — значення», не допускає порожнього або повтореного після `trim` ключа й формує `Record<string, string>`. Форма не показує та не надсилає `name`, `aor_ids`, `unit_id`, файли або системні поля незалежно від ролі користувача.

Клієнт перевіряє лише очевидні обмеження форми, потрібні для швидкого зворотного зв’язку, але backend лишається джерелом істини. Під час запиту повторне надсилання заблоковане. Успішний `DeviceDetails` закриває drawer, оновлює список і дає відкрити створений пристрій за поверненим `id`; невизначена транспортна помилка не запускає автоматичного повторного створення.

### Редагування пристрою

Той самий наявний drawer редагування завантажує поточний `DeviceDetails` і ділить поля на дві секції:

| Секція | Поля | Умова редагування |
| ------ | ---- | ----------------- |
| Джерельні відомості | `source_label`, `external_url`, `custom_fields` | `can_write_source_data` |
| Аналітичні відомості | `name`, `aor_ids`, `unit_id` | `can_write_analytical_data` |

Недоступна секція не показує редагованих контролів. Варіанти AOR і підрозділів завантажуються з чинних довідникових endpoint-ів лише коли показано аналітичну секцію; вже збережені назви до цього доступні без додаткового запиту в `DeviceDetails`.

Форма реалізує patch-семантику:

- до `/api/device/update` потрапляють лише фактично змінені поля;
- очищена `name` передається як `null`, очищений підрозділ — як `unit_id: null`, а очищений набір AOR — як `aor_ids: []`;
- змінений набір AOR завжди передається повністю;
- для `custom_fields` форма порівнює початкові й поточні рядки, передає лише додані або змінені ключі, а вилучені ключі передає зі значенням `null`;
- порожній patch не надсилається, а дія збереження лишається недоступною;
- змішаний patch доступний лише користувачу, який має обидві можливості.

Успішний повний `DeviceDetails` замінює локальний стан деталей і відповідний елемент списку. UI не обчислює самостійно нову `updated_at` і не вважає відсутність її зміни помилкою.

### Деталі пристрою

Ліва інформаційна панель показує всі відомості `DeviceDetails`, потрібні для перевірки етапу:

- стабільний `id` і похідний заголовок;
- `source_label`, `external_url` і всі `custom_fields`;
- аналітичні `name`, поточні назви масиву `aors` і об’єкта `unit`;
- `created_by`, активний або архівний стан;
- `created_at`, `updated_at` і `archived_at` за наявності.

RFC 3339-рядки форматуються чинним спільним formatter-ом дати й часу для читання користувачем; raw epoch або суфікси `_ms` у UI-моделі не використовуються. Відсутні значення відображаються однаково й не підміняються вигаданими даними.

Порожня вкладка «Опис», окремі поля `hostname`, `ssh_port`, теги та дії архівування або відновлення прибираються. Для архівного пристрою вся сторінка лишається доступною для читання, але drawer редагування та файловий sync-діалог недоступні.

### Файлова ієрархія та синхронізація

Права панель спочатку показує root selector. Кожен root є звичайною directory з `parent_entry_id: null`, стабільним `entry_id` і видимою `name`. Після вибору UI викликає `/api/device/files/browse` з root `entry_id` як `parent_entry_id`, далі переходить лише за returned `entry_id`, а не формує структурні raw paths.

Folder browser:

- показує directories перед files у серверному порядку;
- відображає breadcrumbs і дозволяє перейти до будь-якого returned ancestor;
- дозавантажує `next_cursor`, не очікуючи `total`;
- має окремі loading, empty та error states;
- показує дублікати шляху окремими rows із різними `file_id`;
- не пропонує create/rename/move/delete для вкладених directories або roots.

Scoped search передає `scope_entry_id` поточної directory, literal `name_query` щонайменше з трьох символів і технічні filters. Search results показують відносні `path_components`; повернення до browse відновлює directory entry ID. Зміна scope/filter очищує cursor та попередні результати.

Root selector використовується лише для browse/search і не має дії створення. Batch-dialog `/api/device/files/sync` задає один обов’язковий `path_syntax` (`posix` або `windows`) для batch і може прийняти шляхи з кількох автоматично визначених roots.

Rows містять:

- нові files без `file_id`;
- наявні files із незмінним `file_id`;
- обов’язковий exact `absolute_path`;
- optional `mime_type`, `extension`, `file_metadata_created_at`, `file_metadata_modified_at`.

Незалежних inputs `name`, `root_entry_id` або `path_components` немає. UI не split-ить і не join-ить source path для wire-contract; до прийняття він показує exact input, а після прийняття бере filename, root і derived components лише з canonical response.

UI показує root `name` і кожен відносний компонент як окремий segment/breadcrumb. Він не склеює їх у round-trippable pathname й не парсить назад; exact `absolute_path` файла за потреби показується окремим технічним значенням.

Після `200` sync UI зіставляє `results[index]` із input row: `accepted.file` і `accepted.root` замінюють локальний стан, `rejected` лишається для виправлення з exact field errors, а partial success показує одночасно обидва типи результатів. Після закриття UI перечитує roots і active directories; відсутність раніше відомого файла в batch не подається як delete.

Sync доступний лише за `can_write_source_data` для активного пристрою. Content, analytics, hide/restore і directory/root mutation у цьому етапі відсутні.

### Рольові стани

UI обчислює видимість читання й дій з `can_read`, `can_write_source_data` і `can_write_analytical_data`, але не замінює цим серверну перевірку:

| Дія | `Cyber` | `DeviceSource` | `DeviceAnalyst` | `Admin` |
| --- | :-----: | :------------: | :-------------: | :-----: |
| Читати список, деталі й файли | так | так | так | так |
| Створювати пристрій | ні | так | так | так |
| Редагувати джерельні відомості | ні | так | так | так |
| Редагувати аналітичні відомості | ні | ні | так | так |
| Синхронізувати файлові метадані | ні | так | так | так |

Наявна одна ознака `canEdit` замінюється окремими `can_write_source_data` і `can_write_analytical_data`. Відсутня дія не з’являється лише через наявність іншої можливості. Якщо роль відкликана після завантаження сторінки, отриманий `403` показується користувачу, а локальний стан не змінюється.

### Стани, помилки й узгодження стану

- для device list/detail, roots, browse, search і довідників зберігаються незалежні loading, empty та error states;
- `401` використовує чинний shared login transition;
- верхньорівневі `400`, `403`, `404`, `500`, `503` показуються через `PowerAlert`;
- `Form` path `path_syntax` і per-item paths на кшталт `files[2].absolute_path` прив’язуються до відповідних controls;
- submit блокується лише на час власного request;
- UI не застосовує optimistic success: device state береться з `DeviceDetails`, root і file — з `accepted.root` та `accepted.file`, tree — з наступного root list/browse;
- cursor invalidation очищує лише відповідну page sequence;
- помилка одного незалежного request не очищує вже успішно завантажені дані іншого.

### Мінімальна ручна перевірка frontend

У браузері потрібно:

1. перевірити device list search, active/archive states, unit filter, server sorting і pagination;
2. відкрити active та archived `/devices/:id` і побачити details незалежно від файлового request;
3. як `DeviceSource` створити пристрій лише з `source_label`, `external_url`, `custom_fields`;
4. як `DeviceSource` змінити source fields без analytical controls, а як `DeviceAnalyst` задати й очистити `name`, AOR та unit;
5. одним POSIX batch створити files у `/var/log` і `/home/user`, а Windows batch — у drive та UNC roots; побачити автоматично створені canonical roots;
6. у межах одного root синхронізувати nested files із двома однаковими absolute paths і різними `file_id`, перейти щонайменше на два directory levels та скористатися breadcrumbs і cursor pagination;
7. виконати scoped search, перевірити path context і відсутність entries поза subtree;
8. перемістити наявний file новим absolute path до іншого root і побачити той самий `file_id`, нові root/parent/name та відсутність empty old directories;
9. отримати accepted і rejected paths в одному batch, виправити validation error та побачити canonical response;
10. перевірити read-only `Cyber`, write states ролей, archived read-only mode, field error, `403`, dependency error і `401`.

Повний перебір JSON shapes, limits, cursor tampering, duplicate IDs, concurrency, hierarchy triggers і database failures належить backend/API contract tests.

## API

### Нормативний набір маршрутів етапу 1

Усі Devices operations використовують `POST`. Етап 1 має рівно дев’ять маршрутів:

| Маршрут | Тіло запиту | Успішна відповідь | Можливість | Призначення |
| ------- | ----------- | ------------------ | ----------- | ----------- |
| `/api/device/list` | `ListDevicesReq` | `ListDevicesRsp` | `can_read` | Device list/filter/sort/pagination. |
| `/api/device/unit-stats` | відсутнє | `DeviceUnitStatsRsp` | `can_read` | Active device counts by unit. |
| `/api/device/detail` | `DeviceDetailReq` | `DeviceDetails` | `can_read` | One current device. |
| `/api/device/create` | `CreateDeviceReq` | `DeviceDetails` | `can_write_source_data` | Create with technical fields. |
| `/api/device/update` | `UpdateDeviceReq` | `DeviceDetails` | залежить від fields | Atomic device patch. |
| `/api/device/files/roots` | `ListDeviceFileRootsReq` | `ListDeviceFileRootsRsp` | `can_read` | Parentless root directories. |
| `/api/device/files/browse` | `BrowseDeviceFilesReq` | `BrowseDeviceFilesRsp` | `can_read` | Direct children and breadcrumbs. |
| `/api/device/files/search` | `SearchDeviceFilesReq` | `SearchDeviceFilesRsp` | `can_read` | Scoped hierarchy search. |
| `/api/device/files/sync` | `SyncDeviceFilesReq` | `SyncDeviceFilesRsp` | `can_write_source_data` | Absolute-path partial file sync з автоматичними roots. |

`/api/device/files/list`, `/api/device/files/create` і `/api/device/files/roots/create` видаляються без aliases. Archive/restore, file hide/restore, content і file analytics не реєструються та повертають звичайний `404`.

UI повторно використовує чинні AOR/unit dictionary endpoints; їх wire-contract і write permissions не змінюються.

### Загальні wire-правила

- Запити, крім `/api/device/unit-stats`, мають `Content-Type: application/json`; успіх має `200` і raw JSON без universal `data` envelope.
- JSON fields і enum values використовують `snake_case`.
- Request DTO відхиляють unknown fields на кожному structural level; довільними є лише keys усередині `custom_fields`.
- `?` означає optional field, `| null` — окреме дозволене JSON `null`. Response fields не пропускаються: absent scalar — `null`, collection — `[]`, object — `{}`.
- UUID передається canonical lowercase з дефісами. Нові device, root, directory і file UUID генерує лише ЕХО як UUIDv7; у schema-only реалізації 0.14 target table лишається порожньою, а root і directory UUID з’являться лише в окремому Logic/API етапі.
- Усі timestamps є RFC 3339 strings; response нормалізує UTC `Z`, request вимагає explicit timezone.
- Exact `absolute_path`, root names і path components не trim-яться, не case-fold-яться й не Unicode-normalize-яться; єдиний виняток — uppercase canonical Windows drive letter у root name. NUL заборонений.
- Cursor є opaque string. Client не декодує та не модифікує його.
- Responses не містять internal `ltree`, `name_key`, content, content state, analytics, hide state або інших позаетапних fields.

Нормативні спільні response types:

```ts
type UUID = string;
type DateTime = string;
type FieldError = [path: string, message: string];
type CustomFields = Record<string, string>;
type FileEntryKind = "directory" | "file";
type PathSyntax = "posix" | "windows";

interface AorSummary {
  id: number;
  name: string;
}

interface UnitSummary {
  id: number;
  name: string;
}

interface DeviceListItem {
  id: UUID;
  source_label: string;
  name: string | null;
  aors: AorSummary[];
  unit: UnitSummary | null;
  created_by: string;
  archived: boolean;
  created_at: DateTime;
  updated_at: DateTime;
  archived_at: DateTime | null;
}

interface DeviceDetails {
  id: UUID;
  source_label: string;
  name: string | null;
  aors: AorSummary[];
  unit: UnitSummary | null;
  external_url: string | null;
  custom_fields: CustomFields;
  created_by: string;
  archived: boolean;
  created_at: DateTime;
  updated_at: DateTime;
  archived_at: DateTime | null;
}

interface DeviceFileRoot {
  entry_id: UUID;
  device_id: UUID;
  parent_entry_id: null;
  kind: "directory";
  name: string;
  path_syntax: PathSyntax;
  created_at: DateTime;
  updated_at: DateTime;
}

interface FileBreadcrumb {
  entry_id: UUID;
  name: string;
}

interface DeviceFileTreeEntry {
  entry_id: UUID;
  parent_entry_id: UUID;
  kind: FileEntryKind;
  file_id: UUID | null;
  name: string;
  path_components: string[];
  path_syntax: PathSyntax | null;
  absolute_path: string | null;
  mime_type: string | null;
  extension: string | null;
  file_metadata_created_at: DateTime | null;
  file_metadata_modified_at: DateTime | null;
  created_at: DateTime;
  updated_at: DateTime;
}

interface DeviceFile {
  file_id: UUID;
  device_id: UUID;
  parent_entry_id: UUID;
  root_entry_id: UUID;
  path_syntax: PathSyntax;
  absolute_path: string;
  name: string;
  path_components: string[];
  mime_type: string | null;
  extension: string | null;
  file_metadata_created_at: DateTime | null;
  file_metadata_modified_at: DateTime | null;
  created_at: DateTime;
  updated_at: DateTime;
}
```

Для directory `file_id`, `path_syntax`, `absolute_path` і file-only metadata є `null`; root повертається окремим `DeviceFileRoot` із `parent_entry_id: null` і canonical `path_syntax`, а не як child. Для file `entry_id === file_id`, `absolute_path` є exact значенням останнього sync, а `path_components` починається після root і закінчується `name`.

`aors` sort-яться за `id`; `unit` є `null`, якщо не заданий. `custom_fields` key order не є contract. Device display title клієнт виводить як `name ?? source_label`.

### Межі значень

| Величина | Межа |
| -------- | ----: |
| `filter_text`, `source_label`, analytical `name` | 255 scalar values |
| `external_url` | 4096 |
| `custom_fields` pairs | 50 |
| custom key/value | 1–128 / 0–4096 |
| `absolute_path` | 1–16384 scalar values і до 65536 UTF-8 bytes |
| derived `path_components` count | 1–256 |
| один derived path component | 1–1024 scalar values без NUL |
| сума derived component lengths | до 16384 scalar values |
| explicit `mime_type`, `extension` | 1–255 |
| `name_query` | 3–255 scalar values після trim |
| technical filter arrays | до 50 unique values |
| browse/search `limit` | default 100, range 1–100 |
| opaque `cursor` | до 4096 bytes |
| `/files/sync` items | 1–100 |

Device `offset` зберігається лише в `/api/device/list`. File browse/search не приймають `offset` або `total` flag.

### Верхньорівневі помилки

Успішні response DTO є raw JSON-об’єктами, але помилки зберігають чинний wire-формат `AppError`:

| HTTP | Умова | Тіло |
| ---- | ----- | ---- |
| `400` | `Form` — невалідна структура, поле або стан | JSON-масив пар `FieldError`: `[["path","message"]]`. |
| `400` | `BL` — порушений доменний інваріант без окремого поля | Безпечний для користувача plain-text опис. |
| `401` | Немає чинної автентифікації | Plain text `Unauthenticated`. |
| `403` | Немає необхідної рольової можливості | Plain text `Forbidden` без назв ролей або значень полів. |
| `404` | Ключ відсутній, невидимий або належить іншому пристрою | Plain text `Not found`. |
| `500` | Неочікувана внутрішня помилка | Plain text `Internal server error`. |
| `503` | Runtime завершує роботу | Plain text `Service unavailable: server is shutting down`. |

Невалідний JSON, unknown field або wrong type перетворюються на `Form`. Paths мають вигляд `device_id`, `path_syntax`, `files[2].absolute_path`. Невидимість не відрізняється від відсутності через `404`; SQL, DB names, credentials, internal paths і protected values не повертаються.

Для `/api/device/files/sync` верхньорівнева таблиця застосовується до target device, `path_syntax` і batch envelope. Після їх валідації помилки окремих file items кодуються в `SyncDeviceFilesRsp` зі статусом `200`.

### `POST /api/device/list`

```ts
type DeviceArchivedFilter = "active_only" | "archived_only" | "all";
type DeviceListSortBy =
  | "display_title_asc"
  | "display_title_desc"
  | "created_at_asc"
  | "created_at_desc"
  | "updated_at_asc"
  | "updated_at_desc";

interface ListDevicesReq {
  filter_text?: string | null;
  archived_filter?: DeviceArchivedFilter | null;
  needs_analytical_name?: boolean | null;
  aor_ids?: number[] | null;
  unit_ids?: number[] | null;
  limit?: number | null;
  offset?: number | null;
  sort_by?: DeviceListSortBy[];
}

interface DeviceStatusCounts {
  active: number;
  archived: number;
}

interface ListDevicesRsp {
  list: DeviceListItem[];
  total: number;
  has_more: boolean;
  status_counts: DeviceStatusCounts;
}
```

Правила запиту:

- пропущені або `null` фільтри не обмежують результат; `archived_filter` за замовчуванням дорівнює `active_only`;
- порожні `aor_ids` або `unit_ids` також не обмежують результат; у межах одного масиву діє `OR`, а різні фільтри поєднуються через `AND`; повторені ідентифікатори не змінюють результат;
- `needs_analytical_name: true` означає `name IS NULL`, а `false` — `name IS NOT NULL`;
- `filter_text`, порожній після `trim`, не обмежує результат; інакше це literal case-insensitive substring-пошук за `source_label` і `name` та literal substring-пошук за канонічним UUID; символи `%` і `_` не мають SQL-wildcard семантики;
- пропущений або порожній `sort_by` означає `["updated_at_desc"]`; кілька критеріїв застосовуються в переданому порядку, а повтор одного логічного поля з різними напрямками відхиляється;
- `display_title_*` сортує за `name`, а за її відсутності — за `source_label`, без урахування регістру; `created_at_*` сортує за датою створення, а `updated_at_*` — за датою останньої зміни; остаточним tie-breaker завжди є `id ASC`.

`total` враховує всі фільтри разом із `archived_filter`; `has_more` дорівнює `offset + list.length < total`. `status_counts` враховує пошук, `needs_analytical_name`, AOR і підрозділ, але навмисно ігнорує лише `archived_filter`, щоб UI міг показати кількості активних та архівних для того самого набору. Пагінація не має пропусків або повторів за незмінних даних і незмінного запиту.

Фільтри за тегами, важливістю, контентом або наявністю файлів не входять до першого етапу й не приймаються цим DTO.

### `POST /api/device/unit-stats`

Запит не має тіла, включно з порожнім JSON-об’єктом.

```ts
interface DeviceUnitStat {
  unit: UnitSummary;
  count: number;
}

interface DeviceUnitStatsRsp {
  units: DeviceUnitStat[];
}
```

Endpoint рахує лише видимі активні пристрої з заданим підрозділом. Рядки з `count = 0` і пристрої без підрозділу не повертаються. Кожен елемент містить `UnitSummary` з ідентифікатором і поточною назвою підрозділу; `units` впорядковується за чинним природним військовим порядком довідника.

### `POST /api/device/detail`

```ts
interface DeviceDetailReq {
  device_id: UUID;
  include_archived?: boolean | null;
}

// 200: DeviceDetails
```

Пропущене або `null` `include_archived` означає `false`. Для архівного пристрою такий запит повертає `404`; `include_archived: true` дозволяє read-only відповідь. Files не входять до `DeviceDetails` і читаються через roots/browse/search.

### `POST /api/device/create`

```ts
interface CreateDeviceReq {
  source_label: string;
  external_url?: string | null;
  custom_fields?: Record<string, string>;
}

// 200: DeviceDetails
```

`source_label` після `trim` є обов’язковою. Пропущене або `null` `external_url` зберігається як `NULL`; пропущене `custom_fields` означає `{}`, але саме поле `custom_fields: null` і значення `null` усередині об’єкта невалідні.

DTO не приймає `device_id`, `name`, `aor_ids`, `unit_id`, `files` або системні поля — навіть із `null` чи `[]` і навіть від `DeviceAnalyst` або `Admin`. `created_by` береться з автентифікованої сесії. Успішна відповідь має новий `id`, `name: null`, `aors: []`, `unit: null`, `archived: false`, `archived_at: null` і серверні дати `created_at` та `updated_at`.

Кожен окремий успішний запит створює новий UUID; `source_label` не є idempotency key. Після невизначеного транспортного результату клієнт спочатку перечитує список, а не сліпо створює повторно.

### `POST /api/device/update`

```ts
interface UpdateDeviceReq {
  device_id: UUID;
  source_label?: string;
  external_url?: string | null;
  custom_fields?: Record<string, string | null>;
  name?: string | null;
  aor_ids?: number[];
  unit_id?: number | null;
}

// 200: DeviceDetails
```

Окрім `device_id`, запит має містити щонайменше одну фактичну зміну; порожній patch або лише `custom_fields: {}` повертає `Form`. Присутність поля визначається до нормалізації та рольової перевірки:

DTO не приймає `files`, файлові метадані або системні поля; файли синхронізуються лише окремим `/api/device/files/sync`.

| Поле | Пропущено | `null` | Передане значення | Можливість |
| ---- | --------- | ------ | ----------------- | ----------- |
| `source_label` | без зміни | невалідно | замінює непорожнім значенням після `trim` | `can_write_source_data` |
| `external_url` | без зміни | очищує | замінює валідним абсолютним URL | `can_write_source_data` |
| `custom_fields` | без зміни | невалідно | object-patch: рядок створює або замінює ключ, значення `null` видаляє ключ | `can_write_source_data` |
| `name` | без зміни | очищує | замінює непорожньою назвою після `trim` | `can_write_analytical_data` |
| `aor_ids` | без зміни | невалідно | повністю замінює набір; `[]` очищує всі зв’язки | `can_write_analytical_data` |
| `unit_id` | без зміни | очищує | замінює посиланням на чинний підрозділ | `can_write_analytical_data` |

Змішаний patch потребує обох можливостей; `DeviceAnalyst` і `Admin` їх мають через успадкування. AOR мають бути чинними й унікальними, а `unit_id` — посилатися на чинний підрозділ. Невалідне або заборонене поле відхиляє всю команду без часткового запису. Архівний пристрій повертає `Form` за шляхом `device_id`.

Успіх повертає повний поточний `DeviceDetails`, а не лише змінені поля. Якщо всі дозволені нормалізовані значення вже збігаються з поточними, endpoint однаково повертає `200`, але не виконує `UPDATE` і не змінює `updated_at`.

### `POST /api/device/files/roots`

```ts
interface ListDeviceFileRootsReq {
  device_id: UUID;
}

interface ListDeviceFileRootsRsp {
  roots: DeviceFileRoot[];
}
```

Roots видимого active або archived device sort-яться за `path_syntax`, exact `name`, потім `entry_id`. Для одного `(device_id, path_syntax, canonical name)` існує не більш як один root. Невідомий device повертає `404`; registry failure — `500`, а не empty list.


### `POST /api/device/files/browse`

```ts
interface BrowseDeviceFilesReq {
  device_id: UUID;
  parent_entry_id: UUID;
  include_breadcrumbs?: boolean | null;
  limit?: number | null;
  cursor?: string | null;
}

interface BrowseDeviceFilesRsp {
  breadcrumbs: FileBreadcrumb[];
  entries: DeviceFileTreeEntry[];
  next_cursor: string | null;
}
```

`parent_entry_id` required і має бути root або synthetic directory цього device. `include_breadcrumbs` default `true`; якщо `false`, response містить `[]`; якщо `true`, breadcrumbs містять root і current parent.

Fixed order: directory before file, then exact `name_key ASC`, then `entry_id ASC`. Backend reads `limit + 1`; `next_cursor` є authenticated continuation того самого fingerprint і sort tuple. Duplicate files із тим самим name повертаються окремо. Mandatory count і deep `OFFSET` відсутні.

### `POST /api/device/files/search`

```ts
interface SearchDeviceFilesReq {
  device_id: UUID;
  scope_entry_id: UUID;
  name_query?: string | null;
  kinds?: FileEntryKind[] | null;
  mime_types?: string[] | null;
  extensions?: string[] | null;
  file_metadata_modified_from?: DateTime | null;
  file_metadata_modified_to?: DateTime | null;
  limit?: number | null;
  cursor?: string | null;
}

interface SearchDeviceFilesRsp {
  entries: DeviceFileTreeEntry[];
  next_cursor: string | null;
}
```

Scope required і має бути root/directory цього device. Empty filters не обмежують subtree. Заданий `name_query` містить 3–255 scalar values і є literal case-insensitive substring; `%`, `_` і `\` escape-яться та не мають wildcard semantics. Metadata filters не match-ять directories. Межі modified inclusive; `from > to` є `Form`.

Order і cursor rules ті самі, що browse. Scope реалізує `<@`, name search — trigram index, а `path_components` results будуються batch ancestor query.

### `POST /api/device/files/sync`

```ts
interface SyncDeviceFileItem {
  file_id?: UUID;
  absolute_path: string;
  mime_type?: string | null;
  extension?: string | null;
  file_metadata_created_at?: DateTime | null;
  file_metadata_modified_at?: DateTime | null;
}

interface SyncDeviceFilesReq {
  device_id: UUID;
  path_syntax: PathSyntax;
  files: SyncDeviceFileItem[];
}

type FileSyncErrorKind =
  | "validation"
  | "not_found"
  | "conflict"
  | "dependency"
  | "internal";

interface FileSyncAccepted {
  index: number;
  status: "accepted";
  operation: "created" | "updated";
  root: DeviceFileRoot;
  file: DeviceFile;
}

interface FileSyncRejected {
  index: number;
  status: "rejected";
  error: {
    kind: FileSyncErrorKind;
    message: string;
    field_errors: FieldError[];
  };
}

interface SyncDeviceFilesRsp {
  results: Array<FileSyncAccepted | FileSyncRejected>;
}
```

Верхньорівнево перевіряються authentication, capability, canonical `device_id`, mandatory `path_syntax`, nonempty batch bounds та active visible device. Invalid envelope — `400`; invisible/unknown device — `404`; archived device — `400 Form`. Один batch може автоматично створити або використати кілька roots одного path syntax.

Після envelope validation кожна input position отримує один ordered result і HTTP `200`, навіть якщо всі files rejected. Root, parent і filename для кожного валідного item backend виводить із exact `absolute_path`; request не приймає жодних directory IDs або components.
Missing/unknown field, wrong JSON type або неканонічний UUID є structural `400 Form` для всього request із точним path. Після успішного structural decode синтаксично невалідний рядок шляху, повторений `file_id` та невалідні item values стають ordered per-item `rejected` results.

Семантика item:

- absent `file_id` створює UUIDv7 file; `file_id: null` invalid;
- present `file_id` адресує file цього `device_id` і повністю замінює його technical state;
- `absolute_path` required, exact і має відповідати batch `path_syntax`; independent `name`, `root_entry_id` і `path_components` є unknown fields;
- POSIX, Windows drive та Windows UNC форми, separators і заборонені components визначені в нормативній backend-валідації вище;
- absent/null extension та MIME виводяться з final component; explicit nonempty values override derivation;
- absent/null file timestamps стають `null`;
- update зберігає file ID, device identity і `created_at`, але може змінити syntax, root, parent, name, exact path, metadata та `updated_at`;
- identical syntax/path не unique для files; два keyless items створюють два files;
- repeated nonnull `file_id` відхиляє всі occurrences;
- omitted known IDs нічого не видаляють;
- file іншого device або unknown file повертає `not_found` без disclosure; cross-root update того самого device дозволений.

| `kind` | Умова | `field_errors` |
| ------ | ----- | -------------- |
| `validation` | Invalid item/path/value або duplicate `file_id`. | Nonempty exact paths. |
| `not_found` | File absent, invisible або належить іншому device. | `[]`. |
| `conflict` | Safe retry exhausted. | `[]`. |
| `dependency` | Registry unavailable/timeout for item. | `[]`. |
| `internal` | Other unexpected item failure. | `[]`. |

Кожен valid item має окрему `wd_files` transaction з ordered old/target root row locks. `accepted.root` і `accepted.file` є єдиним підтвердженням commit та містять canonical root/components поряд з exact source path; failure одного item не відкочує accepted siblings.

Якщо транспорт обривається до отримання response, клієнт не припускає rejection: він перечитує roots і browse цільового derived path перед повтором. Це особливо важливо для keyless file create, оскільки клієнтського operation ID у V1 немає.

## Наскрізні технічні сценарії

1. create device with `name = NULL`, `unit_id = NULL`, empty AOR only in `main`;
2. reject create without `source_label` or with analytical fields;
3. atomic source/analytical device patches with role separation;
4. parse POSIX, Windows drive and UNC absolute paths into canonical roots and exact components;
5. reject relative, mixed-separator, trailing-separator, empty, dot and dot-dot paths;
6. auto-create one root per device/syntax/canonical name and shared synthetic directory chains;
7. create one multi-root batch and return a derived root for every accepted item;
8. create two files with identical syntax/path and distinct UUIDs;
9. derive name/extension/MIME from final component while preserving exact absolute path;
10. move a file within one root and across roots/syntax while preserving ID and out-of-stage state;
11. prune only empty old synthetic directories and retain roots;
12. reject other-device/unknown file key without disclosure;
13. keep omitted known files unchanged;
14. partial batch success with one transaction/result per item;
15. reject duplicate `file_id` occurrences while accepting independent items;
16. concurrent root/directory upserts yield one canonical root and one directory per parent/name;
17. concurrent cross-root file moves preserve parent/path invariant and expose old or new complete tree;
18. root list for active and archived visible device;
19. root/direct-child browse with directories-first keyset pagination;
20. breadcrumbs ordered root-to-parent;
21. scoped subtree search with escaped literal query and technical filters;
22. cursor rejection after scope/filter change or tampering;
23. registry failure is explicit and never an empty success;
24. `main` failure performs no `wd_files` write;
25. archived registry read succeeds while sync rejects;
26. excluded and old `/files/list`, `/files/create` and `/files/roots/create` routes return `404`.

## Перевірка та критерії приймання

### Модель даних

- `main` і `wd_files` використовують чинні окремі config fields, connections та незалежні `seaql_migrations`;
- наявний `migration::run_migration_1` застосовує обидва migration chains без нового pool, migrator binary або readiness protocol;
- main migration дає `source_label text not null`, nullable `name`, `custom_fields jsonb not null`, зберігає archive/FK/index invariants і не має `hostname`/`ssh_port`;
- file migration встановлює `ltree` і `pg_trgm` у `public`, створює порожню `public.file_entry` з target constraints, triggers і десятьма indexes;
- `main.device_file` та `wd_files.public.device_file` існують без змін, а жоден legacy row не копіюється чи не валідується на coverage;
- generated `file_entry` entity має детермінований `select_as = "text"` / `save_as = "ltree"` mapping;
- майбутній file Logic/API cutover є окремою роботою; чинні device file routes і wire DTO не змінюються.


### Бекенд

- typed repositories use only their designated pool;
- device create/update never touches registry;
- file operations release `MainDb` before acquiring `FileRegistryDb`;
- ordered old/target root row locks і file row locks preserve hierarchy invariants under concurrency;
- strict source parser preserves exact path/component bytes without trim, case fold, Unicode normalization or local-filesystem access;
- root/directory upsert, chain prune and same-/cross-root file move are atomic;
- duplicate paths remain distinct files; omitted IDs remain unchanged;
- direct children, ancestors, subtree and scoped-name queries use intended indexes under `EXPLAIN (ANALYZE, BUFFERS)` on representative data;
- browse/search use `limit + 1`, opaque keyset cursor and no mandatory count/deep offset;
- raw hierarchy predicates and search values are parameterized;
- failures remain explicit and partial batch order/results are preserved.

### Фронтенд

- existing routes/layout/custom elements are adapted without a new page;
- root selector, folder browser, breadcrumbs, scoped search and cursor loading work end to end;
- duplicate paths are separate rows with different IDs;
- sync sends mandatory path syntax plus exact absolute paths and no root IDs/components/independent name;
- accepted results return canonical roots and files; cross-root move preserves selection identity and refreshes affected trees;
- roles and archived read-only mode gate actions without replacing server checks;
- all ten browser scenarios pass with visible API errors.

### API

- router/contract tests fix exactly nine routes and `404` all excluded aliases;
- schemas enforce snake_case, null/omission, unknown-field rejection and exact field paths;
- sync auto-creates/upserts canonical roots, returns their stable IDs and never duplicates one device/syntax/root identity;
- browse tests root/nested parent, ordering, duplicates, breadcrumbs, cursor continuation and invalid cursor;
- search tests subtree containment, literal wildcard escaping, filters, path context and cursor;
- sync tests path-syntax parsing, multi-root creation, derivation, duplicate paths, cross-root move, pruning, all five error kinds and partial success;
- responses never expose `ltree`, `name_key`, content or out-of-scope analytics;
- generated bindings, client and UI use the single contract without handwritten DTO copies.

## Розгортання першого етапу

1. чинним `oneoff-create-file-registry-database` створити тільки database `wd_files`;
2. за відсутності mixed-version application processes застосувати чинний startup migration path, який послідовно запускає main та file migration chains;
3. перевірити, що `main.device` має target fields, `wd_files.public.file_entry` існує порожньою, обидві legacy `device_file` tables не змінилися, а `ltree` і `pg_trgm` встановлені в `public`;
4. на development `wd` виконати `just gen-seaorm`, а для file database — `just gen-seaorm-files --mode=<mode>` і `just check-seaorm-files --mode=<mode>`;
5. виконати schema, adapter і generated-entity behavior checks;
6. розгорнути сумісний backend без перенесення file rows, dual write або API/frontend cutover. Майбутній Logic/API етап працюватиме з `file_entry` окремим deployment.


## Відкриті технічні рішення

Невирішених технічних питань для schema-only підготовки немає: `main.device` має lossless guarded rollback, `file_entry` лишається порожньою, а чинні connection, provisioning і migration paths збережені. Логіка hierarchy, API та frontend cutover є окремим наступним етапом і не можуть непомітно змінювати функціональний дизайн версії 0.13.

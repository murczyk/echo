# Інтеграція зовнішнього сервісу з ЕХО як джерела пристроїв

- **Аудиторія:** розробники зовнішніх сервісів-джерел
- **Роль інтеграції:** `DeviceSource`
- **Контракт:** Devices API, етап 1
- **Дата актуальності:** 2026-07-24

## 1. Призначення

Цей документ описує зовнішній HTTP/JSON-контракт, достатній для інтеграції сервісу з ЕХО як джерела пристроїв. Для роботи з API не потрібно знати внутрішню будову ЕХО.

Інтеграція може:

- автентифікуватися за окремим обліковим записом;
- створювати пристрої з джерельними технічними відомостями;
- оновлювати технічні відомості створених або інших видимих пристроїв;
- синхронізувати поточні метадані відомих файлів без передавання файлового вмісту;
- читати пристрої, корені файлової ієрархії, каталоги та результати пошуку для перевірки прийнятого стану.

API цього етапу **не передає файловий вміст**, не приймає порожні каталоги як окремі об’єкти, не видаляє файли через відсутність у batch і не надає операцій архівування, приховування чи файлової аналітики.

Пов’язані проєктні документи:

- [`TECHNICAL_SPEC_STAGE_1.md`](./TECHNICAL_SPEC_STAGE_1.md);
- [`API_IMPLEMENTATION_PLAN.md`](./API_IMPLEMENTATION_PLAN.md);
- [`BACKEND_LOGIC_IMPLEMENTATION_PLAN.md`](./BACKEND_LOGIC_IMPLEMENTATION_PLAN.md);
- [`FRONTEND_IMPLEMENTATION_PLAN.md`](./FRONTEND_IMPLEMENTATION_PLAN.md);
- [`DEVICES.md`](./DEVICES.md).

## 2. Карта API

Усі маршрути пристроїв етапу 1 використовують `POST`.

| Метод і маршрут | Право | Призначення |
| --- | --- | --- |
| `POST /api/user/login` | облікові дані користувача | Створити автентифіковану cookie-сесію. |
| `POST /api/device/list` | читання | Знайти та посторінково отримати пристрої. |
| `POST /api/device/unit-stats` | читання | Отримати кількість активних пристроїв за підрозділами. |
| `POST /api/device/detail` | читання | Отримати повні поточні відомості одного пристрою. |
| `POST /api/device/create` | запис джерельних даних | Створити пристрій. |
| `POST /api/device/update` | залежить від присутніх полів | Атомарно оновити поля пристрою. |
| `POST /api/device/files/roots` | читання | Отримати автоматично визначені файлові корені пристрою. |
| `POST /api/device/files/browse` | читання | Отримати безпосередніх дітей каталогу та breadcrumbs. |
| `POST /api/device/files/search` | читання | Шукати entries у межах одного піддерева. |
| `POST /api/device/files/sync` | запис джерельних даних | Частково успішно синхронізувати batch файлових метаданих. |

## 3. Транспорт і сесія

### 3.1. Base URL і HTTPS

Base URL залежить від розгортання та надається адміністратором ЕХО, наприклад:

```text
https://echo.example.org
```

У production потрібно використовувати HTTPS. Не записуйте пароль або session cookie в логи, трасування чи файли репозиторію.

### 3.2. Загальні HTTP-правила

- Усі JSON-запити до `/api/device/*`, крім `/api/device/unit-stats`, повинні мати `Content-Type: application/json`.
- Рекомендований заголовок відповіді: `Accept: application/json`.
- `/api/device/unit-stats` не приймає тіло, навіть `{}`.
- Успішна відповідь має HTTP `200` і містить безпосередньо JSON-значення без загальної обгортки `data`.
- Максимальний розмір JSON-запиту до Devices API — 20 MiB.
- Назви JSON-полів та enum-значення використовують `snake_case`.
- Request DTO Devices API строгі: невідоме поле на будь-якому структурному рівні відхиляє запит. Виняток — довільні назви ключів усередині `custom_fields`.
- Перевірка сесії виконується до декодування Devices-запиту. Тому прострочена або відсутня сесія повертає `401`, навіть якщо JSON також невалідний.

### 3.3. Вхід у систему

Адміністратор ЕХО повинен створити окремий обліковий запис і надати йому роль `DeviceSource`. API використовує cookie-сесію, а не Bearer token.

Запит:

```json
{
  "user": "device-source-service",
  "password": "replace-with-secret"
}
```

Приклад із cookie jar:

```bash
export ECHO_BASE_URL='https://echo.example.org'
export ECHO_COOKIE_JAR='./echo-cookie.jar'

curl --fail-with-body --silent --show-error \
  --cookie-jar "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data @login.json \
  "$ECHO_BASE_URL/api/user/login"
```

Успіх:

```json
null
```

HTTP-відповідь також містить `Set-Cookie`. У кожному наступному запиті потрібно повертати цю cookie:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data @request.json \
  "$ECHO_BASE_URL/api/device/detail"
```

Невірний пароль повертає `400 Form`, наприклад:

```json
[
  ["password", "Невірний пароль"]
]
```

Відсутня або недійсна сесія на Devices endpoint повертає:

```text
HTTP 401
Unauthenticated
```

Після `401` потрібно повторно виконати login і повторювати початкову операцію лише з урахуванням правил ідемпотентності з розділу [14](#14-retry-ідемпотентність-і-reconciliation).

## 4. Ролі та дозволи

| Роль | Читання | Створення пристрою | Технічний update | File sync | `name`, `aor_ids`, `unit_id` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `Cyber` | так | ні | ні | ні | ні |
| `DeviceSource` | так | так | так | так | ні |
| `DeviceAnalyst` | так | так | так | так | так |
| `Admin` | так | так | так | так | так |

Кілька ролей об’єднують можливості. Ролі та дозволи визначає ЕХО за сесією; клієнт не передає їх у JSON.

Для `DeviceSource` критично важливі такі правила:

- create структурно не приймає `name`, `aor_ids` або `unit_id` навіть із `null` чи `[]`;
- update із фактично присутнім `name`, `aor_ids` або `unit_id` повертає `403`, навіть якщо значення `null`, `[]`, поточне або начебто не змінює стан;
- змішаний update технічних та аналітичних полів відхиляється цілком, без часткового запису;
- роль не є ознакою володіння конкретним пристроєм. За чинною політикою `DeviceSource` може читати й технічно змінювати всі видимі пристрої дозволеного життєвого стану. Облікові дані інтеграції потрібно захищати відповідно.

Архівний пристрій можна читати, але `update` та `files/sync` для нього відхиляються.

## 5. Типи, формати та presence semantics

### 5.1. Базові типи

| Позначення | JSON-представлення | Правила |
| --- | --- | --- |
| `UUID` | string | Canonical lowercase hyphenated UUID, наприклад `019c8e6d-4a4d-7b20-9d31-71d09f970001`. Інші форми відхиляються. |
| `DateTime` | string | RFC 3339. Request вимагає явний timezone (`Z` або offset); response нормалізується до UTC `Z`. Часткова секунда може бути відсутня. |
| `integer` | JSON number | Ціле число, не рядок. Ідентифікатори AOR і підрозділів мають тип signed 64-bit integer. |
| `FieldError` | `[string, string]` | Пара `[path, message]`. Шлях може бути `device_id`, `cursor` або `files[2].absolute_path`. |
| `CustomFields` | object | Пари `string -> string` у response. Порядок ключів не є контрактом. |
| `FileEntryKind` | string enum | `directory` або `file`. |
| `PathSyntax` | string enum | `posix` або `windows`. |

Нові `device_id`, root/directory `entry_id` і `file_id` генерує ЕХО. Клієнт не генерує їх самостійно.

### 5.2. Відсутнє поле, `null` і порожня колекція

Ці значення не взаємозамінні:

- **required**: поле мусить бути присутнє й не може бути `null`;
- **optional**: поле можна пропустити;
- **nullable**: JSON `null` є окремим дозволеним значенням;
- **presence-aware patch**: сама присутність поля визначає permission check і зміну;
- `[]` та `{}` є переданими значеннями, а не відсутніми полями;
- response-поля не пропускаються: відсутній scalar повертається як `null`, collection як `[]`, `custom_fields` як `{}`.

Наприклад, у device update:

- пропущене `external_url` нічого не змінює;
- `external_url: null` очищує значення;
- `external_url: ""` є помилкою;
- пропущене `aor_ids` нічого не змінює;
- `aor_ids: []` очищує всі AOR, але для `DeviceSource` саме поле заборонене;
- `aor_ids: null` структурно невалідне.

### 5.3. Межі значень

| Значення | Межа |
| --- | ---: |
| JSON payload Devices API | 20 MiB |
| `filter_text`, `source_label`, `name` | до 255 Unicode scalar values після нормалізації |
| `external_url` | до 4096 Unicode scalar values |
| `custom_fields` | до 50 пар |
| custom key | 1–128 Unicode scalar values після `trim` |
| custom value | 0–4096 Unicode scalar values; значення не trim-иться |
| `absolute_path` | 1–16384 Unicode scalar values і не більше 65536 UTF-8 bytes |
| кількість компонентів шляху | 1–256 після root |
| один компонент шляху | 1–1024 Unicode scalar values |
| сума довжин компонентів | до 16384 Unicode scalar values |
| explicit `mime_type`, `extension` | 1–255 Unicode scalar values після `trim` |
| `name_query` | 3–255 Unicode scalar values після `trim` |
| кожен search filter array | до 50 елементів |
| device list `limit` | default 100, range 1–100 |
| browse/search `limit` | default 100, range 1–100 |
| browse/search `cursor` | до 4096 bytes |
| `files/sync` batch | 1–100 items |

## 6. Спільні response-моделі

### 6.1. AOR і підрозділ

`AorSummary` і `UnitSummary` мають однакову форму:

| Поле | Тип | Значення |
| --- | --- | --- |
| `id` | integer | Ідентифікатор довідника. |
| `name` | string | Поточна назва. |

### 6.2. `DeviceListItem`

| Поле | Тип | Значення |
| --- | --- | --- |
| `id` | UUID | Стабільний ідентифікатор пристрою. |
| `source_label` | string | Джерельна технічна мітка. Не унікальна. |
| `name` | string або `null` | Аналітична назва. |
| `aors` | `AorSummary[]` | AOR, впорядковані за `id`. |
| `unit` | `UnitSummary` або `null` | Підрозділ. |
| `created_by` | string | Login користувача, який створив пристрій. |
| `archived` | boolean | Ознака архівного стану. |
| `created_at` | DateTime | Час створення в ЕХО. |
| `updated_at` | DateTime | Час останньої прийнятої зміни. |
| `archived_at` | DateTime або `null` | Час архівування. |

Для відображення використовуйте `name ?? source_label`.

### 6.3. `DeviceDetails`

`DeviceDetails` містить усі поля `DeviceListItem` та додатково:

| Поле | Тип | Значення |
| --- | --- | --- |
| `external_url` | string або `null` | Нормалізований абсолютний HTTP(S) URL джерела. |
| `custom_fields` | `Record<string, string>` | Поточний повний набір джерельних custom fields. |

Файли не входять до `DeviceDetails`.

### 6.4. `DeviceFileRoot`

| Поле | Тип | Значення |
| --- | --- | --- |
| `entry_id` | UUID | ID кореневого каталогу для browse/search. |
| `device_id` | UUID | Пристрій-власник. |
| `parent_entry_id` | `null` | Для root завжди `null`. |
| `kind` | `directory` | Для root завжди `directory`. |
| `name` | string | Canonical root: `/`, `C:\` або `\\server\share\`. |
| `path_syntax` | PathSyntax | Синтаксис шляхів цього root. |
| `created_at` | DateTime | Час появи root в ЕХО. |
| `updated_at` | DateTime | Час останньої зміни root. |

### 6.5. `FileBreadcrumb`

| Поле | Тип | Значення |
| --- | --- | --- |
| `entry_id` | UUID | ID root або каталогу. |
| `name` | string | Назва компонента. |

### 6.6. `DeviceFileTreeEntry`

| Поле | Тип | Directory | File |
| --- | --- | --- | --- |
| `entry_id` | UUID | ID каталогу | дорівнює `file_id` |
| `parent_entry_id` | UUID | батьківський каталог | батьківський каталог |
| `kind` | FileEntryKind | `directory` | `file` |
| `file_id` | UUID або `null` | `null` | стабільний file ID |
| `name` | string | точний компонент | останній компонент шляху |
| `path_components` | `string[]` | шлях після root до каталогу | шлях після root включно з filename |
| `path_syntax` | PathSyntax або `null` | `null` | синтаксис останнього sync |
| `absolute_path` | string або `null` | `null` | exact значення останнього sync |
| `mime_type` | string або `null` | `null` | поточний MIME |
| `extension` | string або `null` | `null` | розширення без початкової крапки |
| `file_metadata_created_at` | DateTime або `null` | `null` | час створення за метаданими джерела |
| `file_metadata_modified_at` | DateTime або `null` | `null` | час зміни за метаданими джерела |
| `created_at` | DateTime | час появи entry | час створення file entry |
| `updated_at` | DateTime | час зміни entry | час останнього accepted sync |

### 6.7. `DeviceFile`

Ця модель повертається для accepted sync item.

| Поле | Тип | Значення |
| --- | --- | --- |
| `file_id` | UUID | Стабільна identity файла. |
| `device_id` | UUID | Пристрій-власник. |
| `parent_entry_id` | UUID | Поточний батьківський каталог. |
| `root_entry_id` | UUID | Поточний root. |
| `path_syntax` | PathSyntax | Синтаксис останнього sync. |
| `absolute_path` | string | Exact шлях із запиту. |
| `name` | string | Останній компонент шляху. |
| `path_components` | `string[]` | Компоненти після root включно з `name`. |
| `mime_type` | string або `null` | Явний або виведений MIME. |
| `extension` | string або `null` | Явне або виведене розширення. |
| `file_metadata_created_at` | DateTime або `null` | Джерельний час створення. |
| `file_metadata_modified_at` | DateTime або `null` | Джерельний час зміни. |
| `created_at` | DateTime | Час першого створення файла в ЕХО. |
| `updated_at` | DateTime | Час останнього accepted sync. |

## 7. Верхньорівневі помилки

| HTTP | Тип | Тіло | Дія клієнта |
| ---: | --- | --- | --- |
| `400` | `Form` | JSON-масив `FieldError`, наприклад `[["limit","..."]]` | Виправити структуру, значення або стан; не повторювати без зміни. |
| `400` | business logic | Plain text | Виправити команду або стан. |
| `401` | unauthenticated | `Unauthenticated` | Повторити login і застосувати idempotency rules. |
| `403` | forbidden | `Forbidden` | Не повторювати; виправити роль або набір полів. |
| `404` | not found/not visible | `Not found` | Перевірити IDs, device scope та локальне зіставлення. |
| `500` | internal/dependency | `Internal server error` | Вважати результат невизначеним для write; виконати reconciliation. |
| `503` | shutdown | `Service unavailable: server is shutting down` | Повторити пізніше з backoff; для write спочатку врахувати невизначений результат. |

Тіло `400` має дві можливі форми. Клієнт повинен спочатку спробувати декодувати JSON-масив пар, а якщо це неможливо — трактувати body як plain text. Не покладайтеся лише на `Content-Type` error response.

Приклад unknown field:

```json
[
  ["name", "Unknown field"]
]
```

Приклад wrong type:

```json
[
  ["limit", "Invalid value type"]
]
```

Невалідний UUID:

```json
[
  ["device_id", "Must be a canonical lowercase hyphenated UUID"]
]
```

Неправильний `Content-Type` або його відсутність:

```json
[
  ["body", "Content-Type must be application/json"]
]
```

Відповідь `404` навмисно не розрізняє відсутній, невидимий та належний іншому пристрою ключ. Internal details ніколи не повертаються.

Для `files/sync` ця таблиця стосується envelope запиту. Після успішної перевірки envelope помилки окремих items повертаються всередині HTTP `200`; див. розділ [12](#12-post-apidevicefilessync).

## 8. API пристроїв

### 8.1. `POST /api/device/list`

**Право:** читання.

#### Request

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `filter_text` | string або `null` | optional | Після `trim`: порожнє не фільтрує; інакше literal case-insensitive substring у `source_label`/`name` або literal substring canonical UUID. `%` і `_` не є wildcard. |
| `archived_filter` | enum або `null` | optional | `active_only`, `archived_only`, `all`; default `active_only`. |
| `needs_analytical_name` | boolean або `null` | optional | `true`: лише `name == null`; `false`: лише `name != null`. |
| `aor_ids` | integer array або `null` | optional | Порожній масив не фільтрує; у масиві `OR`. |
| `unit_ids` | integer array або `null` | optional | Порожній масив не фільтрує; у масиві `OR`. |
| `limit` | integer або `null` | optional | Default 100, range 1–100. |
| `offset` | integer або `null` | optional | Default 0; невід’ємне ціле. |
| `sort_by` | enum array | optional, не nullable | Критерії в переданому порядку. Default `updated_at_desc`. |

`sort_by` приймає:

- `display_title_asc`, `display_title_desc`;
- `created_at_asc`, `created_at_desc`;
- `updated_at_asc`, `updated_at_desc`.

Однаковий критерій в тому самому напрямку дедуплікується. Один логічний критерій у різних напрямках є `400 Form`. Остаточний tie-breaker — `id` ascending.

Різні фільтри поєднуються через `AND`; значення в одному `aor_ids` або `unit_ids` — через `OR`.

Запит `list-devices.json`:

```json
{
  "filter_text": "collector-042",
  "archived_filter": "all",
  "needs_analytical_name": true,
  "aor_ids": [],
  "unit_ids": [],
  "limit": 50,
  "offset": 0,
  "sort_by": ["updated_at_desc", "display_title_asc"]
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @list-devices.json \
  "$ECHO_BASE_URL/api/device/list"
```

#### Response

```json
{
  "list": [
    {
      "id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
      "source_label": "collector-042",
      "name": null,
      "aors": [],
      "unit": null,
      "created_by": "device-source-service",
      "archived": false,
      "created_at": "2026-07-24T09:00:00Z",
      "updated_at": "2026-07-24T10:15:30Z",
      "archived_at": null
    }
  ],
  "total": 1,
  "has_more": false,
  "status_counts": {
    "active": 1,
    "archived": 0
  }
}
```

`total` враховує всі фільтри, включно з `archived_filter`. `has_more` означає `offset + list.length < total`. `status_counts` враховує інші фільтри, але навмисно ігнорує `archived_filter`.

### 8.2. `POST /api/device/unit-stats`

**Право:** читання.

Запит не має тіла. Не надсилайте `{}` і не додавайте `--data`:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie "$ECHO_COOKIE_JAR" \
  "$ECHO_BASE_URL/api/device/unit-stats"
```

Response:

```json
{
  "units": [
    {
      "unit": {
        "id": 5,
        "name": "Підрозділ 5"
      },
      "count": 12
    }
  ]
}
```

Повертаються лише видимі активні пристрої із заданим підрозділом. Підрозділи з нульовою кількістю та пристрої без підрозділу не входять до відповіді.

Надсилання `{}` повертає:

```json
[
  ["body", "Request body must be absent"]
]
```

### 8.3. `POST /api/device/detail`

**Право:** читання.

#### Request

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `device_id` | UUID | required | ID пристрою. |
| `include_archived` | boolean або `null` | optional | Default `false`. `true` дозволяє прочитати архівний пристрій. |

`device-detail.json`:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001"
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @device-detail.json \
  "$ECHO_BASE_URL/api/device/detail"
```

#### Response

```json
{
  "id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "source_label": "collector-042",
  "name": null,
  "aors": [],
  "unit": null,
  "external_url": "https://source.example/devices/collector-042",
  "custom_fields": {
    "hostname": "ws-042",
    "source_device_id": "collector-042",
    "source_system": "inventory-service"
  },
  "created_by": "device-source-service",
  "archived": false,
  "created_at": "2026-07-24T09:00:00Z",
  "updated_at": "2026-07-24T10:15:30Z",
  "archived_at": null
}
```

Архівний пристрій без `include_archived: true` повертає `404`.

### 8.4. `POST /api/device/create`

**Право:** запис джерельних даних (`DeviceSource`).

#### Request

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `source_label` | string | required | Після `trim` непорожня, до 255. Не є унікальною. |
| `external_url` | string або `null` | optional | Абсолютний URL із `http` або `https`; host обов’язковий. Порожній рядок невалідний. |
| `custom_fields` | `Record<string, string>` | optional, не nullable | Default `{}`. Ключі trim-яться; values зберігаються без спеціальної семантики. |

`create-device.json`:

```json
{
  "source_label": "collector-042",
  "external_url": "https://source.example/devices/collector-042",
  "custom_fields": {
    "source_system": "inventory-service",
    "source_device_id": "collector-042",
    "hostname": "ws-042"
  }
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @create-device.json \
  "$ECHO_BASE_URL/api/device/create"
```

#### Response

```json
{
  "id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "source_label": "collector-042",
  "name": null,
  "aors": [],
  "unit": null,
  "external_url": "https://source.example/devices/collector-042",
  "custom_fields": {
    "hostname": "ws-042",
    "source_device_id": "collector-042",
    "source_system": "inventory-service"
  },
  "created_by": "device-source-service",
  "archived": false,
  "created_at": "2026-07-24T09:00:00Z",
  "updated_at": "2026-07-24T09:00:00Z",
  "archived_at": null
}
```

Create ніколи не приймає `device_id`, `name`, `aor_ids`, `unit_id`, `files`, `created_by`, timestamps або інші системні поля. Наприклад, `name: null` поверне structural `400`, а не буде проігноровано.

Кожен успішний create генерує новий `id`. `source_label`, `external_url` і custom fields не є server-side idempotency key. Після transport uncertainty не повторюйте create наосліп.

### 8.5. `POST /api/device/update`

**Право:** залежить від фактично присутніх полів.

#### Request

| Поле | Пропущено | `null` | Значення | Право |
| --- | --- | --- | --- | --- |
| `device_id` | невалідно | невалідно | canonical UUID | адреса |
| `source_label` | без зміни | невалідно | замінити непорожньою trim-нормалізованою міткою | `DeviceSource` |
| `external_url` | без зміни | очистити | замінити валідним HTTP(S) URL | `DeviceSource` |
| `custom_fields` | без зміни | невалідно | object patch: string upsert, inner `null` delete | `DeviceSource` |
| `name` | без зміни | очистити | замінити непорожньою аналітичною назвою | `DeviceAnalyst`/`Admin` |
| `aor_ids` | без зміни | невалідно | повністю замінити; `[]` очистити | `DeviceAnalyst`/`Admin` |
| `unit_id` | без зміни | очистити | замінити чинним ID | `DeviceAnalyst`/`Admin` |

Окрім `device_id`, має бути хоча б одна фактична команда. Порожній patch і запит лише з `custom_fields: {}` повертають `400 Form`.

`DeviceSource` повинен надсилати лише `source_label`, `external_url` та/або `custom_fields`.

`update-device.json`:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "external_url": "https://source.example/devices/collector-042/current",
  "custom_fields": {
    "hostname": "ws-042.example.net",
    "last_inventory_id": "inventory-2026-07-24-001",
    "obsolete_key": null
  }
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @update-device.json \
  "$ECHO_BASE_URL/api/device/update"
```

#### Response

Успіх повертає повний поточний `DeviceDetails`, а не лише змінені поля:

```json
{
  "id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "source_label": "collector-042",
  "name": null,
  "aors": [],
  "unit": null,
  "external_url": "https://source.example/devices/collector-042/current",
  "custom_fields": {
    "hostname": "ws-042.example.net",
    "last_inventory_id": "inventory-2026-07-24-001",
    "source_device_id": "collector-042",
    "source_system": "inventory-service"
  },
  "created_by": "device-source-service",
  "archived": false,
  "created_at": "2026-07-24T09:00:00Z",
  "updated_at": "2026-07-24T10:15:30Z",
  "archived_at": null
}
```

Якщо нормалізований стан уже збігається з поточним, endpoint повертає `200` і поточний об’єкт без зміни `updated_at`.

Update атомарний: невалідне або заборонене поле не залишає частково застосованих змін. Архівний пристрій повертає:

```json
[
  ["device_id", "Архівований пристрій не можна редагувати"]
]
```

Спроба `DeviceSource` передати навіть `name: null` повертає:

```text
HTTP 403
Forbidden
```

## 9. Файлова модель з погляду інтегратора

### 9.1. Identity

- Єдиною identity файла є `file_id`.
- `absolute_path` не є identity та не є унікальним.
- Два keyless sync items з однаковим шляхом створюють два різні файли.
- Update з відомим `file_id` може змінити шлях, filename, root і навіть `path_syntax`, зберігаючи identity.
- Невідомий `file_id` або ID файла іншого пристрою не створює новий файл.
- Відсутність раніше відомого `file_id` у batch нічого не видаляє.

Зовнішній сервіс повинен мати durable mapping власної file identity до `file_id`, поверненого ЕХО.

### 9.2. Корені й каталоги

Клієнт не створює root або directory окремими командами. ЕХО автоматично виводить їх із `path_syntax` та `absolute_path` кожного accepted file item.

- POSIX має один canonical root `/` на пристрій.
- Windows drive root має canonical uppercase drive letter, наприклад `C:\`.
- UNC root зберігає exact server/share, наприклад `\\fileserver\evidence\`.
- Один Windows batch може містити кілька drive та UNC roots.
- Порожні вкладені каталоги не є окремими джерельними об’єктами.
- Root може лишитися у відповіді roots після переміщення останнього файла з нього.

## 10. API читання файлової ієрархії

Читання roots/browse/search дозволене і для активного, і для архівного видимого пристрою.

### 10.1. `POST /api/device/files/roots`

**Право:** читання.

Request `file-roots.json`:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001"
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @file-roots.json \
  "$ECHO_BASE_URL/api/device/files/roots"
```

Response:

```json
{
  "roots": [
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000001",
      "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
      "parent_entry_id": null,
      "kind": "directory",
      "name": "C:\\",
      "path_syntax": "windows",
      "created_at": "2026-07-24T10:00:00Z",
      "updated_at": "2026-07-24T10:00:00Z"
    },
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000005",
      "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
      "parent_entry_id": null,
      "kind": "directory",
      "name": "\\\\fileserver\\evidence\\",
      "path_syntax": "windows",
      "created_at": "2026-07-24T10:00:01Z",
      "updated_at": "2026-07-24T10:00:01Z"
    }
  ]
}
```

Roots упорядковані за `path_syntax`, exact `name`, потім `entry_id`. Недоступність файлового реєстру є помилкою `500`, а не успішною порожньою відповіддю.

### 10.2. `POST /api/device/files/browse`

**Право:** читання.

#### Request

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `device_id` | UUID | required | ID пристрою. |
| `parent_entry_id` | UUID | required | Root або directory цього пристрою. File ID тут невалідний як scope. |
| `include_breadcrumbs` | boolean або `null` | optional | Default `true`; `false` повертає `breadcrumbs: []`. |
| `limit` | integer або `null` | optional | Default 100, range 1–100. |
| `cursor` | string або `null` | optional | Opaque continuation token із попередньої сторінки того самого запиту. |

`browse-files.json`:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "parent_entry_id": "019c8e70-1000-7000-8000-000000000003",
  "include_breadcrumbs": true,
  "limit": 100
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @browse-files.json \
  "$ECHO_BASE_URL/api/device/files/browse"
```

#### Response

```json
{
  "breadcrumbs": [
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000001",
      "name": "C:\\"
    },
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000002",
      "name": "Evidence"
    },
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000003",
      "name": "2026"
    }
  ],
  "entries": [
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000004",
      "parent_entry_id": "019c8e70-1000-7000-8000-000000000003",
      "kind": "file",
      "file_id": "019c8e70-1000-7000-8000-000000000004",
      "name": "report.pdf",
      "path_components": ["Evidence", "2026", "report.pdf"],
      "path_syntax": "windows",
      "absolute_path": "C:\\Evidence\\2026\\report.pdf",
      "mime_type": "application/pdf",
      "extension": "pdf",
      "file_metadata_created_at": "2026-07-24T05:00:00Z",
      "file_metadata_modified_at": "2026-07-24T09:00:00Z",
      "created_at": "2026-07-24T10:00:00Z",
      "updated_at": "2026-07-24T10:00:00Z"
    }
  ],
  "next_cursor": null
}
```

Browse повертає тільки безпосередніх дітей `parent_entry_id`, а не все піддерево. Порядок фіксований: directories перед files, далі exact UTF-8 name ascending, потім `entry_id` ascending. Однакові filenames з різними IDs повертаються окремо.

Breadcrumbs ідуть від root до current parent включно. `include_breadcrumbs` не впливає на `entries[].path_components`.

### 10.3. `POST /api/device/files/search`

**Право:** читання.

#### Request

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `device_id` | UUID | required | ID пристрою. |
| `scope_entry_id` | UUID | required | Root або directory цього пристрою. Scope не входить до результатів, шукаються descendants. |
| `name_query` | string або `null` | optional | Після `trim` 3–255; literal case-insensitive substring у `name`. `%`, `_`, `\` не wildcard. Порожній string невалідний. |
| `kinds` | FileEntryKind array або `null` | optional | Empty/null не фільтрує. |
| `mime_types` | string array або `null` | optional | Exact case-sensitive values; empty/null не фільтрує. |
| `extensions` | string array або `null` | optional | Exact case-sensitive values без автоматичного trim; empty/null не фільтрує. |
| `file_metadata_modified_from` | DateTime або `null` | optional | Inclusive lower bound. |
| `file_metadata_modified_to` | DateTime або `null` | optional | Inclusive upper bound. |
| `limit` | integer або `null` | optional | Default 100, range 1–100. |
| `cursor` | string або `null` | optional | Opaque token для незмінних scope і filters. |

Кожен filter array має не більше 50 input-елементів. Повтори не розширюють результат. MIME, extension і modified-time filters не match-ять directories. Якщо задано обидві часові межі, `from` має бути не пізніше `to`.

`search-files.json`:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "scope_entry_id": "019c8e70-1000-7000-8000-000000000001",
  "name_query": "report",
  "kinds": ["file"],
  "mime_types": ["application/pdf"],
  "extensions": ["pdf"],
  "file_metadata_modified_from": "2026-07-24T00:00:00+03:00",
  "file_metadata_modified_to": "2026-07-25T00:00:00+03:00",
  "limit": 100
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @search-files.json \
  "$ECHO_BASE_URL/api/device/files/search"
```

Response:

```json
{
  "entries": [
    {
      "entry_id": "019c8e70-1000-7000-8000-000000000004",
      "parent_entry_id": "019c8e70-1000-7000-8000-000000000003",
      "kind": "file",
      "file_id": "019c8e70-1000-7000-8000-000000000004",
      "name": "report.pdf",
      "path_components": ["Evidence", "2026", "report.pdf"],
      "path_syntax": "windows",
      "absolute_path": "C:\\Evidence\\2026\\report.pdf",
      "mime_type": "application/pdf",
      "extension": "pdf",
      "file_metadata_created_at": "2026-07-24T05:00:00Z",
      "file_metadata_modified_at": "2026-07-24T09:00:00Z",
      "created_at": "2026-07-24T10:00:00Z",
      "updated_at": "2026-07-24T10:00:00Z"
    }
  ],
  "next_cursor": null
}
```

Порядок і cursor semantics такі самі, як у browse.

### 10.4. Cursor pagination

`next_cursor` потрібно вважати opaque, навіть якщо поточне значення схоже на UUID.

Алгоритм:

1. перший запит надсилається без `cursor`;
2. клієнт обробляє `entries`;
3. якщо `next_cursor != null`, клієнт повторює той самий request зі значенням `cursor`;
4. якщо `next_cursor == null`, сторінки завершено;
5. при зміні device, scope або будь-якого filter потрібно видалити cursor і почати з першої сторінки.

Browse/search не повертають `total` і не приймають `offset`. Cursor, який не належить фактичному scope/filter, пошкоджений або застарілий, повертає `400 Form`:

```json
[
  ["cursor", "invalid cursor"]
]
```

Cursor не фіксує snapshot між HTTP-запитами. За незмінного набору entries пагінація не має повторів; concurrent rename/move/create може змінити позицію entry між сторінками. Для повної reconciliation-сесії за активних writers інтегратор повинен бути готовим повторити обхід.

## 11. Синтаксис абсолютних шляхів

`absolute_path` зберігається й повертається **exact**, без `trim`, case folding або Unicode normalization. ЕХО не відкриває цей шлях на своїй файловій системі.

### 11.1. POSIX

Приймається:

```text
/var/log/auth.log
/home/user/report.pdf
```

Правила:

- рівно один початковий `/`;
- canonical root `/`;
- щонайменше один file component;
- separator `/`;
- заборонені repeated або trailing separators;
- заборонені порожні компоненти, `.` та `..`;
- шлях `/`, relative path і NUL невалідні.

### 11.2. Windows drive path

Приймається:

```text
C:\Evidence\2026\report.pdf
c:\Users\Analyst\notes.txt
```

`absolute_path` лишається exact, але root другого прикладу повернеться як `C:\`.

### 11.3. Windows UNC path

Приймається:

```text
\\fileserver\evidence\incoming\photo.jpg
```

Canonical root: `\\fileserver\evidence\`. Server, share і кожен наступний компонент повинні бути непорожніми.

### 11.4. Невалідні Windows-форми

```text
C:/Evidence/report.pdf
C:Evidence\report.pdf
\Evidence\report.pdf
C:\Evidence\\report.pdf
C:\Evidence\..\report.pdf
C:\Evidence\
\\?\C:\Evidence\report.pdf
\\.\C:\Evidence\report.pdf
```

Windows paths повинні використовувати `\`. Drive-relative, root-relative, device namespace, repeated/trailing separator та dot components відхиляються. ЕХО не застосовує додаткові NTFS-specific правила до назв компонентів.

## 12. `POST /api/device/files/sync`

**Право:** запис джерельних даних (`DeviceSource`).

### 12.1. Request envelope

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `device_id` | UUID | required | Один активний видимий пристрій. |
| `path_syntax` | PathSyntax | required | Один синтаксис для всіх items: `posix` або `windows`. |
| `files` | array | required | 1–100 items. |

Один batch може містити кілька roots, якщо всі шляхи належать заявленому `path_syntax`. Змішані POSIX і Windows items потрібно розділити на різні запити.

### 12.2. `SyncDeviceFileItem`

| Поле | Тип | Presence | Семантика |
| --- | --- | --- | --- |
| `file_id` | UUID | optional, не nullable | Пропущено — create; задано — повна технічна заміна відомого файла. |
| `absolute_path` | string | required | Exact абсолютний file path згідно з batch `path_syntax`. |
| `mime_type` | string або `null` | optional | Explicit trim-нормалізований MIME; absent/null — вивести з effective extension, інакше `null`. |
| `extension` | string або `null` | optional | Без початкової крапки; absent/null — вивести з filename, інакше `null`. |
| `file_metadata_created_at` | DateTime або `null` | optional | Absent/null очищує значення; timestamp нормалізується до UTC. |
| `file_metadata_modified_at` | DateTime або `null` | optional | Absent/null очищує значення; timestamp нормалізується до UTC. |

Sync item описує повний поточний технічний стан файла, а не patch. Для update повторно надсилайте всі бажані технічні значення.

Request не приймає `name`, `root_entry_id`, `parent_entry_id`, `path_components`, content або analytics. `name`, root і каталоги виводяться з шляху.

Якщо `extension` не задано, ЕХО бере суфікс після останньої крапки. `.env` і `report.` не мають derived extension; `archive.tar.gz` має `gz`. Явний `mime_type` або `extension` має пріоритет. Початкова крапка в explicit extension, наприклад `.pdf`, невалідна.

### 12.3. Structural/envelope error проти item rejection

Весь HTTP-запит отримує top-level `400/401/403/404/500/503`, якщо не пройдено:

- authentication або permission;
- JSON decode, required fields, known fields і JSON types;
- canonical UUID decode, включно з `files[i].file_id`;
- `device_id`, `path_syntax`, nonempty batch bounds;
- visibility та active state пристрою.

Приклади top-level structural failures:

- `file_id: null`;
- missing `absolute_path`;
- unknown `name` усередині item;
- `files` порожній або містить понад 100 items;
- invalid enum `path_syntax`;
- archived device.

Після успішного decode/envelope validation кожна позиція має рівно один ordered result у HTTP `200`. Невалідний синтаксис самого path, порожній explicit MIME, invalid item timestamp, duplicate known `file_id`, unknown file і помилка виконання конкретного item стають `status: rejected`, а не top-level HTTP error.

### 12.4. Request із partial success

`sync-files.json`:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "path_syntax": "windows",
  "files": [
    {
      "absolute_path": "C:\\Evidence\\2026\\report.pdf",
      "file_metadata_created_at": "2026-07-24T08:00:00+03:00",
      "file_metadata_modified_at": "2026-07-24T12:00:00+03:00"
    },
    {
      "absolute_path": "\\\\fileserver\\evidence\\incoming\\photo.jpg",
      "mime_type": "image/jpeg",
      "extension": "jpg",
      "file_metadata_modified_at": "2026-07-24T12:30:00+03:00"
    },
    {
      "absolute_path": "relative\\broken.txt"
    }
  ]
}
```

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$ECHO_COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data @sync-files.json \
  "$ECHO_BASE_URL/api/device/files/sync"
```

### 12.5. Response

```json
{
  "results": [
    {
      "status": "accepted",
      "index": 0,
      "operation": "created",
      "root": {
        "entry_id": "019c8e70-1000-7000-8000-000000000001",
        "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
        "parent_entry_id": null,
        "kind": "directory",
        "name": "C:\\",
        "path_syntax": "windows",
        "created_at": "2026-07-24T10:00:00Z",
        "updated_at": "2026-07-24T10:00:00Z"
      },
      "file": {
        "file_id": "019c8e70-1000-7000-8000-000000000004",
        "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
        "parent_entry_id": "019c8e70-1000-7000-8000-000000000003",
        "root_entry_id": "019c8e70-1000-7000-8000-000000000001",
        "path_syntax": "windows",
        "absolute_path": "C:\\Evidence\\2026\\report.pdf",
        "name": "report.pdf",
        "path_components": ["Evidence", "2026", "report.pdf"],
        "mime_type": "application/pdf",
        "extension": "pdf",
        "file_metadata_created_at": "2026-07-24T05:00:00Z",
        "file_metadata_modified_at": "2026-07-24T09:00:00Z",
        "created_at": "2026-07-24T10:00:00Z",
        "updated_at": "2026-07-24T10:00:00Z"
      }
    },
    {
      "status": "accepted",
      "index": 1,
      "operation": "created",
      "root": {
        "entry_id": "019c8e70-1000-7000-8000-000000000005",
        "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
        "parent_entry_id": null,
        "kind": "directory",
        "name": "\\\\fileserver\\evidence\\",
        "path_syntax": "windows",
        "created_at": "2026-07-24T10:00:01Z",
        "updated_at": "2026-07-24T10:00:01Z"
      },
      "file": {
        "file_id": "019c8e70-1000-7000-8000-000000000007",
        "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
        "parent_entry_id": "019c8e70-1000-7000-8000-000000000006",
        "root_entry_id": "019c8e70-1000-7000-8000-000000000005",
        "path_syntax": "windows",
        "absolute_path": "\\\\fileserver\\evidence\\incoming\\photo.jpg",
        "name": "photo.jpg",
        "path_components": ["incoming", "photo.jpg"],
        "mime_type": "image/jpeg",
        "extension": "jpg",
        "file_metadata_created_at": null,
        "file_metadata_modified_at": "2026-07-24T09:30:00Z",
        "created_at": "2026-07-24T10:00:01Z",
        "updated_at": "2026-07-24T10:00:01Z"
      }
    },
    {
      "status": "rejected",
      "index": 2,
      "error": {
        "kind": "validation",
        "message": "filesystem validation failed",
        "field_errors": [
          [
            "files[2].absolute_path",
            "must be an absolute file path valid for the selected path syntax"
          ]
        ]
      }
    }
  ]
}
```

`results` має ту саму кількість і порядок, що `files`; `index` є 0-based позицією оригінального item. Не зіставляйте результат за шляхом, оскільки шляхи можуть дублюватися.

`accepted.root` і `accepted.file` є підтвердженням прийнятого стану. Після `operation: created` потрібно durable-зберегти `file.file_id` до наступної синхронізації.

### 12.6. Accepted semantics

- `operation` має `created` або `updated`.
- Keyless item завжди створює новий `file_id`.
- Item із відомим `file_id` повністю замінює його технічний стан.
- Update зберігає `file_id`, `device_id` і `created_at`, але може змінити syntax, root, parent, name, exact path та metadata.
- Кожен accepted item застосовується незалежно. Rejected sibling не відкочує його.
- Відсутні у batch раніше відомі IDs лишаються без змін.

### 12.7. Per-item error model

```json
{
  "status": "rejected",
  "index": 0,
  "error": {
    "kind": "validation",
    "message": "filesystem validation failed",
    "field_errors": [
      ["files[0].absolute_path", "error description"]
    ]
  }
}
```

| `kind` | Canonical `message` | Значення | `field_errors` | Дія |
| --- | --- | --- | --- | --- |
| `validation` | `filesystem validation failed` | Невалідний path/value або duplicate `file_id`. | Непорожній список точних шляхів. | Виправити item і повторити лише його. |
| `not_found` | `filesystem entry not found` | File ID відсутній, невидимий або належить іншому device. | `[]` | Звірити локальне mapping; не перетворювати автоматично на create. |
| `conflict` | `filesystem conflict` | Безпечні внутрішні retries вичерпано. | `[]` | Повторити цей самий item із backoff. |
| `dependency` | `filesystem dependency failed` | Залежність недоступна для цього item. | `[]` | Повторити цей rejected item пізніше з backoff. |
| `internal` | `filesystem internal failure` | Інша неочікувана item-помилка. | `[]` | Обмежено повторити; за повторення ескалювати адміністратору. |

Якщо один non-null `file_id` повторюється в batch, **кожне** його входження отримує `validation` із відповідним шляхом і повідомленням `must be unique within the batch`. Незалежні items можуть бути accepted.

## 13. Коректна обробка partial success

Після HTTP `200` на `/files/sync` не можна вважати весь batch успішним. Мінімальний алгоритм:

1. перевірити, що `results.length == files.length`;
2. для кожного result перевірити `index` і `status`;
3. для `accepted` durable-зберегти canonical root/file response та mapping source file key → `file_id`;
4. для `rejected` класифікувати `error.kind`;
5. сформувати retry batch лише з виправлених або тимчасово rejected items;
6. не повторювати accepted keyless items;
7. не трактувати відсутність item у наступному batch як delete.

Приклад локального durable mapping:

| Локальний ключ | Значення ЕХО |
| --- | --- |
| `source_device_key` | `device_id` |
| `source_file_key` | `file_id` |
| останній desired path syntax/path | для reconciliation |
| останній accepted metadata snapshot | для виявлення змін і reconciliation |

`source_file_key` не передається в API файла; це локальна відповідальність інтегратора.

## 14. Retry, ідемпотентність і reconciliation

### 14.1. Матриця повторів

| Операція/результат | Blind retry | Правильна дія |
| --- | --- | --- |
| `list`, `unit-stats`, `detail`, `roots`, `browse`, `search` | так | Повторити з backoff; врахувати cursor concurrency. |
| Device create із отриманим non-200 validation/403/404 | ні | Виправити причину. |
| Device create після timeout/reset/`500`/`503` | **ні** | Спочатку reconciliation; повтор може створити дублікат. |
| Device update того самого desired patch | зазвичай так | Після повторної автентифікації можна надіслати той самий patch; врахувати concurrent writer. |
| File update з відомим `file_id` і тим самим повним desired state | так | Повтор state-replacement сходиться до того самого стану. |
| File create без `file_id` після отриманого explicit `rejected` | так, після виправлення/backoff | Explicit rejected item не є accepted; повторювати тільки його. |
| File create без `file_id` після втрати HTTP response | **ні** | Reconciliation перед повтором; blind retry створить новий UUID. |
| Sync `accepted` item | ні | Зберегти `file_id`; надалі використовувати його як update. |
| Sync `validation`/`not_found` | ні без змін | Виправити item/mapping. |
| Sync `conflict`/`dependency`/`internal` із отриманим response | обмежено так | Повторити лише rejected items з exponential backoff і jitter. |
| HTTP `401` | залежить від операції | Login, потім застосувати правила конкретної операції. |
| HTTP `403` | ні | Виправити роль або заборонені fields. |
| HTTP `404` | ні | Перевірити device/file/scope mapping. |
| HTTP `500`, `503` або transport break під час write | не наосліп | Вважати outcome невизначеним і виконати reconciliation. |

### 14.2. Reconciliation невизначеного device create

Оскільки create не приймає client operation ID, а `source_label` не унікальна:

1. на create передавайте стабільний source identifier у `custom_fields`, наприклад `source_system` + `source_device_id`;
2. після невизначеної відповіді виконайте `/api/device/list`, звузивши кандидатів унікальною за вашою політикою `source_label`;
3. для candidate IDs виконайте `/api/device/detail` і порівняйте `custom_fields`;
4. якщо знайдено рівно один відповідний пристрій, збережіть його `id`;
5. якщо результат неоднозначний, не створюйте ще один пристрій автоматично — потрібне операційне вирішення.

Custom field допомагає reconciliation, але не стає server-side uniqueness або idempotency constraint.

### 14.3. Reconciliation невизначеного keyless file create

1. Визначте очікуваний root із `path_syntax` та path.
2. Отримайте `/files/roots`.
3. Пройдіть потрібні каталоги через `/files/browse`; для довгих дерев можна спочатку звузити кандидатів `/files/search` за filename.
4. Порівняйте exact `absolute_path`, `path_syntax` і metadata з desired item.
5. Якщо знайдено однозначний file, durable-збережіть його `file_id`.
6. Якщо однаковий шлях допустимо представлений кількома files, path не доводить identity. Без уже збереженого `file_id` автоматично визначити правильний duplicate неможливо; не створюйте новий item без політики вирішення неоднозначності.

### 14.4. Невизначений update з відомим ID

Device update є patch, а file update — повна заміна технічного стану. Для відомих IDs повтор того самого desired update є state-convergent. Після повтору приймайте повернений response як canonical поточний стан. Якщо інший writer може паралельно змінювати ті самі поля, інтеграція повинна мати зовнішню політику пріоритету; API цього етапу не приймає version/ETag precondition.

## 15. Практичний наскрізний сценарій

### Крок 1. Створити сесію

Викликати `/api/user/login`, зберегти cookie jar і не логувати його вміст.

### Крок 2. Відновити або створити device mapping

- Якщо локально вже є `device_id`, перевірити його через `/api/device/detail`.
- Якщо mapping відсутній, виконати `/api/device/create` зі стабільними `source_system` і `source_device_id` у `custom_fields`.
- Durable-зберегти повернений `id` до наступної операції.

### Крок 3. Оновити технічні відомості

Викликати `/api/device/update` лише з source-полями. Не серіалізувати `name`, `aor_ids` або `unit_id` у DTO інтеграції навіть як default/null.

### Крок 4. Підготувати файлові batch

- згрупувати items за `device_id` і `path_syntax`;
- розбити на batch по 1–100;
- для нового локального file key пропустити `file_id`;
- для вже mapped file key передати збережений `file_id`;
- передати повний desired технічний стан кожного файла.

### Крок 5. Обробити кожен result

- `accepted/created`: зберегти новий `file_id`;
- `accepted/updated`: підтвердити mapping і canonical response;
- `validation`: виправити точні `field_errors`;
- `not_found`: зупинити автоматичний update і перевірити mapping;
- transient rejection: поставити лише rejected item у retry queue;
- не повторювати accepted keyless items.

### Крок 6. Перевірити прийнятий стан

- `/files/roots` — перевірити derived roots;
- `/files/browse` — пройти exact directory chain;
- `/files/search` — знайти candidates у потрібному subtree;
- порівнювати exact `absolute_path` та повернений `file_id`, а не лише filename.

### Крок 7. Обробити lifecycle

Якщо device став archived, read APIs лишаються доступними, але update/sync повертають `400 Form`. Інтеграція повинна припинити writes для цього `device_id` та ескалювати стан власнику процесу.

## 16. Приклади помилкових запитів

### 16.1. Аналітичне поле під час create

Невалідно для будь-якої ролі:

```json
{
  "source_label": "collector-042",
  "name": null
}
```

Response:

```json
[
  ["name", "Unknown field"]
]
```

### 16.2. Аналітичне поле під час update від `DeviceSource`

Структурно валідно, але заборонено роллю:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "name": null
}
```

Response:

```text
HTTP 403
Forbidden
```

### 16.3. `file_id: null`

Це structural error всього sync request, а не per-item rejection:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "path_syntax": "windows",
  "files": [
    {
      "file_id": null,
      "absolute_path": "C:\\Evidence\\report.pdf"
    }
  ]
}
```

Response:

```json
[
  ["files[0].file_id", "Field cannot be null"]
]
```

Щоб створити файл, поле `file_id` потрібно **пропустити**, а не передати як `null`.

### 16.4. Невалідний path

Структура запиту валідна, тому HTTP status — `200`, але item rejected:

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "path_syntax": "windows",
  "files": [
    {
      "absolute_path": "C:/Evidence/report.pdf"
    }
  ]
}
```

```json
{
  "results": [
    {
      "status": "rejected",
      "index": 0,
      "error": {
        "kind": "validation",
        "message": "filesystem validation failed",
        "field_errors": [
          [
            "files[0].absolute_path",
            "must be an absolute file path valid for the selected path syntax"
          ]
        ]
      }
    }
  ]
}
```

### 16.5. Невідоме derived поле в sync item

```json
{
  "device_id": "019c8e6d-4a4d-7b20-9d31-71d09f970001",
  "path_syntax": "posix",
  "files": [
    {
      "absolute_path": "/var/log/auth.log",
      "name": "auth.log"
    }
  ]
}
```

Response:

```json
[
  ["files[0].name", "Unknown field"]
]
```

## 17. Не використовувати

Наступні legacy або позаетапні маршрути не є частиною чинного контракту та повертають звичайний `404`:

- `/api/device/archive`;
- `/api/device/restore`;
- `/api/device/files/list`;
- `/api/device/files/create`;
- `/api/device/files/roots/create`;
- `/api/device/files/hide`;
- `/api/device/files/restore`;
- `/api/device/files/content`.

Також не існує окремого Stage 1 API для:

- створення root або directory;
- надсилання чи отримання файлового content;
- видалення файла через omission із batch;
- rename/move/delete каталогу;
- first-class empty directories;
- file analytics, hide state або content state.

## 18. Checklist інтегратора

- [ ] Виділено окремий HTTPS endpoint і обліковий запис із роллю `DeviceSource`.
- [ ] Session cookie зберігається безпечно й повторно використовується.
- [ ] У source DTO відсутні `name`, `aor_ids`, `unit_id` та системні поля.
- [ ] JSON serializer не надсилає unknown/default fields автоматично.
- [ ] UUID серіалізуються canonical lowercase hyphenated.
- [ ] Request timestamps мають explicit timezone.
- [ ] Локально durable-зберігається mapping source device key → `device_id`.
- [ ] Локально durable-зберігається mapping source file key → `file_id`.
- [ ] Нові file items пропускають `file_id`; updates завжди передають його.
- [ ] POSIX і Windows files розділяються на різні batch; кожен batch має 1–100 items.
- [ ] Обробляється кожен sync result за `index` і `status`, а не лише HTTP `200`.
- [ ] Accepted keyless items не повторюються.
- [ ] Після timeout/connection reset/write `500` виконується reconciliation до retry.
- [ ] Cursor скидається при зміні scope або filters.
- [ ] `404` не використовується для висновку, чи існує foreign/невидимий ID.
- [ ] Архівний device переводить інтеграцію в read-only/error workflow.
- [ ] Legacy routes із розділу «Не використовувати» відсутні в клієнті.

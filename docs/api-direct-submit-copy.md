# Копіювання `signal_message`: API для frontend

## Загальна схема

Копіювання повідомлення реалізоване як отримання transient payload. Після натискання **«Копіювати»** frontend має:

1. Викликати `POST /api/1.1/messages/copy` з масивом ID джерел.
2. Взяти з відповіді масив `payloads` і відкрити потрібні payload-и у формі редагування.
3. Дозволити користувачу змінити групу та будь-які інші поля повідомлення.
4. За потреби завантажити нові media через наявний upload flow.
5. Зберегти результат через `POST /api/1.1/submit-direct`.
6. Для відображення збереженого повідомлення використати `message` у відповіді save або окремо викликати `POST /api/rer-importer/messages-by-id`.

Copy endpoint сам по собі не створює запис у базі даних. Новий `signal_message` та всі пов’язані записи створюються під час submit.

## Endpoint-и

### Підготувати копії

```http
POST /api/1.1/messages/copy
Content-Type: application/json
```

Запит містить ID одного або кількох джерел:

```json
{
  "message_ids": [801, 802]
}
```

Endpoint доступний користувачам із роллю `Rer`.

Приклад відповіді:

```json
{
  "payloads": [
    {
      "full_body": "12.345 МГц\nКонтакт з позивним ALPHA",
      "text": "Контакт з позивним ALPHA",
      "comment": "Початковий коментар",
      "freq": "12.345",
      "coords": [{ "lat": 50.4501, "lon": 30.5234 }],
      "from": null,
      "to": ["ALPHA"],
      "tags": ["важливе", "радіо"],
      "timestamp": "2026-08-13T10:15:30.123Z",
      "post": "Пост 1",
      "unit": "Підрозділ 1",
      "locations": ["Київ"],
      "network": {
        "signal_name": null,
        "cc": null,
        "name": "мережа 1"
      },
      "dmr": [],
      "signal_group_master_key": "source-group-master-key",
      "device_name_id": 17,
      "upload_urls": null,
      "deleted_media_ids": null,
      "retained_media_ids": ["0190f2b7-7e2a-7c2b-a8e3-5f2b1e8a1111"],
      "parent_signal_message_ids": [801]
    }
  ]
}
```

Кожен елемент `payloads` є готовим значенням для `submit-direct`. Frontend має замінити `signal_group_master_key` на групу, у якій потрібно створити копію. Якщо копія формується з кількох джерел, frontend може об'єднати дані payload-ів і передати всі ID у `parent_signal_message_ids` одного submit payload.

`InboxMessage` навмисно не входить у цю відповідь. Якщо потрібна повна DTO-модель повідомлення для перегляду media, коментарів, metadata або полів, яких немає у submit payload, її потрібно отримати окремим endpoint-ом нижче.

### Отримати повний `InboxMessage` за ID

```http
POST /api/rer-importer/messages-by-id
Content-Type: application/json
```

Запит:

```json
{
  "message_ids": [801],
  "inbox_req": null
}
```

`inbox_req` можна не передавати або передати як `null`. Для цього endpoint за замовчуванням увімкнене формування point highlights.

Відповідь містить масив пар `[id, InboxMessage]`, а не JSON-об’єкт із ключами-ID. Скорочений приклад:

```json
{
  "messages": [
    [
      801,
      {
        "message_uid": "...",
        "text": "...",
        "media": [],
        "callsigns": ["ALPHA"],
        "timestamp": 1780000000000,
        "message_comments": [],
        "metadata": [],
        "parent_messages": [],
        "intelligence_reports": [
          {
            "id": 912,
            "is_accessible": true,
            "is_deleted": false,
            "text": "Короткий текст розвіддонесення",
            "attachments_count": 2,
            "timestamp": 1780000300000,
            "date": "2026-08-13",
            "time": "10:20",
            "group_name": "Група донесення",
            "group_master_key": null
          }
        ]
      }
    ]
  ]
}
```

`parent_messages` містить короткі дані оригіналів для розвіддонесення, а `intelligence_reports` — короткі дані розвіддонесень для оригіналу. Обидва масиви навмисно нерекурсивні. Фактична модель `InboxMessage` має багато додаткових полів. На frontend для декодування потрібно використовувати наявні `messageIdsReqEncoder` і `messageIdsRspDecoder`.

Endpoint доступний користувачам із роллю `Rer` або `ApiAgent`.

### Зберегти нову копію

```http
POST /api/1.1/submit-direct
Content-Type: application/json
```

Тіло запиту — це `payload` із copy response після редагування. Наприклад:

```json
{
  "full_body": "12.345 МГц\nОновлений текст повідомлення",
  "text": "Оновлений текст повідомлення",
  "comment": "Новий коментар",
  "freq": "12.345",
  "coords": [],
  "from": null,
  "to": ["ALPHA", "BRAVO"],
  "tags": ["важливе"],
  "timestamp": "2026-08-13T10:20:00.000Z",
  "post": "Пост 2",
  "unit": "Підрозділ 2",
  "locations": [],
  "network": null,
  "dmr": [],
  "signal_group_master_key": "target-group-master-key",
  "device_name_id": null,
  "upload_urls": ["<completed-upload-url>"],
  "deleted_media_ids": ["0190f2b7-7e2a-7c2b-a8e3-5f2b1e8a1111"],
  "retained_media_ids": [],
  "parent_signal_message_ids": [801, 802]
}
```

Відповідь:

```json
{
  "signal_message_id": 912,
  "message": {
    "message_uid": "...",
    "text": "Оновлений текст повідомлення",
    "media": []
  }
}
```

`message` у відповіді save може бути `null`. У такому випадку для оновленого відображення потрібно викликати `messages-by-id` із новим `signal_message_id`.

Для редагування вже існуючого повідомлення залишається endpoint `POST /api/1.1/message/{id}/edit`. `parent_signal_message_ids` є create-only полем: під час edit backend його ігнорує, а вже збережені зв’язки `intel_prod` не змінюються. Frontend має за можливості не передавати це поле під час edit.

## Поля `DirectSubmitPayload`

| Поле                        | Тип                                 | Поведінка під час копіювання                                                                                                                                         |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full_body`                 | `string \| null`                    | Повний текст повідомлення. Саме це поле використовується для побудови нового body.                                                                                   |
| `text`                      | `string \| null`                    | Текст без заголовків.                                                                                                                                                |
| `comment`                   | `string \| null`                    | Поточний редагований коментар користувача. Старі коментарі копіюються сервером, а значення цього поля замінює коментар поточного користувача.                        |
| `freq`                      | `string \| null`                    | Частота.                                                                                                                                                             |
| `coords`                    | `Array<{lat: number, lon: number}>` | Координати повідомлення.                                                                                                                                             |
| `from`                      | `string \| null`                    | Позивний відправника. У Rust-коді поле називається `from_callsign`, але JSON-ключ — саме `from`.                                                                     |
| `to`                        | `string[]`                          | Позивні адресатів.                                                                                                                                                   |
| `tags`                      | `string[] \| null`                  | Теги за назвами/label, не за числовими ID.                                                                                                                           |
| `timestamp`                 | `string \| null`                    | Час у форматі RFC 3339, зазвичай із мілісекундами та суфіксом `Z`.                                                                                                   |
| `post`                      | `string \| null`                    | Пост.                                                                                                                                                                |
| `unit`                      | `string \| null`                    | Підрозділ.                                                                                                                                                           |
| `locations`                 | `string[]`                          | Локації.                                                                                                                                                             |
| `network`                   | `SubmitNetwork \| null`             | Об’єкт `{signal_name, cc, name}`.                                                                                                                                    |
| `dmr`                       | `SubmitDmrMetadata[]`               | DMR metadata для submit. Для звичайної копії endpoint повертає `[]`.                                                                                                 |
| `signal_group_master_key`   | `string \| null`                    | Обов’язкова для звичайного повідомлення. Для розвіддонесення з `parent_signal_message_ids` може бути `null`; тоді воно доступне лише через оригінальне повідомлення. |
| `device_name_id`            | `number \| null`                    | ID пристрою або `null`, щоб очистити пристрій. Особливість nullable semantics описана нижче.                                                                         |
| `upload_urls`               | `string[] \| null`                  | URL нових завершених upload-ів. Нові файли зберігаються у S3 під час submit.                                                                                         |
| `deleted_media_ids`         | `string[] \| null`                  | UUID media, які потрібно виключити з копії. Для копії це UUID media батьківського повідомлення.                                                                      |
| `retained_media_ids`        | `string[] \| null`                  | UUID media батьківського повідомлення, які потрібно залишити в копії.                                                                                                |
| `parent_signal_message_ids` | `number[]`                          | ID усіх `signal_message`, на яких базується нова копія. Для звичайного submit передається порожній масив; під час edit поле ігнорується.                             |

Усі поля мають default/optional поведінку на рівні JSON, але звичайний submit без `parent_signal_message_ids` все одно вимагає непорожній `signal_group_master_key`. Для copy flow рекомендується передавати весь payload, який повернув endpoint підготовки копії, і змінювати лише поля форми.

### `device_name_id`: три стани

Поле підтримує відмінність між «не змінювати», «очистити» та «встановити»:

- поле відсутнє — не змінювати поточне значення;
- `"device_name_id": null` — очистити пристрій;
- `"device_name_id": 17` — встановити пристрій з ID `17`.

Copy endpoint повертає це поле явно: число, якщо пристрій був заданий, або `null`, якщо його не було.

## Media та S3

### Збереження незмінених media

`retained_media_ids` містить UUID media записів джерела. Під час копіювання backend:

- створює нові записи media для нового `signal_message`;
- використовує той самий `storage_key`;
- не завантажує незмінені файли повторно до S3.

Отже, UUID media у нової копії будуть іншими, хоча фізичний об’єкт у S3 залишиться тим самим. Після збереження frontend має брати media з `DirectSubmitRsp.message` або повторно завантажити `InboxMessage` через `messages-by-id`, а не використовувати старі UUID.

### Як обробляти зміни у формі

- Якщо користувач не змінював список старих media, можна залишити `retained_media_ids` таким, як його повернув copy endpoint.
- Якщо користувач видалив старі media, передайте у `retained_media_ids` лише ті UUID, які залишилися.
- Видалені UUID можна додатково передати у `deleted_media_ids`. Backend у будь-якому випадку виключить їх із копії.
- Нові файли передаються через `upload_urls`; вони не повинні додаватися до `retained_media_ids`.
- Якщо `retained_media_ids` не передати для копії, backend збереже всі media джерела, крім тих, що вказані у `deleted_media_ids`.
- `retained_media_ids` без `parent_signal_message_ids` є помилкою.
- UUID, які не належать жодному з повідомлень у `parent_signal_message_ids`, призводять до `404`.

Копія може містити лише media без тексту. Якщо немає ні тексту, ні media, submit поверне validation error.

## Пов’язані дані

Під час submit із `parent_signal_message_ids` backend серверно обробляє пов’язані дані всіх батьків. Frontend не має створювати окремі записи для:

- media;
- коментарів;
- тегів;
- callsigns;
- units;
- pelengs;
- networks;
- DMR/message metadata.

Залежні та похідні tokens генеруються або оновлюються сервером. `InboxMessage.metadata`, `callsign_tokens`, `signal_tokens`, `point_tokens` та інші службові поля не потрібно переносити у `DirectSubmitPayload`.

Якщо відповідні значення payload не були змінені, backend може перенести пов’язані pelengs, networks, units і metadata з джерела. Якщо текст, координати, network або інші значення змінилися, ці похідні дані можуть бути перебудовані замість прямого копіювання. Frontend має вважати payload основним джерелом значень і не покладатися на незмінність ID пов’язаних записів.

## Parent reference

Успішна копія зберігає зв’язки в таблиці `intel_prod`:

```text
intel_prod.signal_message_id = new_signal_message.id
intel_prod.parent_signal_message_id = every source ID
```

Frontend не повинен обнуляти або видаляти `parent_signal_message_ids` під час створення копії. Під час edit це поле можна не передавати: backend не змінює вже збережені зв’язки та не створює нових.

## Помилки

Для copy, submit і edit API повертає JSON такого формату:

```json
{
  "code": "validation_error",
  "message": "Оберіть групу."
}
```

Основні HTTP-коди:

| HTTP  | `code`             | Приклад ситуації                                                                                              |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `400` | `validation_error` | Не вказана група для звичайного повідомлення, немає тексту та media, некоректний UUID або несумісний payload. |
| `401` | `unauthenticated`  | Сесія завершилася.                                                                                            |
| `403` | `forbidden`        | Недостатньо прав.                                                                                             |
| `404` | `not_found`        | Початкове повідомлення, цільова група або media не знайдені/недоступні.                                       |
| `500` | `internal_error`   | Внутрішня помилка збереження або storage.                                                                     |

Помилки потрібно показувати користувачу через стандартну frontend-обробку API-помилок; їх не слід мовчки ігнорувати.

## Рекомендована поведінка UI

1. Показати loading state під час підготовки копії.
2. Вважати `payloads` чернетками та дати користувачу вибрати або очистити `signal_group_master_key` для розвіддонесення.
3. При зміні media підтримувати окремо старі UUID (`retained_media_ids`) і нові upload URL (`upload_urls`).
4. Заборонити повторне натискання Save під час submit.
5. Після успішного submit перейти до нового `signal_message_id` і оновити дані повідомлення з відповіді або через `messages-by-id`.
6. Якщо copy endpoint повернув `404`, оновити список/деталі повідомлень і запропонувати користувачу повторити дію.

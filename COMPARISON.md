# Порівняння payload submit inbox

## Що саме порівнюємо

Порівнюємо **одну логічну одиницю повідомлення**, а не весь batch wrapper.

- **v1.1 payload**: весь request body для `POST /api/1.1/rer-importer/inbox/submit`.
- **legacy item payload**: другий елемент одного legacy tuple з `messages`, тобто `InboxMessage` у `[existing_message_id, InboxMessage]`.

Legacy endpoint має batch wrapper:

```json
{
  "messages": [
    [42, { "...": "InboxMessage item" }]
  ]
}
```

У цьому документі `42` і wrapper `messages` розглядаються окремо як транспорт legacy API. Основне порівняння нижче: **v1.1 object** проти **legacy `InboxMessage` object**.

## Приклади

v1.1:

```json
{
  "text": "2026-02-18T08:49:00Z F=404.1350 (МГц)\n...",
  "freq": "404.1350",
  "coords": { "lat": 46.7449, "lon": 32.9434 },
  "callsigns": ["ЯРУС", "СВЕТЛЫЙ"],
  "timestamp": "2026-02-18T08:49:00Z",
  "sender": "chumak",
  "full_body": "Сигнали: dmr\nМережа: УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
  "post": "Пост Копані",
  "unit": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
  "location": "КОПАНІ",
  "group_names": ["Чумак DMR Копані"],
  "source": "chumak",
  "network": { "signal_name": "dmr", "cc": 1, "name": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А" },
  "dmr": [
    {
      "timestamp": "2026-02-18T08:49:00Z",
      "cc": 1,
      "freq": "404.1350",
      "signal_name": "dmr",
      "sender_id": 110,
      "sender_name": "ЯРУС",
      "call_group_id": 50,
      "call_group_name": "СВЕТЛЫЙ"
    }
  ]
}
```

Legacy item у batch:

```json
[
  42,
  {
    "text": "2026-02-18T08:49:00Z F=404.1350 (МГц)\n...",
    "date": "2026-02-18",
    "time": "10:49:00",
    "freq": "404.1350",
    "coords": "46.7449, 32.9434",
    "callsigns": ["ЯРУС", "СВЕТЛЫЙ"],
    "checked": true,
    "timestamp": 1771404540000,
    "group_master_key": "echo.group-master-key",
    "sender": "chumak",
    "extended_form": "Сигнали: dmr\nМережа: УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
    "post": "Пост Копані",
    "post_id": 7,
    "unit": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
    "location": "КОПАНІ"
  }
]
```

Legacy `InboxMessage` має більше internal/UI полів (`tokens`, `tags`, `metadata`, `network_ids`, etc.). Вони не показані тут навмисно: це не корисні поля для зближення зовнішнього v1.1 API з legacy item.

## Корисна відповідність полів

| Зміст | v1.1 | Legacy item | Різниця, яка реально важлива |
| --- | --- | --- | --- |
| Текст | `text` | `text` | Уже однаково. |
| Частота | `freq` | `freq` | Уже близько; сервер нормалізує формат. |
| Позивні | `callsigns` | `callsigns` | Уже однаково для текстових позивних. |
| Sender | `sender` | `sender` | Уже однаково. |
| Пост | `post`, `post_id?` | `post`, `post_id` | Близько; v1.1 може працювати тільки з `post`. |
| Підрозділ | `unit` | `unit` | Уже однаково. |
| Локація | `location` | `location` | Уже однаково. |
| Додатковий повний текст | `full_body` | `extended_form` | Однаковий зміст, різна назва. |
| Координати | `{ "lat", "lon" }` | `"lat, lon"` | Однаковий зміст, різний shape. |
| Timestamp | RFC 3339 string | epoch ms + `date`/`time` | Однаковий зміст, різні формати. |
| Група | `group_names[]` | `group_master_key` | v1.1 приймає зовнішню назву, legacy працює з internal key. |
| Ідентифікація message | optional `message_id` string | numeric id у tuple `[id, item]` | Різна модель ідентичності. |
| DMR metadata | `network`, `dmr[]` | internal `metadata[]` або parsed state | v1.1 має зовнішній contract для DMR; legacy shape не є добрим зовнішнім contract. |

## Найважливіші відмінності

1. **Batch vs single item**

   Legacy endpoint batch-овий, але один item у ньому концептуально близький до v1.1 payload. Якщо треба зближувати API, можна додати batch wrapper для v1.1 окремо, але сам shape одного item краще тримати простим.

2. **Назва `full_body` vs `extended_form`**

   Це найпростіша різниця для зближення. Поля мають один зміст: додатковий повний опис/коментар до повідомлення.

   Можливий майбутній крок: у v1.1 приймати `full_body` як основне поле й optional alias `extended_form` для сумісності, але в документації лишити `full_body`.

3. **Координати**

   v1.1 має кращий зовнішній contract: `{ "lat": number, "lon": number }`. Legacy item має string, бо це UI/internal shape.

   Можливий майбутній крок: якщо потрібна максимальна сумісність, v1.1 може приймати обидва варіанти (`coords` object або legacy string), але документувати object як основний.

4. **Timestamp**

   v1.1 має кращий зовнішній contract: один RFC 3339 timestamp із timezone. Legacy item дублює час як epoch ms + `date` + `time`.

   Не варто зближувати v1.1 у бік `date`/`time` або epoch ms. Краще, щоб legacy/internal code продовжував derivation із canonical timestamp.

5. **Групи**

   v1.1 приймає `group_names`, бо зовнішня інтеграція знає назви груп. Legacy item має `group_master_key`, бо UI працює з уже створеними internal groups.

   Можливий майбутній крок: якщо треба зробити item-и ближчими, можна додати read-only/derived documentation mapping: `group_names[] -> group_master_key`, але не вимагати external clients передавати internal key.

6. **DMR metadata**

   v1.1 `dmr[]` і `network` є корисним зовнішнім contract. Legacy `metadata[]` є internal representation і не має бути ціллю для копіювання.

   Можливий майбутній крок: якщо треба closer shape, назвати internal mapping явно: `dmr[]` перетворюється на inbox metadata rows. Не варто змушувати v1.1 клієнтів відправляти legacy `metadata[]`.

## Що можна зближувати без погіршення v1.1

| Пріоритет | Зміна | Чому корисно |
| --- | --- | --- |
| 1 | Приймати `extended_form` як alias до `full_body` | Просте зближення назв без зміни збереження. |
| 2 | Опціонально приймати legacy string `coords` поряд із object `coords` | Полегшує migration старих клієнтів, але object має лишитись основним. |
| 3 | Документувати derived поля `date`/`time` як server-generated legacy equivalents | Дає зрозумілу відповідність без додавання зайвих input fields. |
| 4 | Додати v1.1 batch endpoint або wrapper тільки якщо зовнішнім клієнтам справді потрібен batch | Зближує транспортний рівень, але не треба ускладнювати single submit без потреби. |
| 5 | Явно документувати mapping `dmr[] -> metadata` | Допомагає backend/UI debugging без витоку internal payload shape у API. |

## Що краще не зближувати

| Legacy field/shape | Причина |
| --- | --- |
| `checked` | Це server/UI state, не корисний input для інтеграції. |
| `important`, `bookmarked` | User-specific state. |
| `date`, `time` як input | Дублюють `timestamp` і створюють ризик конфлікту. |
| epoch milliseconds timestamp | Менш явний формат, немає timezone у самому значенні. |
| `group_master_key` | Internal identifier, зовнішній API має приймати назви або зовнішні ids. |
| `callsign_tokens`, `signal_tokens`, `keyword_tokens`, `text_marked` | Derived rendering/search fields. |
| legacy `metadata[]` як input | Internal representation; v1.1 `dmr[]` кращий contract. |

## Практичний висновок

v1.1 уже близький до одного legacy `InboxMessage` за бізнес-полями: `text`, `freq`, `callsigns`, `sender`, `post`, `unit`, `location`.

Основні розбіжності не в даних, а в API boundary:

- v1.1 використовує clean external shapes: RFC 3339 timestamp, structured coordinates, group names, DMR records.
- Legacy item використовує UI/internal shapes: DB id tuple, epoch ms, string coords, `group_master_key`, derived/internal fields.

Якщо треба робити їх ближчими, найкращий шлях - додавати сумісні aliases і чіткі mappings у v1.1, але не переносити internal legacy fields у зовнішній contract.

# Інтеграція Echo Chumak

Це dependency-free Python CLI для перевірки Echo endpoint-ів, потрібних для Chumak.

## Налаштування

```sh
cp .env.example .env
```

Для staging інтеграції можна використовувати `.env.example` як `.env`: запишіть вміст `.env.example` у `.env`, як у команді вище. У `.env.example` `ECHO_*` значення вказані для staging. Для production інтеграції потрібно запросити production base URL, login і password. `CHUMAK_*` значення описують тестовий payload.

## Команди

1)
```sh
python3 test_chumak.py login
```

Виконує POST запит `/api/user/login` на Echo і виводить отримані session cookies.
Приклад request payload:
```json
{
  "login": "chumak-api",
  "password": "1234"
}
```

Очікуваний output:

```text
PASS: logged in as <ECHO_LOGIN>
Cookie: <cookie-name>=<session-cookie>; ...
```

2) 
```sh
python3 test_chumak.py find-networks
```

Пошук активних мереж за частотою та (опційно) color code.
Виконує POST запит на `/api/sigint/network/find-live`.
Приклад request payload:

```json
{
  "freq": "404.1350",
  "color_code": "1"
}
```

Приклад response payload:

```json
{
  "networks": [
    {
      "details": {
        "id": 123,
        "name": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
        "location": "КОПАНІ",
        "radio_station": "Motorola DP4800",
        "purpose": "Управління підрозділом",
        "operation_mode": "DMR",
        "operation_type": "Голос",
        "operation_period": "Цілодобово",
        "created_at": 1781851200000,
        "active_from": 1781851200000,
        "active_to": 1781937600000,
        "units": ["3 мсб 291 мсп 42 мсд 58 А"],
        "post_ids": [5]
      },
      "live_freqs": ["404.1350"],
      "callsigns": ["ярус", "светлый"],
      "locations": ["КОПАНІ"]
    }
  ]
}
```

Якщо збігів немає, відповідь буде:

```json
{
  "networks": []
}
```

3)
```sh
python3 test_chumak.py submit-message
```

Створення нового повідомлення.
Виконує POST запит на `/api/1.1/rer-importer/inbox/submit`.

Усі timestamp-поля в API v1.1 передаються рядками у форматі RFC 3339. Для UTC використовуйте суфікс `Z`, наприклад `2026-02-18T08:49:00Z`. Epoch milliseconds та timestamp без timezone не приймаються.

Приклад request payload:

```json
{
  "text": "- ЯРУС СВЕТЛЫЙ на приеме.\n- ТУМАН в гараже. Оттуда вернулся, нормально вроде.\n- Принял.",
  "freq": "404.1350",
  "coords": [
    {
      "lat": 46.7449,
      "lon": 32.9434
    }
  ],
  "callsigns": ["ЯРУС", "СВЕТЛЫЙ"],
  "tags": ["БпЛА", "Втрати"],
  "timestamp": "2026-02-18T08:49:00Z",
  "sender": "chumak",
  "full_body": "2026-02-18T08:49:00Z F=404.1350 (МГц)\nОтримано з поста \"Пост Копані\"\nУКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А 🆓 (КОПАНІ) СС:1 CG:50\nID➡️:110(ЯРУС)\nID(CG)⬅️:50(СВЕТЛЫЙ)\nЯРУС\nСВЕТЛЫЙ\n- ЯРУС СВЕТЛЫЙ на приеме.\n- ТУМАН в гараже. Оттуда вернулся, нормально вроде.\n- Принял.",
  "post": "Пост Копані",
  "unit": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
  "locations": ["КОПАНІ"],
  "group_names": ["Чумак DMR Копані"],
  "network": {
    "signal_name": "dmr",
    "cc": 1,
    "name": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А"
  },
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

`message_uid` можна передати опційно, якщо потрібно оновити вже створене Echo повідомлення з того самого datasource. Якщо `message_uid` не передано, Echo створює нове повідомлення і повертає його `message_uid` у response.
Частоти нормалізуються до чотирьох знаків після крапки: `404.135` буде збережено як `404.1350`, а зайві знаки будуть обрізані.

`coords` передавайте як масив WGS84 координат з `lat` і `lon`. Якщо координат немає, поле можна не передавати або передати порожній масив. Поточна інтеграція Echo зберігає першу координату як основну координату inbox item.

`locations` передавайте як масив назв локацій. Якщо локацій немає, поле можна не передавати або передати порожній масив.

`tags` передавайте як масив назв тегів Echo. Echo прив'яже тільки наявні активні теги; якщо тег не знайдено, запит не падає, тег пропускається, а помилка записується в error log.

Приклад response payload для успішного запиту:

```json
{
  "message_uid": "msg-a1208-6734-2879",
  "warnings": []
}
```

Скрипт `test_chumak.py` перед надсиланням виводить фактичний JSON payload, сформований із `.env`.

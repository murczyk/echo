# Інтеграція Echo Chumak

Це dependency-free Python CLI для перевірки Echo endpoint-ів, потрібних для Chumak.

## Налаштування

```sh
cp .env.example .env
```

Для staging інтеграції можна використовувати `.env.example` як `.env`: запишіть вміст `.env.example` у `.env`, як у команді вище. У `.env.example` `ECHO_*` значення вказані для staging. Для production інтеграції потрібно запросити production base URL, login і password. `CHUMAK_*` значення описують тестовий payload.

## Команди

Увійти в Echo і вивести отримані session cookies:

```sh
python3 test_chumak.py login
```

Очікуваний output:

```text
PASS: logged in as <ECHO_LOGIN>
Cookie: <cookie-name>=<session-cookie>; ...
```

Знайти активні мережі за обов'язковою частотою та необов'язковими AOR/color code:

```sh
python3 test_chumak.py find-networks
```

Створити нове повідомлення Chumak в inbox:

```sh
python3 test_chumak.py submit-message
```

## Пошук активних мереж

Endpoint:

```text
POST /api/sigint/network/find-live
```

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
        "aor_ids": [1],
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

## Надсилання нового повідомлення

Endpoint:

```text
POST /api/rer-importer/inbox/submit
```

Можна надіслати generic submit payload напряму або використати команду:

```sh
python3 test_chumak.py submit-message
```

Приклад request payload:

```json
{
  "messages": [
    {
      "text": "2026-02-18T08:49:00 F=404.1350 (МГц)\nОтримано з поста \"Пост Копані\"\nУКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А 🆓 (КОПАНІ) СС:1 CG:50\nID➡️:110(ЯРУС)\nID(CG)⬅️:50(СВЕТЛЫЙ)\nЯРУС\nСВЕТЛЫЙ\n1.ЯРУС СВЕТЛОМУ\n2.СВЕТЛЫЙ ЯРУС на приеме.\n1.ТУМАН у вас?\n2.ТУМАН в гараже. Оттуда вернулся, нормально вроде.\n1.Принял.",
      "date": "18.02.2026",
      "time": "08:49:00",
      "freq": "404.1350",
      "coords": "",
      "callsigns": ["ЯРУС", "СВЕТЛЫЙ"],
      "checked": true,
      "timestamp": 1771404540000,
      "sender": "chumak",
      "extended_form": "Сигнали: dmr\nМережа: УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
      "post": "Пост Копані",
      "unit": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
      "location": "КОПАНІ",
      "group_names": ["Чумак DMR Копані"],
      "source": "chumak",
      "network": {
        "signal_name": "dmr",
        "cc": 1,
        "name": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А"
      },
      "dmr": [
        {
          "timestamp": "2026-02-18T08:49:00",
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
  ]
}
```

`callsigns` передавайте як текстові позивні. Якщо джерело має і текстовий позивний, і DMR ID, текстовий позивний іде в `callsigns`, `dmr.sender_name` або `dmr.call_group_name`, а числовий DMR ID іде в `dmr.sender_id` або `dmr.call_group_id`.

Перший запис у `dmr` є primary record. Echo використовує його `cc` як основний color code. Якщо наступні `dmr` записи або `network.cc` мають інший `cc`, Echo зберігає primary `cc` і повертає warning у response.

Частоти нормалізуються до чотирьох знаків після крапки: `404.135` буде збережено як `404.1350`, а зайві знаки будуть обрізані.

Echo синхронно створює `signal_message`, inbox item і повертає власний opaque string ID повідомлення. Не розбирайте його як число: значення може містити літери.

Приклад response payload для успішного запиту:

```json
{
  "messages": [
    {
      "message_id": "msg-a1208-6734-2879"
    }
  ],
  "warnings": []
}
```

Скрипт `test_chumak.py` перед надсиланням виводить фактичний JSON payload, сформований із `.env`.

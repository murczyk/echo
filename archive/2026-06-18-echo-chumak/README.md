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

Очікуваний output без збігів:

```text
Request payload: {"freq": "145.0260", "aor_id": 1, "color_code": "1"}
{
  "networks": []
}
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
  "freq": "145.0260",
  "aor_id": 1,
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
        "name": "Chumak test network",
        "location": "ЛИМАН ПЕРШИЙ",
        "radio_station": "Motorola DP4800",
        "purpose": "Ретрансляція голосового зв'язку",
        "operation_mode": "DMR",
        "operation_type": "Голос",
        "operation_period": "Цілодобово",
        "created_at": 1781851200000,
        "active_from": 1781851200000,
        "active_to": 1781937600000,
        "units": ["Підрозділ 1"],
        "aor_ids": [1],
        "post_ids": [5]
      },
      "live_freqs": ["145.026"],
      "callsigns": ["110", "50"],
      "signals": ["dmr"],
      "pelengs": [
        {
          "id": 77,
          "inbox_item_id": 555,
          "lat": 49.12345,
          "lng": 37.12345,
          "settlement": "ЛИМАН ПЕРШИЙ",
          "locality_direction": "пн.-сх.",
          "distance_m": 1200.0,
          "country_code": "UA",
          "timestamp": 1781851200000
        }
      ],
      "locations": ["ЛИМАН ПЕРШИЙ"]
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
POST /api/rer-importer/inbox/chumak-submit
```

Можна надіслати цей payload напряму або використати команду:

```sh
python3 test_chumak.py submit-message
```

Приклад request payload:

```json
{
  "ID": "123",
  "message": "2026-06-19T14:00:00 F=145.0260 (МГц)\nУКХ р/м СС:1 CG:50\nID➡️:110(ЯРУС)\nТестове повідомлення Chumak",
  "timestamp": "2026-06-19T14:00:00",
  "freq": "145.0260",
  "locations": ["ЛИМАН ПЕРШИЙ"],
  "tags": ["chumak-test"],
  "no_headers_body": "Тестове повідомлення Chumak",
  "media": [],
  "coordinates": "",
  "signals": "dmr",
  "callsign_from": "110",
  "callsign_to": "50",
  "callsigns_other": [],
  "network_name": "Chumak test network",
  "unit": "Підрозділ 1",
  "group_names": ["Chumak test group"],
  "sender": "chumak",
  "post": "Chumak",
  "network": {
    "signal_name": "dmr",
    "cc": 1,
    "name": "Chumak test network"
  },
  "dmr": [
    {
      "timestamp": "2026-06-19T14:00:00",
      "cc": 1,
      "freq": "145.0260",
      "signal_name": "Dmr",
      "sender_id": 110,
      "abonent_id": 50
    }
  ]
}
```

Поле `ID` обов'язкове: Echo зберігає його як `signal_message.external_id`, щоб потім знайти і простежити це повідомлення в Echo. `ID` передається як текст, але має містити число.

Приклад response payload для успішного запиту:

```json
{
  "external_id": 123
}
```

Скрипт `test_chumak.py` перед надсиланням виводить фактичний JSON payload, сформований із `.env`.

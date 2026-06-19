# Інтеграція Echo Chumak

Це dependency-free Python CLI для перевірки Echo endpoint-ів, потрібних для Chumak.

## Налаштування

```sh
cp .env.example .env
```

Заповніть у `.env` адресу Echo, логін, пароль і тестові значення Chumak.

## Команди

Увійти в Echo і вивести отримані session cookies:

```sh
just login
```

Знайти активні мережі за обов'язковою частотою та необов'язковими AOR/color code:

```sh
just find-networks
```

Створити нове повідомлення Chumak в inbox:

```sh
just submit-message
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
  "aor_id": null,
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
        "radio_station": null,
        "purpose": null,
        "operation_mode": null,
        "operation_type": null,
        "operation_period": null,
        "created_at": 1781851200000,
        "active_from": 1781851200000,
        "active_to": null,
        "units": ["Підрозділ 1"],
        "aor_ids": [10],
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
          "locality_direction": null,
          "distance_m": null,
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
just submit-message
```

Приклад request payload:

```json
{
  "message": "2026-06-19T14:00:00 F=145.0260 (МГц)\nУКХ р/м СС:1 CG:50\nID➡️:110(ЯРУС)\nТестове повідомлення Chumak",
  "timestamp": "2026-06-19T14:00:00",
  "freq": "145.0260",
  "locations": ["ЛИМАН ПЕРШИЙ"],
  "tags": ["chumak-test"],
  "no_headers_body": "Тестове повідомлення Chumak",
  "media": [],
  "coordinates": "49.12345, 37.12345",
  "signals": "dmr",
  "callsign_from": "110",
  "callsign_to": "50",
  "callsigns_other": [],
  "network_name": "Chumak test network",
  "unit": null,
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

Приклад response payload для успішного запиту:

```json
null
```

Скрипт `test_chumak.py` перед надсиланням виводить фактичний JSON payload, сформований із `.env`.

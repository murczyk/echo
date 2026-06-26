# Submit Inbox Payload Comparison

## Legacy `/api/rer-importer/inbox/submit`

Used by the existing Echo UI/editor flow. It submits a batch of existing inbox messages as `(message_id, InboxMessage)` tuples.

```json
{
  "messages": [
    [
      42,
      {
        "message_uid": null,
        "text": "2026-02-18T08:49:00Z F=404.1350 (МГц)\n...",
        "media": [],
        "images": [],
        "image_recognized": [],
        "date": "2026-02-18",
        "time": "10:49:00",
        "freq": "404.1350",
        "coords": "46.7449, 32.9434",
        "callsigns": ["ЯРУС", "СВЕТЛЫЙ"],
        "callsigns_alg2": [],
        "checked": true,
        "important": false,
        "bookmarked": false,
        "timestamp": 1771404540000,
        "group_master_key": "echo.group-master-key",
        "sender": "chumak",
        "extended_form": "Сигнали: dmr\nМережа: УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
        "post": "Пост Копані",
        "post_id": 7,
        "unit": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
        "callsign_tokens": null,
        "signal_tokens": null,
        "point_tokens": null,
        "no_headers_body": null,
        "keyword_tokens": null,
        "text_marked": null,
        "datasource_id": null,
        "location": "КОПАНІ",
        "tags": null,
        "network_ids": null,
        "inbox_tags": null,
        "metadata": []
      }
    ]
  ]
}
```

## Generic v1.1 `/api/1.1/rer-importer/inbox/submit`

Used by external integrations. It submits one new/updated message directly.

```json
{
  "text": "2026-02-18T08:49:00Z F=404.1350 (МГц)\n...",
  "freq": "404.1350",
  "coords": {
    "lat": 46.7449,
    "lon": 32.9434
  },
  "callsigns": ["ЯРУС", "СВЕТЛЫЙ"],
  "timestamp": "2026-02-18T08:49:00Z",
  "sender": "chumak",
  "full_body": "Сигнали: dmr\nМережа: УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А",
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

Key differences:

- Legacy batches existing message edits in `messages`; v1.1 accepts one message body.
- Legacy uses `checked`, `extended_form`, string `coords`, and epoch millisecond `timestamp`; v1.1 uses implicit checked state, `full_body`, structured `coords.lat`/`coords.lon`, and RFC 3339 timestamps.
- Legacy response is `{ "messages": [{ "message_id": "..." }], "warnings": [...] }`; v1.1 response is `{ "message_id": "...", "warnings": [...] }`.

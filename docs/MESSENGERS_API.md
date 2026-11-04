# Messengers viewer API

Draft specification of the read-only API that the Echo web UI uses to browse
ingested messenger data: accounts, their chats, chat members and messages. The
data is pushed by collectors through the
[messenger ingest API](MESSENGER_INGEST.md). Sections marked **Planned** are
proposals, not contracts.

Base path: `/api/messengers`

Messenger accounts are browsed only through this API. Their groups and messages
are removed from the RER inbox and analysis feeds; see
[Changes to RER endpoints](#changes-to-rer-endpoints).

## Endpoint index

| Route | Status | Request | Response |
|---|---|---|---|
| `POST /accounts/list` | Implemented | `{}` | `MessengersAccountsListRsp` |
| `POST /accounts/get` | Planned | `MessengersAccountGetReq` | `MessengersAccountDetails` |
| `POST /chats/list` | Planned | `MessengersChatsListReq` | `MessengersChatsListRsp` |
| `POST /chats/members/list` | Planned | `MessengersChatMembersListReq` | `MessengersChatMembersListRsp` |
| `POST /messages/list` | Planned | `MessengersMessagesListReq` | `MessengersMessagesListRsp` |

Every route is a read. Requests use `POST` with a JSON body, like
`/api/rer-importer/get-inbox`, so later filters can be added as optional body
fields without changing the route.

## Access

- Requests use the regular Echo session.
- A login needs the `CyberMessengers` role and the base role check
  (`ensure_base_role`: effective `Rer` or `CyberViewerRestricted`).
  `CyberMessengers` is an add-on role and grants nothing on its own.
- `Admin` includes `CyberMessengers`. `Cyber`, `CyberViewer` and
  `CyberViewerRestricted` do not; it is always assigned explicitly.
- An account is visible only when its group is in
  `get_identity_sigint_groups` for the login (organism areas of responsibility
  and zone), the same check that protects inbox messages and media. The ingest
  datasource must be linked to the viewer's zone, otherwise the account is not
  visible.
- Chats, members and messages are only reachable through a parent resolved
  within the caller's scope.
- Attachments are served by the existing `/api/messenger/media/{id}` routes.
  They require the base role and a group shared with the message, which the
  rules above already imply.

## Conventions

| Topic | Rule |
|---|---|
| Encoding | JSON request and response bodies, `snake_case` field names |
| Echo ids | UUIDv7 strings (`id`) |
| Collector ids | `external_id`, as sent by the collector |
| Messenger ids | 64-bit protocol ids travel as **decimal strings** inside provider sub-objects, because they can exceed 2^53 |
| Timestamps | Integer milliseconds since the Unix epoch, UTC |
| Optional fields | `T \| null` |
| Collections | Always present, may be empty; never `null` |
| Pagination | `messages/list` only. The other lists return every item |
| Deleted rows | Soft-deleted accounts, chats, members and messages are left out of lists, and a deleted account or chat is a `404`. A deleted member still appears as the `sender` of its old messages, with `deleted: true` |

A disabled ingest datasource only stops ingest; data already stored stays
readable.

Provider sub-objects follow the
[ingest rules](MESSENGER_INGEST.md#messenger-types-and-provider-sub-objects):
`telegram` is `null` when the id is unknown or the account is not a Telegram
account.

### Errors

| Status | Meaning | Body |
|---|---|---|
| `400` | Invalid uuid, or invalid `cursor`, `limit` or `direction` on `messages/list` | Plain-text message |
| `401` | Not authenticated | `Unauthenticated` |
| `403` | Missing `CyberMessengers`, or missing `Rer` / `CyberViewerRestricted` | `Forbidden` |
| `404` | Account or chat is unknown, deleted, outside the caller's groups, or the chat is not under that account | `Not found` |

The `404` cases are indistinguishable, so the API never confirms that an id
exists outside the caller's scope.

## Accounts

### `POST /accounts/list`

Every visible account, ordered by `display_name`, then `id`. The web UI groups
accounts by `messenger_type`, so there is no separate messenger types endpoint.

```ts
type MessengersAccountsListRsp = {
  items: MessengersAccountItem[]
}

type MessengersAccountItem = {
  id: string                            // Echo account uuid
  messenger_type: string                // "Telegram" | "Max"
  external_id: string
  display_name: string
  username: string | null
  phone: string | null
  status: string | null                 // collector session status
  is_active: boolean | null
  is_paused: boolean | null
  last_sync: number | null              // collector's last successful sync
  telegram: { user_id: string } | null
  datasource_group: MessengersDatasourceGroup
}

// The Echo group that mirrors the account
type MessengersDatasourceGroup = {
  id: number
  group_master_key: string              // "messenger_ingest.<account id>"
  datasource_id: number
  name: string                          // follows display_name
  last_sync_at: number                  // epoch ms, last change by ingest
  created_at: number                    // epoch ms
}
```

Example response:

```json
{
  "items": [
    {
      "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
      "messenger_type": "Telegram",
      "external_id": "17",
      "display_name": "Оператор 17",
      "username": "op17",
      "phone": "+380501112233",
      "status": "active",
      "is_active": true,
      "is_paused": false,
      "last_sync": 1760430000000,
      "telegram": { "user_id": "7012345678" },
      "datasource_group": {
        "id": 4182,
        "group_master_key": "messenger_ingest.0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
        "datasource_id": 57,
        "name": "Оператор 17",
        "last_sync_at": 1760430000000,
        "created_at": 1759000000000
      }
    }
  ]
}
```

### `POST /accounts/get`

```ts
type MessengersAccountGetReq = {
  account_id: string                    // Echo account uuid
}

type MessengersAccountDetails = MessengersAccountItem & {
  first_name: string | null
  last_name: string | null
  status_error: string | null
  status_changed_at: number | null      // epoch ms
  notes: string | null
  created_at: number | null             // when the collector added the account
  chats_count: number                   // chats that are not deleted
}
```

`created_at` and `last_sync` are the values the collector sent
(`external_created_at`, `external_last_sync_at`), as in ingest.

## Chats

### `POST /chats/list`

Every chat of one account, most recent first:
`last_message_date` descending with nulls last, then `id` descending.

```ts
type MessengersChatsListReq = {
  account_id: string
}

type MessengersChatsListRsp = {
  items: MessengersChatItem[]
}

type MessengersChatItem = {
  id: string                            // Echo chat uuid
  messenger_type: string
  external_id: string
  chat_type: string | null
  title: string | null
  username: string | null
  members_count: number | null
  account_member_status: string | null  // the account's membership in the chat
  last_message_date: number | null      // epoch ms
  telegram: { chat_id: string } | null
}
```

### `POST /chats/members/list`

Every member of one chat, ordered by `external_id`. A very large group is
returned in one response; this is a known limit of the unpaginated list.

```ts
type MessengersChatMembersListReq = {
  account_id: string
  chat_id: string
}

type MessengersChatMembersListRsp = {
  items: MessengersChatMemberItem[]
}

type MessengersChatMemberItem = {
  id: string                            // Echo chat member uuid
  messenger_type: string
  external_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  is_bot: boolean | null
  role: string | null                   // creator, admin, member, ...
  joined_date: number | null            // epoch ms
  telegram: { user_id: string } | null
}
```

## Messages

### `POST /messages/list`

One page of a chat's messages, for infinite scroll. Messages are ordered by
send time, then id, and each page is newest first.

```ts
type MessengersMessagesListReq = {
  account_id: string
  chat_id: string
  cursor: string | null                 // from a previous response
  limit: number | null                  // default 50, at most 100
  direction: "older" | "newer" | null   // default "older"
}

type MessengersMessagesListRsp = {
  items: MessengersMessageItem[]
  older_cursor: string | null           // null at the start of the chat
  newer_cursor: string | null           // set on every non-empty page
}

type MessengersMessageItem = {
  id: string                            // Echo message uuid
  external_id: string
  sent_at: number                       // epoch ms
  text: string
  is_outgoing: boolean | null
  has_media: boolean | null
  sender: MessengersMessageSender | null  // null for channel posts / unknown
  attachments: MessengersAttachment[]
  telegram: { message_id: string } | null
}

type MessengersMessageSender = {
  id: string                            // Echo chat member uuid
  external_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  is_bot: boolean | null
  deleted: boolean
  telegram: { user_id: string } | null
}

// MessageMediaInfo, the attachment type of the inbox, plus messenger metadata
type MessengersAttachment = MessageMediaInfo & {
  external_id: string
  created_at: number | null             // when the collector recorded the media
  telegram: { file_id: string, media_type: string | null } | null
}
```

Example response:

```json
{
  "items": [
    {
      "id": "0199e3a8-5e6f-7a0b-9c1d-2e3f4a5b6c7d",
      "external_id": "5550001",
      "sent_at": 1760431100000,
      "text": "Колона техніки рухається в напрямку села",
      "is_outgoing": false,
      "has_media": true,
      "sender": {
        "id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c6",
        "external_id": "6011122233",
        "username": "observer_ua",
        "first_name": "Andrii",
        "last_name": null,
        "is_bot": false,
        "deleted": false,
        "telegram": { "user_id": "6011122233" }
      },
      "attachments": [
        {
          "id": "0199e3a8-4d5e-7f60-8172-839405162738",
          "content_type": "image/jpeg",
          "file_name": "photo_2026-10-14.jpg",
          "size_bytes": 482113,
          "href": "/api/messenger/media/0199e3a8-4d5e-7f60-8172-839405162738",
          "transcription": null,
          "ocr": null,
          "summary": null,
          "coordinate_status": null,
          "kmz_conversion_status": null,
          "positions": [],
          "external_id": "5550001:0",
          "created_at": 1760431200000,
          "telegram": { "file_id": "5413920012345678901", "media_type": "photo" }
        }
      ],
      "telegram": { "message_id": "48211" }
    }
  ],
  "older_cursor": "…",
  "newer_cursor": "…"
}
```

Semantics:

- Without a `cursor`, the response is the newest page, whatever the
  `direction`.
- `direction: "older"` with `older_cursor` loads the next page up the history.
- `direction: "newer"` with `newer_cursor` returns messages sent after that
  point. An empty page means nothing new, and the same cursor can be sent again.
- A `newer` page holds at most `limit` messages, those closest to the cursor.
- `cursor` is opaque. It keeps full timestamp precision, so messages sharing a
  millisecond are neither skipped nor repeated.
- `text` is the stored message body; a message without text has `""`.
- Messages deleted in Echo (`signal_message.deleted`) are left out.
- Messages are visible before their attachments arrive, so `has_media: true`
  with an empty `attachments` is valid.

## Changes to RER endpoints

Groups of messenger accounts and their messages are removed from the feeds
below, for every login, including `Admin` and `CyberMessengers`. Ingest is not
affected: messages are still stored and processed.

The feeds read `get_rer_feed_sigint_groups`, which is
`get_identity_sigint_groups` without messenger account groups, recognized by
the `messenger_ingest.` master key prefix. Filtering the group keys up front
covers both the PostgreSQL and the analytics read paths.
`get_identity_sigint_groups` itself keeps those groups, because media access and
this API authorize messenger data with it.

| Area | Routes | Change |
|---|---|---|
| Analysis | `/api/rer/analysis/stats`, `/api/rer/analysis/stats/*` and their `/count` routes, `summary-table-freq`, `correlated-freqs`, `new-callsigns`, `activity-daily`, `callsign-relations`, `callsign-frequency-matches`, `callsigns-page`, GeoJSON and KMZ exports | Feed group keys |
| Inbox | `/api/rer-importer/get-inbox`, `get-inbox-count`, `get-inbox-map`, `map-settlement-messages`, `get-inbox-group-stats`, `get-inbox-unit-stats`, `messages-by-id-matching-filters` | Feed group keys |
| Other reads | `/api/rer-importer/latest-senders`, `/api/rer-importer/grafana/messages` | Feed group keys |
| Group list | `/api/rer-importer/groups` | Messenger account groups are left out |
| Unread counter | `/api/rer-importer/unread-counters` | Messenger messages are not counted |

Duty pages read `get-inbox`, so they stop showing messenger messages too.

Reports built on the inbox query lose messenger messages as well, because they
share `build_filtered_inbox_query`.

Unchanged on purpose:

- **Lookups by id:** `messages-by-id`, `messages-by-id-with-metadata`,
  `messages-by-uuid`, `inbox-item-context`, comments, bookmarks and importants
  still resolve messenger messages, so existing links and intelligence reports
  keep working.
- **`freq-edit-unit-name`:** a write, not a feed.
- **`/api/rer-importer/senders`:** a global sender list that is not scoped by
  group.
- **Areas outside RER routes:** `/api/sigint/freqs*`, networks and battle line.
- **Reports with their own group lookup:** for example the mouse and tag
  reports.

## Planned

### Filtering and search

Optional fields on the same request bodies, starting with `messages/list`.
`sigint_search.id` equals `sigint_chat_message.id`, so text search joins the
timeline directly and the message cursor stays the same.

### Avatars

`avatar_url` on accounts, chats and members, and a route that serves
`messenger_avatar` content behind a group check. No such route exists yet.

### Contacts

`POST /contacts/list` for the contacts of one account.

### Jump to message

An `around_message` request that opens a chat at a message, for search results.

# Messengers viewer API

Draft specification of the API that the Echo web UI uses to browse ingested
messenger data: accounts, their contacts, chats, chat members, messages and
attachments. The
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
| `POST /accounts/update` | Implemented | `MessengersAccountUpdateReq` | `null` |
| `POST /chats/list` | Implemented | `MessengersChatsListReq` | `MessengersChatsListRsp` |
| `POST /chats/members/list` | Implemented | `MessengersChatMembersListReq` | `MessengersChatMembersListRsp` |
| `POST /contacts/list` | Implemented | `MessengersContactsListReq` | `MessengersContactsListRsp` |
| `POST /messages/list` | Implemented | `MessengersMessagesListReq` | `MessengersMessagesListRsp` |
| `POST /attachments/list` | Implemented | `MessengersAttachmentsListReq` | `MessengersAttachmentsListRsp` |

Every route is a read except `accounts/update`, the only write, which changes
only fields owned by Echo users; collected data stays read-only. Requests use `POST` with a JSON body, like
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
- Chats, members, contacts, messages and attachments are only reachable through
  a parent resolved within the caller's scope.
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
| Pagination | Cursor on `messages/list` and `attachments/list`, page number on `contacts/list`. The other lists return every item |
| Deleted rows | Soft-deleted accounts, chats, contacts and messages are left out of lists, and a deleted account or chat is a `404`. Deleted chat members stay in `chats/members/list` with `deleted: true` |

A disabled ingest datasource only stops ingest; data already stored stays
readable.

Provider sub-objects follow the
[ingest rules](MESSENGER_INGEST.md#messenger-types-and-provider-sub-objects):
`telegram` is `null` when the id is unknown or the account is not a Telegram
account.

### Errors

| Status | Meaning | Body |
|---|---|---|
| `400` | Invalid uuid, an invalid `cursor`, `limit`, `direction` or combination of them on `messages/list` or `attachments/list`, or an invalid `page` or `limit` on `contacts/list` | Plain-text message |
| `401` | Not authenticated | `Unauthenticated` |
| `403` | Missing `CyberMessengers`, or missing `Rer` / `CyberViewerRestricted` | `Forbidden` |
| `404` | Account or chat is unknown, deleted, outside the caller's groups, or the chat is not under that account. Also an `around_message_id` that is not a visible message of the chat | `Not found` |

The `404` cases are indistinguishable, so the API never confirms that an id
exists outside the caller's scope.

## Accounts

### `POST /accounts/list`

Every visible account, ordered by `display_name`, then `id`. The web UI groups
accounts by `messenger_type`, so there is no separate messenger types endpoint.
`created_at` and `last_sync` are the values the collector sent
(`external_created_at`, `external_last_sync_at`), as in ingest.

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
  first_name: string | null
  last_name: string | null
  phone: string | null
  status: string | null                 // collector session status
  status_error: string | null
  status_changed_at: number | null      // epoch ms
  is_active: boolean | null
  is_paused: boolean | null
  created_at: number | null             // when the collector added the account
  last_sync: number | null              // collector's last successful sync
  notes: string | null                  // from the collector
  internal_notes: string | null         // written by Echo users
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
      "first_name": "Ivan",
      "last_name": null,
      "phone": "+380501112233",
      "status": "active",
      "status_error": null,
      "status_changed_at": 1760428800000,
      "is_active": true,
      "is_paused": false,
      "created_at": 1759000000000,
      "last_sync": 1760430000000,
      "notes": null,
      "internal_notes": "Перевірити зв'язок з чатом 9001",
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

### `POST /accounts/update`

Updates the fields of an account that Echo users own. Fields sent by collectors
cannot be changed here.

```ts
type MessengersAccountUpdateReq = {
  account_id: string
  internal_notes: string | null
}
```

The request is full state, like ingest: every editable field is replaced, and an
omitted or `null` field is cleared. The response body is `null`. The same access
rules apply as for reading: any login that can see the account can update it.

`internal_notes` is separate from `notes`: ingest replaces `notes` on every
sync, and never reads or changes `internal_notes`.

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

Every member of one chat, ordered by `external_id`, including deleted members
with `deleted: true`, because old messages still reference them. A very large
group is returned in one response; this is a known limit of the unpaginated
list.

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
  deleted: boolean
  telegram: { user_id: string } | null
}
```

## Contacts

### `POST /contacts/list`

One page of the live contacts of an account, ordered by `id`. Contacts
come from the account's address book and are separate from chat members: the
same person can be both, with different details. Messages do not reference
contacts, so unlike chat members, deleted contacts are left out.

```ts
type MessengersContactsListReq = {
  account_id: string
  page: number | null                   // from 1, default 1
  limit: number | null                  // default 50, at most 100
}

type MessengersContactsListRsp = {
  items: MessengersContactItem[]
  total: number                         // live contacts of the account
  page: number
  page_size: number                     // the limit applied
}

type MessengersContactItem = {
  id: string                            // Echo contact uuid
  messenger_type: string
  external_id: string
  username: string | null
  first_name: string | null             // as saved in the account's address book
  last_name: string | null
  phone: string | null
  is_mutual: boolean | null
  is_close_friend: boolean | null
  created_at: number                    // epoch ms, when Echo first stored it
  telegram: { user_id: string } | null
}
```

- A page past the end is empty, with the correct `total`.
- Pages are offsets, so a sync between two requests can shift rows, and a
  contact can repeat or be skipped.
- `created_at` is not when the contact joined the address book, which collectors
  do not send. A contact restored after deletion keeps its original value.

## Messages

### `POST /messages/list`

One page of a chat's messages, for infinite scroll in both directions. Each page
is newest first.

```ts
type MessengersMessagesListReq = {
  account_id: string
  chat_id: string
  cursor: string | null                 // from a previous response
  limit: number | null                  // default 50, at most 100
  direction: "Older" | "Newer" | "Oldest" | null   // default "Older"
  around_message_id: string | null      // Echo message uuid
}

type MessengersMessagesListRsp = {
  items: MessengersMessageItem[]
  older_cursor: string | null           // null when no older messages remain
  newer_cursor: string | null           // null only in an empty chat
}

type MessengersMessageItem = {
  id: string                            // Echo message uuid
  external_id: string
  sent_at: number                       // epoch ms
  text: string
  is_outgoing: boolean | null
  has_media: boolean | null
  sender_chat_member_id: string | null  // null for channel posts / unknown
  attachments: MessengersAttachment[]
  telegram: { message_id: string } | null
}

type MessengersAttachment = {
  media: MessageMediaInfo               // the attachment type of the inbox
  external_id: string
  created_at: number | null             // when the collector recorded the media
  telegram: { file_id: string, media_type: string | null } | null
}
```

Modes:

| Request | Returns |
|---|---|
| No `cursor`, no `around_message_id` | The newest page |
| `direction: "Oldest"`, no `cursor` | The first page of the chat, for going to its start |
| `cursor` from `older_cursor`, `direction` `"Older"` or omitted | Messages sent before that point |
| `cursor` from `newer_cursor`, `direction: "Newer"` | The messages closest after that point |
| `around_message_id` | That message with messages on both sides: `limit / 2` newer, the rest older including the message itself |

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
      "sender_chat_member_id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c6",
      "attachments": [
        {
          "media": {
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
            "positions": []
          },
          "external_id": "5550001:0",
          "created_at": 1760431200000,
          "telegram": { "file_id": "5413920012345678901", "media_type": "photo" }
        }
      ],
      "telegram": { "message_id": "48211" }
    }
  ],
  "older_cursor": "1760431100000000_3008815",
  "newer_cursor": "1760431100000000_3008815"
}
```

Semantics:

- The timeline is `sigint_chat_message.messenger_sent_at`, then `id`. Message
  ids alone do not give send order, because backfilled history is stored out of
  order, and several messages can share a timestamp.
  `sigint_inbox_item.datetime` is not used: it can hold a time parsed from the
  message text.
- A cursor is a position in the timeline, not a reference to a message, so it
  stays valid if the message is deleted. Treat it as opaque.
- Without a `cursor`, `"Older"` and `"Newer"` have no effect.
- `"Oldest"` cannot be combined with `cursor`. Its `older_cursor` is `null`;
  continue from `newer_cursor` with `direction: "Newer"`.
- `around_message_id` cannot be combined with `cursor` or `direction`.
- An empty `Newer` page means nothing new. Both cursors in the response repeat
  the request's cursor, so it can be sent again to check for new messages.
- `older_cursor` is only known to be final on `Older`, `Oldest`, newest and
  around pages. On a `Newer` page it is the oldest item, and the next `Older` request can
  return an empty page.
- `text` is the stored message body; a message without text has `""`.
- `sender_chat_member_id` is the `id` of an item from `chats/members/list`,
  which also holds deleted members.
- Messages deleted in Echo (`signal_message.deleted`) are left out and do not
  count towards `limit`.
- Messages are visible before their attachments arrive, so `has_media: true`
  with an empty `attachments` is valid.

## Attachments

### `POST /attachments/list`

One page of the attachments of one chat, or of every chat of an account, for a
media gallery with infinite scroll in both directions. Each page is newest
first. Without `chat_id` the page spans every live chat of the account.

```ts
type MessengersAttachmentsListReq = {
  account_id: string
  chat_id: string | null                // null: every chat of the account
  cursor: string | null                 // from a previous response
  limit: number | null                  // default 50, at most 100
  direction: "Older" | "Newer" | "Oldest" | null   // default "Older"
  telegram_media_type: string | null    // null or "": every type
}

type MessengersAttachmentsListRsp = {
  items: MessengersAttachmentItem[]
  older_cursor: string | null           // null when no older attachments remain
  newer_cursor: string | null           // null only when there are no attachments
}

type MessengersAttachmentItem = {
  chat_id: string                       // Echo chat uuid
  message_id: string                    // Echo message uuid
  sent_at: number                       // epoch ms, when the message was sent
  sender_chat_member_id: string | null
  attachment: MessengersAttachment      // as in messages/list
}
```

Modes:

| Request | Returns |
|---|---|
| No `cursor` | The newest page |
| `direction: "Oldest"`, no `cursor` | The first page, for going to the start |
| `cursor` from `older_cursor`, `direction` `"Older"` or omitted | Attachments of messages sent before that point |
| `cursor` from `newer_cursor`, `direction: "Newer"` | The attachments closest after that point |

Example response:

```json
{
  "items": [
    {
      "chat_id": "0199e3a5-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
      "message_id": "0199e3a8-5e6f-7a0b-9c1d-2e3f4a5b6c7d",
      "sent_at": 1760431100000,
      "sender_chat_member_id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c6",
      "attachment": {
        "media": {
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
          "positions": []
        },
        "external_id": "5550001:0",
        "created_at": 1760431200000,
        "telegram": { "file_id": "5413920012345678901", "media_type": "photo" }
      }
    }
  ],
  "older_cursor": "1760431100000000_3008815_0199e3a8-4d5e-7f60-8172-839405162738",
  "newer_cursor": "1760431100000000_3008815_0199e3a8-4d5e-7f60-8172-839405162738"
}
```

Semantics:

- The timeline is the message timeline of `messages/list`
  (`messenger_sent_at`, then message id), then the media id for attachments of
  the same message. In the account scope, the chats are merged into one
  timeline.
- Cursors follow the `messages/list` rules: they are opaque positions that stay
  valid if an attachment is deleted, `"Oldest"` cannot be combined with
  `cursor`, an empty `Newer` page repeats the request's cursor, and
  `older_cursor` is only known to be final on `Older`, `Oldest` and newest
  pages.
- A cursor does not record the scope or the filter. Keep `account_id`,
  `chat_id` and `telegram_media_type` the same while paging; an attachment
  cursor is not a `messages/list` cursor.
- `telegram_media_type` keeps attachments whose `telegram.media_type` equals
  it, so attachments without a Telegram media type are left out.
- `message_id` works as `around_message_id` in `messages/list`, to open the
  message in its chat.
- Attachments of messages deleted in Echo are left out, and in the account
  scope also those of deleted chats. They do not count towards `limit`.
- `messenger_media_meta` keeps a copy of the message's account, chat and send
  time, which never change after ingest. Its chat and account timeline indexes
  serve every page, and their media type variants serve filtered pages, so a
  page reads about `limit` rows, however large the chat or account and however
  rare the type.

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

`avatar_url` on accounts, chats, members and contacts, and a route that serves
`messenger_avatar` content behind a group check. No such route exists yet.

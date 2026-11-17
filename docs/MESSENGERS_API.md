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
| `POST /chats/read-state/get` | Implemented | `MessengersChatReadStateGetReq` | `MessengersChatReadState` |
| `POST /chats/read-state/update` | Implemented | `MessengersChatReadStateUpdateReq` | `MessengersChatReadState` |
| `POST /chats/mark-all-read` | Implemented | `MessengersChatsMarkAllReadReq` | `null` |
| `POST /chats/members/list` | Implemented | `MessengersChatMembersListReq` | `MessengersChatMembersListRsp` |
| `POST /contacts/list` | Implemented | `MessengersContactsListReq` | `MessengersContactsListRsp` |
| `GET /avatars/{avatar_id}` | Implemented | none | the image or video |
| `POST /messages/list` | Implemented | `MessengersMessagesListReq` | `MessengersMessagesListRsp` |
| `POST /attachments/list` | Implemented | `MessengersAttachmentsListReq` | `MessengersAttachmentsListRsp` |
| `POST /attachments/count` | Implemented | `MessengersAttachmentsCountsReq` | `MessengersAttachmentsCountsRsp` |

Every route is a read except `accounts/update`, which changes only fields
owned by Echo users, and the [read state](#read-state) routes, which change only
the caller's own read state; collected data stays read-only. Requests use `POST` with a JSON body, like
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
| `400` | Invalid uuid, an invalid `cursor`, `limit`, `direction` or combination of them on `messages/list` or `attachments/list`, an invalid `page` or `limit` on `contacts/list`, an invalid `around_sent_at` or combination with it on `messages/list`, or invalid bounds on `chats/read-state/update` | Plain-text message |
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
  external_url: string | null           // absolute http(s) URL of the account's page in the collector
  avatar_id: string | null              // current avatar, see Avatars
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
      "external_url": "https://example.com/accounts/17",
      "avatar_id": "0199e3a3-2f4a-7b5c-8d6e-9f0a1b2c3d4e",
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
`last_message_date` descending with nulls last, then `id` descending. Each
item carries the caller's [read state](#read-state) of the chat.

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
  is_bot: boolean | null                // a dialog with a bot; null until the collector says
  avatar_id: string | null              // current avatar, see Avatars
  telegram: { chat_id: string } | null
  oldest_read_at: number | null         // epoch ms, the caller's read span; null until read
  newest_read_at: number | null         // epoch ms
  unread_count: number                  // messages outside the read span
  total_count: number                   // every message of the chat
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
  avatar_id: string | null              // current avatar, see Avatars
  telegram: { user_id: string } | null
}
```

## Read state

Each login has its own read state per chat: the span of the chat timeline it
has read, `[oldest_read_at, newest_read_at]`, bounds included. Messages sent
outside the span are unread; a chat the login has never read has no span, and
every message in it is unread. The span is kept per login, so other logins
viewing the same chat are not affected.

The timeline is `messenger_sent_at`, as in [`messages/list`](#post-messageslist),
not message ids, because backfilled history is stored out of send order. A
consequence: history backfilled before `oldest_read_at` after the chat was read
counts as unread.

`chats/list` returns the same `oldest_read_at`, `newest_read_at` and
`unread_count` for every chat, so the list needs no extra request, plus the
chat's `total_count`.

### `POST /chats/read-state/get`

The caller's read state of one chat.

```ts
type MessengersChatReadStateGetReq = {
  account_id: string
  chat_id: string
}

type MessengersChatReadState = {
  oldest_read_at: number | null         // epoch ms; null until the chat is read
  newest_read_at: number | null         // epoch ms
  unread_count: number
}
```

### `POST /chats/read-state/update`

Marks the messages sent within `[oldest_read_at, newest_read_at]` as read,
typically the `sent_at` of the oldest and newest message the client has shown.
The response is the merged state.

```ts
type MessengersChatReadStateUpdateReq = {
  account_id: string
  chat_id: string
  oldest_read_at: number                // epoch ms, included
  newest_read_at: number                // epoch ms, included
}
```

- The stored span only widens: it becomes the earliest of the stored and sent
  `oldest_read_at` and the latest of the two `newest_read_at`. A stale tab or a
  late request cannot make read messages unread again, and there is no way to
  mark messages unread.
- Send times have microseconds while the API has milliseconds, so each bound
  covers its whole millisecond: a message whose `sent_at` equals a bound is read.
- `oldest_read_at` after `newest_read_at`, or a timestamp out of range, is a
  `400`.

### `POST /chats/mark-all-read`

Marks every live chat of one account as read for the caller: each chat's span
is widened to cover its first to its newest message. Chats without messages are
left without a read state, which already counts no unread messages. The
response body is `null`; read the counts again with `chats/list`.

```ts
type MessengersChatsMarkAllReadReq = {
  account_id: string
}
```

- All chats are updated in one transaction.
- A message ingested while the request runs can stay unread, which is correct:
  the caller has not seen it.

### Opening a chat at its unread messages

The read bounds are milliseconds that cover their whole millisecond, so the
client compares them with `sent_at` directly: a message is unread when
`sent_at > newest_read_at` or `sent_at < oldest_read_at`.

| Chat in `chats/list` | First `messages/list` request |
|---|---|
| `unread_count` is `0` | The newest page: no `cursor` |
| Read before, with unread messages | `around_sent_at: newest_read_at`: the first unread messages above the last read ones |
| Never read (`newest_read_at` is `null`) | The newest page, or `direction: "Oldest"` to start from the first message |

The unread divider goes above the oldest item with `sent_at > newest_read_at`.
The client keeps the `newest_read_at` it opened the chat with for as long as the
chat stays open, because its own `read-state/update` calls move the stored
bound while the user scrolls. The paging cursors of the page continue in both
directions as usual.

While the user scrolls, the client sends `read-state/update` with the `sent_at`
of the oldest and newest messages it has shown, debounced; late or repeated
requests are harmless because the span only widens.

Unread messages before `oldest_read_at`, from backfilled history, are above the
read span. `around_sent_at: oldest_read_at - 1` opens the chat at the newest
of them.

The read state records how far the user has read, not where they left the
chat: after scrolling back into older read messages, the chat reopens at the
unread divider, not at that place. Keeping the last viewed place would be a
separate, nullable column of `messenger_chat_read_state`, set by the client
and opened the same way with `around_sent_at`; the routes and the paging would
not change.

Semantics of the counts:

- `unread_count` and `total_count` count every stored message of the chat, including messages
  deleted in Echo (`signal_message.deleted`), which `messages/list` leaves out.
  Messenger ingest does not delete messages, so the two agree in practice, and
  skipping the check keeps the counts cheap.
- Each bound is counted as its own range on the chat timeline index
  (`messenger_chat_id`, `messenger_sent_at`), so a fully read chat costs two
  index lookups, and the cost grows with the number of unread messages. A chat
  that was never read is counted in full.

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
  limit: number | null                  // default 100, at most 250
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
  updated_at: number                    // epoch ms, when Echo last changed it
  avatar_id: string | null              // current avatar, see Avatars
  telegram: { user_id: string } | null
}
```

- A page past the end is empty, with the correct `total`.
- Pages are offsets, so a sync between two requests can shift rows, and a
  contact can repeat or be skipped.
- `created_at` is not when the contact joined the address book, which collectors
  do not send. A contact restored after deletion keeps its original value.

## Avatars

Accounts, chats, chat members and contacts carry `avatar_id`: the Echo uuid of
their current avatar, or `null` when the owner has none or it was removed. The
client loads it from `/api/messengers/avatars/{avatar_id}`. The avatar id
changes with the avatar, so one id always names the same image or video.

### `GET /avatars/{avatar_id}`

The content of the avatar, with the `Content-Type` it was stored with (an
image or a video; animated avatars are videos). Visible to the logins that can
see the account that owns it, directly or through its chat, member or contact;
an unknown avatar or one of an account outside the caller's groups is a `404`.

- Not a JSON route and not ranged: the body is the whole file, at most 20 MiB.
- `Cache-Control: private, no-store`, as for messenger media: the browser
  keeps no copy.
- Avatars that are not the owner's current one (its history) are served too,
  but nothing links to them yet.
- Served with the sandboxing headers of the media route, since the file comes
  from the messenger.

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
  around_sent_at: number | null         // epoch ms
  query: string | null                  // search in the chat, analysis syntax
  search_mode: "Fuzzy" | "Exact" | "Substring" | null  // default "Fuzzy"
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
  headline: string | null               // with `query` only
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
| `query` | Combines with every mode above: the same pages over only the messages that match |
| `around_sent_at` | The page split at the end of that millisecond: `limit / 2` messages sent after it, the rest sent at or before it. With a chat's `newest_read_at`, the first unread messages and the last read ones; see [Opening a chat at its unread messages](#opening-a-chat-at-its-unread-messages) |

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
- `around_message_id` and `around_sent_at` cannot be combined with each other,
  with `cursor` or with `direction`. A timestamp out of range is a `400`.
- `around_sent_at` needs no message at that time; it works for any date, for
  example to jump to a day in the chat.
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

Search (`query`):

- The analysis search: the same syntax (`-term`, `or`, `"quoted"` literals)
  and `search_mode` over the message text analysis indexes
  (`sigint_search`, `sigint_inbox_item`), without attachments.
  - `Fuzzy`: words with Russian stemming and prefixes (`танк` finds `танки`).
  - `Exact`: whole words, case-insensitive (`танк` does not find `танки`).
  - `Substring`: anywhere in a word, case-insensitive.
- Unlike analysis, a frequency or message uid in `query` is text to match.
- Leading and trailing whitespace is ignored. A blank `query` is the same as
  none.
- Cursors are the same timeline positions. Send the same `query` with every
  page of a search. To open a hit in the full chat, request
  `around_message_id` without `query`. With `query`, an `around_message_id`
  that does not match is a `404`.
- `headline` is the whole `text` with every match marked, the same as inbox
  search highlighting: `ts_headline` with `HighlightAll=true` for `Fuzzy`,
  the literal patterns for `Exact` and `Substring`. Each match is between
  U+E000 and U+E001 (`MESSENGERS_HEADLINE_START` / `_STOP`). It is plain text
  from the message: escape it, and only then turn the markers into
  highlighting. It is `null` without `query`.

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
  telegram_media_types: string[] | null // null or []: every type
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
  `chat_id` and `telegram_media_types` the same while paging; an attachment
  cursor is not a `messages/list` cursor.
- `telegram_media_types` keeps attachments whose `telegram.media_type` is one
  of the values, so attachments without a Telegram media type are left out.
- `message_id` works as `around_message_id` in `messages/list`, to open the
  message in its chat.
- Attachments of messages deleted in Echo are left out, and in the account
  scope also those of deleted chats. They do not count towards `limit`.
- `messenger_media_meta` keeps a copy of the message's account, chat and send
  time, which never change after ingest. Its chat and account timeline indexes
  serve every page, and their media type variants serve pages filtered by one
  type, so a page reads about `limit` rows, however large the chat or account
  and however rare the type. A filter with several types cannot read the type
  indexes in timeline order, so it reads every attachment of those types in
  the scope, or walks the scope's timeline past the other types.

### `POST /attachments/count`

The number of attachments of one chat, or of every chat of an account, for
each Telegram media type, for the labels of the tabs of a media gallery
("Photos (12)"). It counts the attachments `attachments/list` pages through, so
the numbers match what scrolling shows.

```ts
type MessengersAttachmentsCountsReq = {
  account_id: string
  chat_id: string | null                // null: every chat of the account
}

type MessengersAttachmentsCountsRsp = {
  items: MessengersAttachmentTypeCount[]   // by telegram_media_type, null last
}

type MessengersAttachmentTypeCount = {
  telegram_media_type: string | null    // null: media without a Telegram type
  count: number
}
```

Semantics:

- A type with no attachments has no item. The client adds the types of a tab
  up and shows 0 for a tab none of them is in.
- Attachments of messages deleted in Echo are left out, and in the account
  scope also those of deleted chats, as in `attachments/list`.
- Access is checked as in `attachments/list`: an account or chat the login
  cannot see is `404`.
- The route reads every attachment of the scope, not a page: about 30 ms for
  3,400 attachments, growing with their number.

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

More optional fields on the same request bodies. `messages/list` already has
`query`, which joins `sigint_search` (`sigint_search.id` equals
`sigint_chat_message.id`) to the timeline.

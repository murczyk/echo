# Messenger ingest API

Draft specification of the batched API that external collectors use to push
messenger data (Telegram today, Max and others later) into Echo. The document
tracks both implemented and planned endpoints and is updated as the design
evolves. Sections marked **Planned** are proposals, not contracts.

Base path: `/api/messenger-ingest/v1`

Routes live in [`wdintel-rs/src/messenger_ingest/mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs),
implementations in the per-entity modules next to it. DTO names below are the
backend type names; the API is for external collectors only and has no
generated front-end bindings.

## Endpoint index

| Route | Status | Route / implementation | Request | Response |
|---|---|---|---|---|
| `POST /accounts/sync` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `accounts_sync` / [`accounts.rs`](../wdintel-rs/src/messenger_ingest/accounts.rs) `sync_accounts` | `MessengerIngestAccountsSyncReq` | `MessengerIngestAccountsSyncRsp` |
| `POST /chats/sync` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `chats_sync` / [`chats.rs`](../wdintel-rs/src/messenger_ingest/chats.rs) `sync_chats` | `MessengerIngestChatsSyncReq` | `MessengerIngestChatsSyncRsp` |
| `POST /chats/members/sync` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `chat_members_sync` / [`members.rs`](../wdintel-rs/src/messenger_ingest/members.rs) `sync_chat_members` | `MessengerIngestChatMembersSyncReq` | `MessengerIngestChatMembersSyncRsp` |
| `POST /contacts/sync` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `contacts_sync` / [`contacts.rs`](../wdintel-rs/src/messenger_ingest/contacts.rs) `sync_contacts` | `MessengerIngestContactsSyncReq` | `MessengerIngestContactsSyncRsp` |
| `POST /messages/submit` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `messages_submit` / [`messages.rs`](../wdintel-rs/src/messenger_ingest/messages.rs) `submit_messages` | `MessengerIngestMessagesSubmitReq` | `MessengerIngestMessagesSubmitRsp` |
| `POST /messages/attachments/submit` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `attachments_submit` / [`attachments.rs`](../wdintel-rs/src/messenger_ingest/attachments.rs) `submit_attachments` | `MessengerIngestAttachmentsSubmitReq` | `MessengerIngestAttachmentsSubmitRsp` |
| `POST /accounts/avatar/submit` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `account_avatar_submit` / [`avatars.rs`](../wdintel-rs/src/messenger_ingest/avatars.rs) `submit_account_avatar` | `MessengerIngestAccountAvatarSubmitReq` | `MessengerIngestAvatarSubmitRsp` |
| `POST /chats/avatar/submit` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `chat_avatar_submit` / [`avatars.rs`](../wdintel-rs/src/messenger_ingest/avatars.rs) `submit_chat_avatar` | `MessengerIngestChatAvatarSubmitReq` | `MessengerIngestAvatarSubmitRsp` |
| `POST /chats/members/avatar/submit` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `chat_member_avatar_submit` / [`avatars.rs`](../wdintel-rs/src/messenger_ingest/avatars.rs) `submit_chat_member_avatar` | `MessengerIngestChatMemberAvatarSubmitReq` | `MessengerIngestAvatarSubmitRsp` |
| `POST /contacts/avatar/submit` | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `contact_avatar_submit` / [`avatars.rs`](../wdintel-rs/src/messenger_ingest/avatars.rs) `submit_contact_avatar` | `MessengerIngestContactAvatarSubmitReq` | `MessengerIngestAvatarSubmitRsp` |
| `POST /uploads`, `HEAD` / `PATCH` / `DELETE /uploads/{id}` (TUS) | Implemented | [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `uploads_base`, `uploads_file` / [`uploads.rs`](../wdintel-rs/src/messenger_ingest/uploads.rs) `handle_upload` | TUS protocol | TUS protocol |

Shared building blocks:

| Concern | Source |
|---|---|
| Role check and caller scope | [`access.rs`](../wdintel-rs/src/messenger_ingest/access.rs) `ensure_messenger_ingest_access`, gated per route in [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `enabled_scope` |
| Per-login ingest datasource | [`datasource.rs`](../wdintel-rs/src/messenger_ingest/datasource.rs) `ensure_ingest_datasource` |
| Reference types, id parsing, provider checks | [`refs.rs`](../wdintel-rs/src/messenger_ingest/refs.rs) |
| Request / response DTOs | [`types.rs`](../wdintel-rs/src/messenger_ingest/types.rs) |

## Access

- Every request is made by an authenticated Echo login that has both the `Api`
  and `MessengerIngest` roles.
- Each such login owns exactly one ingest datasource (kind
  `echo_messenger_ingest`), created on the first ingest request. A login that
  already owns a datasource of another kind is rejected with `403`. All data
  written by the login lives in that datasource; one login can never read or
  modify another login's accounts, chats or messages.
- Requests are rejected with `403` when the datasource is disabled.
- Accounts, chats, members, contacts, messages, avatars and uploads of one login are
  never visible to another; child entities are only reachable through a
  parent resolved within the caller's scope.
- `Api` logins are subject to the shared API request quota
  (see [api-rate-limiting.md](api-rate-limiting.md)); `429` responses carry
  `Retry-After`.

### Authentication

Ingest requests use the regular Echo session. The collector logs in once and
sends the session cookie from the response with every request; `Api` logins
skip the interactive TOTP step.

```http
POST /api/user/login HTTP/1.1
Content-Type: application/json

{"user": "collector-01", "password": "…"}
```

```http
HTTP/1.1 200 OK
Set-Cookie: id=…; HttpOnly; Secure; Path=/
Content-Type: application/json

"Authenticated"
```

A request without a valid session is a `401`; the collector logs in again.

## Collector flow

The order in which a collector pushes a new account, its chats and history.
Each step reuses the Echo ids returned by the previous ones.

| Step | Request | Uses | Returns |
|---|---|---|---|
| 1 | `POST /accounts/sync` | — | account `id` |
| 2 | `POST /chats/sync` | account ref | chat `id`s |
| 3 | `POST /chats/members/sync` | account and chat refs | member `id`s, including the account's own member row |
| 4 | `POST /messages/submit` | account and chat refs, member refs as `sender` | message `id`s |
| 5 | TUS `POST` / `PATCH /uploads` | — | `upload_url` (`Location`) |
| 6 | `POST /messages/attachments/submit` | account and chat refs, message `external_id`, `upload_url`s | media `id`s |
| any | `POST /contacts/sync` | account ref | contact `id`s |
| any | TUS `POST` / `PATCH /uploads`, then `POST /{accounts,chats,chats/members,contacts}/avatar/submit` | account ref and the owner's refs from steps 1–3 and contacts sync, `upload_url`s | avatar `id`s |

Retries:

- Steps 4 and 6 and avatar submits are idempotent: resubmitting returns `existing` with the
  original ids.
- Steps 1–3 and contacts can be resent as-is: a `created` item whose
  `external_id` is already live is applied as a full update and returned with
  its existing Echo id, so a collector that lost a response resends the same
  request to learn the ids.
- Uploads expire 8 h after completion, so step 6 and the avatar submit must
  follow their upload within that window.

## Conventions

| Topic | Rule |
|---|---|
| Encoding | JSON request and response bodies, `snake_case` field names |
| Echo ids | UUIDv7 strings minted by Echo (`id`) |
| Collector ids | `external_id`: opaque string chosen by the collector, unique per parent scope (account per datasource, chat per account, member per chat, contact per account, message per chat, attachment per message, avatar per owner) |
| Messenger ids | 64-bit protocol ids travel as **decimal strings** (`"-1001234567890"`) inside provider sub-objects. Ids such as Telegram `file_id` exceed 2^53, which JSON numbers cannot carry exactly in JavaScript clients |
| Timestamps | Integer milliseconds since the Unix epoch, UTC |
| Optional fields | `T \| null`; omitted and `null` are equivalent |
| Collections | Always present, may be empty; never `null` |
| Full state | Item bodies are full state: an omitted optional field clears the stored value |
| Batch size | Sync endpoints: at most 200 items per request (sum of all collections). `messages/submit`: at most 100 messages. `messages/attachments/submit`: at most 20 attachments. avatar submits: one avatar per request |
| Atomicity | One request is all-or-nothing: any invalid item rejects the whole request and nothing is stored |
| Foreign ids | An id that does not exist in the caller's scope, or whose `external_id` / messenger ids disagree with the stored row, is reported as `404`, so the API never confirms ids owned by someone else |

Sync endpoints neither accept nor return avatars. An owner's current avatar
is attached only by the avatar submit endpoints (see [Avatars](#avatars)), and
a sync never changes it.

### Messenger types and provider sub-objects

Every account has a `messenger_type`:

| `messenger_type` | Provider sub-object |
|---|---|
| `"Telegram"` | `telegram` |
| `"Max"` | none yet |

Generic fields (`external_id`, names, timestamps, ...) apply to every
messenger. Messenger-specific protocol ids live in an optional sub-object named
after the messenger (`telegram: { ... }`). Rules:

- A sub-object is always optional; omit it (or send `null`) when the id is
  unknown.
- A sub-object is rejected when it does not match the account's
  `messenger_type` (for example `telegram` on a `Max` account).
- Once stored, a messenger id cannot change for the same item; sending a
  different value is an error.
- Chats, members, contacts, messages, attachments and avatars inherit
  `messenger_type` from their account.

### Errors

| Status | Meaning | Body |
|---|---|---|
| `400` | Validation or business-rule error | Plain-text message |
| `401` | Not authenticated | `Unauthenticated` |
| `403` | Missing roles, foreign datasource kind, or datasource disabled | `Forbidden` |
| `404` | Unknown or foreign Echo id / reference | `Not found` |
| `409` | `messages/submit`, `messages/attachments/submit` or an avatar submit lost a race with a concurrent request for the same items; nothing was stored, retry the request | JSON `message`, `details.code` = `messenger_ingest_concurrent_submit`, `messenger_ingest_concurrent_attach` or `messenger_ingest_concurrent_avatar`, `details.external_id` |
| `429` | API quota exhausted | JSON `error`, `Retry-After` header |

Examples of `400` bodies:

```text
too many items: 250, max 200
unknown messenger_type: Viber
telegram fields are not allowed for Max
invalid echo uuid: 42
invalid telegram chat_id: abc
telegram chat_id does not match chat 9001
telegram chat_id -1001234567890 already belongs to another chat
telegram message_id 48211 already belongs to another message
telegram user_id 7012345678 already belongs to another account
duplicate chat member external_id in created: 6011122233
messenger_type Max does not match account 17
telegram user_id 6011122233 already belongs to another chat member
telegram user_id 5123456789 already belongs to another contact
upload not found or incomplete: /api/messenger-ingest/v1/uploads/0199e3a7-0c1d-7e2f-8a3b-4c5d6e7f8091
duplicate attachment: 5550001:0
telegram fields do not match attachment 5550001:0
avatar too large: 31457280 bytes, max 20971520
avatar content type not allowed: text/plain
telegram fields do not match avatar photo-1
telegram photo_id 5413920012345678901 already belongs to another avatar
```

### Shared reference types

References identify a parent entity in child endpoints. The collector learns
the Echo `id` from the parent's sync response and sends it back together with
its own `external_id`; both must match the stored row. Defined in
[`refs.rs`](../wdintel-rs/src/messenger_ingest/refs.rs).

```ts
type MessengerIngestAccountRef = {
  id: string                          // Echo account uuid
  external_id: string
  messenger_type: string
  telegram: MessengerIngestTelegramAccountId | null
}

type MessengerIngestChatRef = {
  id: string                          // Echo chat uuid
  external_id: string
  telegram: MessengerIngestTelegramChatId | null
}

type MessengerIngestChatMemberRef = {
  id: string                          // Echo chat member uuid
  external_id: string
  telegram: MessengerIngestTelegramAccountId | null
}

type MessengerIngestContactRef = {
  id: string                          // Echo contact uuid
  external_id: string
  telegram: MessengerIngestTelegramAccountId | null
}

type MessengerIngestTelegramAccountId = { user_id: string }   // decimal int64
type MessengerIngestTelegramChatId    = { chat_id: string }   // decimal int64
```

```json
{
  "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
  "external_id": "17",
  "messenger_type": "Telegram",
  "telegram": { "user_id": "7012345678" }
}
```

## Accounts

### `POST /accounts/sync`

Route: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `accounts_sync`; implementation:
[`accounts.rs`](../wdintel-rs/src/messenger_ingest/accounts.rs) `sync_accounts`.

Delta sync of the messenger accounts the collector operates. Each account
appears in Echo as its own messenger group within the ingest datasource; the
group name follows `display_name`.

Request:

```ts
type MessengerIngestAccountsSyncReq = {
  created: MessengerIngestAccountInput[]
  updated: { [echo_id: string]: MessengerIngestAccountInput }
  deleted: string[]                     // Echo account uuids
}

type MessengerIngestAccountInput = {
  messenger_type: string                // "Telegram" | "Max"
  external_id: string
  display_name: string
  phone: string | null
  username: string | null
  first_name: string | null
  last_name: string | null
  status: string | null                 // collector session status
  status_error: string | null
  status_changed_at: number | null      // epoch ms
  is_active: boolean | null
  is_paused: boolean | null
  notes: string | null
  created_at: number | null             // when the collector added the account
  last_sync: number | null              // collector's last successful sync
  telegram: MessengerIngestTelegramAccountId | null
}
```

Response:

```ts
type MessengerIngestAccountsSyncRsp = {
  created: { [echo_id: string]: MessengerIngestAccountItem }
  updated: { [echo_id: string]: MessengerIngestAccountItem }
  deleted: string[]                     // uuids actually deleted by this call
}

// MessengerIngestAccountInput plus the Echo id
type MessengerIngestAccountItem = MessengerIngestAccountInput & {
  id: string                            // Echo account uuid
}
```

Example request — one Telegram account created, one Max account updated, one
account deleted:

```json
{
  "created": [
    {
      "messenger_type": "Telegram",
      "external_id": "17",
      "display_name": "Оператор 17",
      "phone": "+380501112233",
      "username": "op17",
      "first_name": "Ivan",
      "last_name": null,
      "status": "active",
      "status_error": null,
      "status_changed_at": 1760428800000,
      "is_active": true,
      "is_paused": false,
      "notes": null,
      "created_at": 1759000000000,
      "last_sync": 1760430000000,
      "telegram": { "user_id": "7012345678" }
    }
  ],
  "updated": {
    "0199e3a1-0b2c-7a11-8c3d-112233445566": {
      "messenger_type": "Max",
      "external_id": "18",
      "display_name": "Оператор 18",
      "phone": null,
      "username": "op18",
      "first_name": null,
      "last_name": null,
      "status": "error",
      "status_error": "session expired",
      "status_changed_at": 1760431000000,
      "is_active": false,
      "is_paused": true,
      "notes": "re-login required",
      "created_at": 1759100000000,
      "last_sync": 1760420000000,
      "telegram": null
    }
  },
  "deleted": ["0199e39f-77aa-7b00-a1b2-c3d4e5f60718"]
}
```

Example response:

```json
{
  "created": {
    "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f": {
      "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
      "messenger_type": "Telegram",
      "external_id": "17",
      "display_name": "Оператор 17",
      "phone": "+380501112233",
      "username": "op17",
      "first_name": "Ivan",
      "last_name": null,
      "status": "active",
      "status_error": null,
      "status_changed_at": 1760428800000,
      "is_active": true,
      "is_paused": false,
      "notes": null,
      "created_at": 1759000000000,
      "last_sync": 1760430000000,
      "telegram": { "user_id": "7012345678" }
    }
  },
  "updated": {
    "0199e3a1-0b2c-7a11-8c3d-112233445566": {
      "id": "0199e3a1-0b2c-7a11-8c3d-112233445566",
      "messenger_type": "Max",
      "external_id": "18",
      "display_name": "Оператор 18",
      "phone": null,
      "username": "op18",
      "first_name": null,
      "last_name": null,
      "status": "error",
      "status_error": "session expired",
      "status_changed_at": 1760431000000,
      "is_active": false,
      "is_paused": true,
      "notes": "re-login required",
      "created_at": 1759100000000,
      "last_sync": 1760420000000,
      "telegram": null
    }
  },
  "deleted": ["0199e39f-77aa-7b00-a1b2-c3d4e5f60718"]
}
```

Semantics:

- `created`: Echo mints the uuid. The collector maps it back to its own record
  through `external_id` in the returned item. Creating an `external_id` that
  was previously deleted restores that account with its original uuid; its
  `messenger_type` and Telegram `user_id` must match the stored account
  (`400`), so a restore never moves an account's history to another identity.
- Creating an `external_id` that is already live applies the item as a full
  update of that account and returns it under `created` with its existing
  uuid. Its `messenger_type` and Telegram `user_id` must match the stored
  account (`400` otherwise).
- One `external_id` may appear only once in `created` (`400`).
- `updated`: keyed by Echo uuid; full-state replace. `messenger_type`,
  `external_id` and the Telegram `user_id` cannot change.
- `deleted`: soft delete of the account and its group. Unknown, foreign or
  already deleted uuids are ignored and not echoed back, so deletion is
  idempotent.
- A Telegram `user_id` may belong to only one live account per datasource.
- Processing order is `created`, then `updated`, then `deleted`.

## Chats

### `POST /chats/sync`

Route: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `chats_sync`; implementation:
[`chats.rs`](../wdintel-rs/src/messenger_ingest/chats.rs) `sync_chats`.

Delta sync of the chats (dialogs, groups, channels) visible to one account.
Same `created` / `updated` / `deleted` shape and rules as accounts sync, scoped
to the referenced account.

Request:

```ts
type MessengerIngestChatsSyncReq = {
  account: MessengerIngestAccountRef
  created: MessengerIngestChatInput[]
  updated: { [echo_id: string]: MessengerIngestChatInput }
  deleted: string[]                     // Echo chat uuids
}

type MessengerIngestChatInput = {
  external_id: string
  chat_type: string | null              // see open questions
  title: string | null
  username: string | null
  members_count: number | null
  account_member_status: string | null  // the account's membership in the chat
  last_message_date: number | null      // epoch ms
  telegram: MessengerIngestTelegramChatId | null
}
```

Response:

```ts
type MessengerIngestChatsSyncRsp = {
  created: { [echo_id: string]: MessengerIngestChatItem }
  updated: { [echo_id: string]: MessengerIngestChatItem }
  deleted: string[]                     // uuids actually deleted by this call
}

// MessengerIngestChatInput plus the Echo id and the account's messenger type
type MessengerIngestChatItem = MessengerIngestChatInput & {
  id: string                            // Echo chat uuid
  messenger_type: string                // inherited from the account
}
```

Example request — a new supergroup created, a known private chat updated, one
chat deleted:

```json
{
  "account": {
    "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
    "external_id": "17",
    "messenger_type": "Telegram",
    "telegram": { "user_id": "7012345678" }
  },
  "created": [
    {
      "external_id": "9001",
      "chat_type": "supergroup",
      "title": "Новини району",
      "username": "district_news",
      "members_count": 1532,
      "account_member_status": "member",
      "last_message_date": 1760431200000,
      "telegram": { "chat_id": "-1001234567890" }
    }
  ],
  "updated": {
    "0199e3a5-1d2e-7f30-8a41-5b6c7d8e9f00": {
      "external_id": "9002",
      "chat_type": "private",
      "title": "Petro",
      "username": null,
      "members_count": null,
      "account_member_status": null,
      "last_message_date": 1760429000000,
      "telegram": { "chat_id": "5123456789" }
    }
  },
  "deleted": ["0199e3a4-0f1e-7d2c-8b3a-495867a6b5c4"]
}
```

Example response:

```json
{
  "created": {
    "0199e3a6-2a3b-7c4d-9e5f-6a7b8c9d0e1f": {
      "id": "0199e3a6-2a3b-7c4d-9e5f-6a7b8c9d0e1f",
      "messenger_type": "Telegram",
      "external_id": "9001",
      "chat_type": "supergroup",
      "title": "Новини району",
      "username": "district_news",
      "members_count": 1532,
      "account_member_status": "member",
      "last_message_date": 1760431200000,
      "telegram": { "chat_id": "-1001234567890" }
    }
  },
  "updated": {
    "0199e3a5-1d2e-7f30-8a41-5b6c7d8e9f00": {
      "id": "0199e3a5-1d2e-7f30-8a41-5b6c7d8e9f00",
      "messenger_type": "Telegram",
      "external_id": "9002",
      "chat_type": "private",
      "title": "Petro",
      "username": null,
      "members_count": null,
      "account_member_status": null,
      "last_message_date": 1760429000000,
      "telegram": { "chat_id": "5123456789" }
    }
  },
  "deleted": ["0199e3a4-0f1e-7d2c-8b3a-495867a6b5c4"]
}
```

Semantics:

- The account reference is resolved first; a foreign or mismatching reference
  is a `404`.
- `created`: Echo mints the uuid; the collector maps it back through
  `external_id`. Creating an `external_id` that was previously deleted under
  the same account restores that chat with its original uuid; its Telegram
  `chat_id` must match the stored chat (`400`). Creating a
  live `external_id` applies the item as a full update and returns it under
  `created` with its existing uuid; its Telegram `chat_id` must match the
  stored chat (`400` otherwise). One `external_id` may appear only once in
  `created` (`400`).
- `updated`: keyed by Echo chat uuid; full-state replace. The uuid must belong
  to a live chat of the referenced account, otherwise `404`. `external_id` and
  the Telegram `chat_id` cannot change (`400`).
- `deleted`: soft delete. Unknown, foreign or already deleted uuids are
  ignored and not echoed back, so deletion is idempotent. Soft-deleted chats
  keep their messages.
- A Telegram `chat_id` may belong to only one live chat per account.
- Processing order is `created`, then `updated`, then `deleted`; the batch cap
  applies to the sum of the three collections.

## Chat members and contacts

People appear only inside relationships, as in the collector's
`chat_members` and `contacts` rows: there is no standalone user. A member is
a person in one chat; a contact is a person in one account's address book.
Each row carries the profile as seen there, so the same person may exist as
several members (one per chat) and as a contact, with different details.

### `POST /chats/members/sync`

Route: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `chat_members_sync`; implementation:
[`members.rs`](../wdintel-rs/src/messenger_ingest/members.rs) `sync_chat_members`.

Delta sync of the members of one chat. Same `created` / `updated` / `deleted`
shape and rules as chats sync, scoped to the referenced chat. Members must be
synced before the messages that reference them as `sender`; the account's
own member row is the sender of its outgoing messages.

Request:

```ts
type MessengerIngestChatMembersSyncReq = {
  account: MessengerIngestAccountRef
  chat: MessengerIngestChatRef
  created: MessengerIngestChatMemberInput[]
  updated: { [echo_id: string]: MessengerIngestChatMemberInput }
  deleted: string[]                     // Echo chat member uuids
}

type MessengerIngestChatMemberInput = {
  external_id: string                   // unique per chat
  username: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  is_bot: boolean | null
  role: string | null                   // creator, admin, member, ...
  joined_date: number | null            // epoch ms
  telegram: MessengerIngestTelegramAccountId | null   // { user_id }
}
```

Response:

```ts
type MessengerIngestChatMembersSyncRsp = {
  created: { [echo_id: string]: MessengerIngestChatMemberItem }
  updated: { [echo_id: string]: MessengerIngestChatMemberItem }
  deleted: string[]                     // uuids actually deleted by this call
}

// MessengerIngestChatMemberInput plus the Echo id and the account's messenger type
type MessengerIngestChatMemberItem = MessengerIngestChatMemberInput & {
  id: string                            // Echo chat member uuid
  messenger_type: string                // inherited from the account
}
```

Example request — the account itself and one other member:

```json
{
  "account": {
    "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
    "external_id": "17",
    "messenger_type": "Telegram",
    "telegram": { "user_id": "7012345678" }
  },
  "chat": {
    "id": "0199e3a6-2a3b-7c4d-9e5f-6a7b8c9d0e1f",
    "external_id": "9001",
    "telegram": { "chat_id": "-1001234567890" }
  },
  "created": [
    {
      "external_id": "7012345678",
      "username": "op17",
      "first_name": "Ivan",
      "last_name": null,
      "phone": "+380501112233",
      "is_bot": false,
      "role": "member",
      "joined_date": 1759000000000,
      "telegram": { "user_id": "7012345678" }
    },
    {
      "external_id": "6011122233",
      "username": "observer_ua",
      "first_name": "Andrii",
      "last_name": null,
      "phone": null,
      "is_bot": false,
      "role": "admin",
      "joined_date": 1700000000000,
      "telegram": { "user_id": "6011122233" }
    }
  ],
  "updated": {},
  "deleted": []
}
```

Example response:

```json
{
  "created": {
    "0199e3a7-3b4c-7d5e-8f60-718293a4b5c6": {
      "id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c6",
      "messenger_type": "Telegram",
      "external_id": "6011122233",
      "username": "observer_ua",
      "first_name": "Andrii",
      "last_name": null,
      "phone": null,
      "is_bot": false,
      "role": "admin",
      "joined_date": 1700000000000,
      "telegram": { "user_id": "6011122233" }
    },
    "0199e3a7-3b4c-7d5e-8f60-718293a4b5c7": {
      "id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c7",
      "messenger_type": "Telegram",
      "external_id": "7012345678",
      "username": "op17",
      "first_name": "Ivan",
      "last_name": null,
      "phone": "+380501112233",
      "is_bot": false,
      "role": "member",
      "joined_date": 1759000000000,
      "telegram": { "user_id": "7012345678" }
    }
  },
  "updated": {},
  "deleted": []
}
```

Semantics:

- The account and chat references are resolved first; a foreign or
  mismatching reference, or a deleted chat, is a `404`.
- `created`: Echo mints the uuid. Creating an `external_id` that was
  previously deleted in the same chat restores that member with its original
  uuid; its Telegram `user_id` must match the stored member (`400`). Creating
  a live one applies the item as a full update and returns it
  under `created` with its existing uuid; its Telegram `user_id` must match
  the stored member (`400` otherwise). One `external_id` may appear only once
  in `created` (`400`).
- `updated`: keyed by Echo member uuid; full-state replace. `external_id` and
  the Telegram `user_id` cannot change (`400`).
- `deleted`: soft delete; idempotent. Messages keep their sender link, but a
  deleted member cannot be the sender of new messages.
- Members of a deleted chat cannot be synced (the chat ref is a `404`); they
  are kept with the chat and its messages.
- A Telegram `user_id` may belong to only one live member per chat.
- Processing order is `created`, then `updated`, then `deleted`; the batch cap
  applies to the sum of the three collections.

### `POST /contacts/sync`

Route: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `contacts_sync`; implementation:
[`contacts.rs`](../wdintel-rs/src/messenger_ingest/contacts.rs) `sync_contacts`.

Delta sync of the contacts of one account. Same shape and rules as chat
members sync, scoped to the referenced account. Contacts are independent of
chat members; only avatars reference them.

Request:

```ts
type MessengerIngestContactsSyncReq = {
  account: MessengerIngestAccountRef
  created: MessengerIngestContactInput[]
  updated: { [echo_id: string]: MessengerIngestContactInput }
  deleted: string[]                     // Echo contact uuids
}

type MessengerIngestContactInput = {
  external_id: string                   // unique per account
  username: string | null
  first_name: string | null             // as saved in the account's address book
  last_name: string | null
  phone: string | null
  is_mutual: boolean | null
  is_close_friend: boolean | null
  telegram: MessengerIngestTelegramAccountId | null   // { user_id }
}
```

Response:

```ts
type MessengerIngestContactsSyncRsp = {
  created: { [echo_id: string]: MessengerIngestContactItem }
  updated: { [echo_id: string]: MessengerIngestContactItem }
  deleted: string[]                     // uuids actually deleted by this call
}

// MessengerIngestContactInput plus the Echo id and the account's messenger type
type MessengerIngestContactItem = MessengerIngestContactInput & {
  id: string                            // Echo contact uuid
  messenger_type: string                // inherited from the account
}
```

Example request:

```json
{
  "account": {
    "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
    "external_id": "17",
    "messenger_type": "Telegram",
    "telegram": { "user_id": "7012345678" }
  },
  "created": [
    {
      "external_id": "5123456789",
      "username": null,
      "first_name": "Petro",
      "last_name": "K.",
      "phone": "+380671234567",
      "is_mutual": true,
      "is_close_friend": false,
      "telegram": { "user_id": "5123456789" }
    }
  ],
  "updated": {},
  "deleted": []
}
```

Example response:

```json
{
  "created": {
    "0199e3a7-4c5d-7e6f-8071-8293a4b5c6d7": {
      "id": "0199e3a7-4c5d-7e6f-8071-8293a4b5c6d7",
      "messenger_type": "Telegram",
      "external_id": "5123456789",
      "username": null,
      "first_name": "Petro",
      "last_name": "K.",
      "phone": "+380671234567",
      "is_mutual": true,
      "is_close_friend": false,
      "telegram": { "user_id": "5123456789" }
    }
  },
  "updated": {},
  "deleted": []
}
```

Semantics: as chat members sync, per account instead of per chat. A Telegram
`user_id` may belong to only one live contact per account.

## Messages

### `POST /messages/submit`

Route: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `messages_submit`; implementation:
[`messages.rs`](../wdintel-rs/src/messenger_ingest/messages.rs) `submit_messages`.

Idempotent insert of new messages of one chat. Messages enter the regular Echo
processing pipeline (inbox, analysis, search) as messages of the account's
group. Messages carry text and metadata only; attachment content and metadata
are uploaded separately (see Attachments).

Request:

```ts
type MessengerIngestMessagesSubmitReq = {
  account: MessengerIngestAccountRef
  chat: MessengerIngestChatRef
  messages: MessengerIngestMessageInput[]   // at most 100
}

type MessengerIngestMessageInput = {
  external_id: string                   // unique per chat
  date: number                          // epoch ms, message send time
  text: string | null
  is_outgoing: boolean | null           // sent by the account itself
  has_media: boolean | null             // attachments follow separately
  sender: MessengerIngestChatMemberRef | null  // member of this chat; null for channel posts / unknown
  telegram: MessengerIngestTelegramMessageId | null
}

type MessengerIngestTelegramMessageId = { message_id: string }  // decimal int64
```

Response:

```ts
type MessengerIngestMessagesSubmitRsp = {
  results: MessengerIngestMessageItem[] // same order as request.messages
}

type MessengerIngestMessageItem = {
  id: string                            // Echo message uuid
  external_id: string
  status: "created" | "existing"
}
```

Example request:

```json
{
  "account": {
    "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
    "external_id": "17",
    "messenger_type": "Telegram",
    "telegram": { "user_id": "7012345678" }
  },
  "chat": {
    "id": "0199e3a6-2a3b-7c4d-9e5f-6a7b8c9d0e1f",
    "external_id": "9001",
    "telegram": { "chat_id": "-1001234567890" }
  },
  "messages": [
    {
      "external_id": "5550001",
      "date": 1760431100000,
      "text": "Колона техніки рухається в напрямку села",
      "is_outgoing": false,
      "has_media": true,
      "sender": {
        "id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c6",
        "external_id": "6011122233",
        "telegram": { "user_id": "6011122233" }
      },
      "telegram": { "message_id": "48211" }
    },
    {
      "external_id": "5550002",
      "date": 1760431200000,
      "text": "Підтверджую",
      "is_outgoing": true,
      "has_media": false,
      "sender": {
        "id": "0199e3a7-3b4c-7d5e-8f60-718293a4b5c7",
        "external_id": "7012345678",
        "telegram": { "user_id": "7012345678" }
      },
      "telegram": { "message_id": "48212" }
    }
  ]
}
```

Example response (the second message had already been submitted):

```json
{
  "results": [
    {
      "id": "0199e3a8-5e6f-7a0b-9c1d-2e3f4a5b6c7d",
      "external_id": "5550001",
      "status": "created"
    },
    {
      "id": "0199e3a8-5e70-7a0b-9c1d-2e3f4a5b6c7e",
      "external_id": "5550002",
      "status": "existing"
    }
  ]
}
```

Semantics:

- The account and chat references are resolved first; a foreign or
  mismatching reference, or a deleted chat, is a `404`.
- Sender references are checked for new messages only: a resubmitted known
  message is returned as `existing` even if its sender has since been
  deleted.
- Idempotent on `(chat, external_id)`: resubmitting a known message returns
  `existing` with the original Echo id and changes nothing (message text is
  never updated). A resubmission whose Telegram `message_id` differs from the
  stored one is a `400`.
- A Telegram `message_id` may belong to only one message per chat (`400`).
- Two requests that submit the same message at the same time (for example a
  resend after a client timeout while the first is still running) are not
  serialized: the one that commits second fails with `409` and stores
  nothing. Resending it returns the stored messages as `existing`. Collectors
  should submit one chat's batches sequentially.

```json
{
  "message": "message 5550001 was submitted concurrently; retry the request",
  "details": {
    "code": "messenger_ingest_concurrent_submit",
    "external_id": "5550001"
  }
}
```
- Messages are never deduplicated against other messages: identical text in
  two chats, two accounts or two submissions gives separate Echo messages, and
  ingest messages are never merged into messages from other sources.
- Long messages are kept whole as one Echo message; they are not split into
  several inbox items.
- The Echo author of every message is the API login. The messenger author is
  referenced by `sender` and must be a live member of the same chat, synced
  beforehand with `chats/members/sync`; an unknown, deleted, mismatching or
  other-chat sender ref is a `404` and rejects the batch. Messages never
  create members.
- The account itself is a member of its chats: outgoing messages reference
  the account's own member row as `sender`.
- `text: null` is stored as an empty message body.
- `date` is the message's position in the chat timeline. Dates and times
  mentioned in the text (for example "14:20") are interpreted relative to
  `date`, not to the submission time, so backfilled history keeps correct
  event times.

## Attachments

Attachment content is uploaded with TUS first, then attached to an already
submitted message. Messages and attachments are independent requests, so a
message is visible in Echo before its files arrive.

### TUS uploads

Routes: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `uploads_base`, `uploads_file`; implementation:
[`uploads.rs`](../wdintel-rs/src/messenger_ingest/uploads.rs) `handle_upload`.

TUS 1.0.0 with the `creation`, `expiration` and `termination` extensions; any
TUS client library works. Every request needs `Tus-Resumable: 1.0.0` and the
ingest access of the other endpoints.

| Request | Purpose |
|---|---|
| `OPTIONS /uploads` | Capabilities: `Tus-Version`, `Tus-Extension`, `Tus-Max-Size` |
| `POST /uploads` | Create an upload; `Upload-Length` required, `Upload-Metadata` optional |
| `HEAD /uploads/{id}` | Current `Upload-Offset`, to resume |
| `PATCH /uploads/{id}` | Append bytes at `Upload-Offset` (`Content-Type: application/offset+octet-stream`); `POST` with `X-HTTP-Method-Override: PATCH` is accepted |
| `DELETE /uploads/{id}` | Abort an upload |

```http
POST /api/messenger-ingest/v1/uploads
Tus-Resumable: 1.0.0
Upload-Length: 482113
Upload-Metadata: filename cGhvdG8uanBn,filetype aW1hZ2UvanBlZw==

HTTP/1.1 201 Created
Location: /api/messenger-ingest/v1/uploads/0199e3a7-0c1d-7e2f-8a3b-4c5d6e7f8091
Upload-Expires: Wed, 15 Oct 2026 16:00:00 GMT
```

- The `Location` is the `upload_url` passed to the attach call or to an
  avatar submit.
- Uploads are owned by the login. Another login's upload, or an operator
  upload URL (`/api/sigint/file-upload/tus/...`), is rejected by the attach
  and avatar calls.
- Only `filename` and `filetype` metadata are used.
- Limits: 6 GiB per file. An unfinished upload expires after 4 h, a completed
  but unattached one after 8 h.
- Collector file paths are never accepted as storage locations.

### `POST /messages/attachments/submit`

Route: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs) `attachments_submit`; implementation:
[`attachments.rs`](../wdintel-rs/src/messenger_ingest/attachments.rs) `submit_attachments`.

Idempotent attach of completed uploads to one submitted message, referenced
by chat and message `external_id`.

Request:

```ts
type MessengerIngestAttachmentsSubmitReq = {
  account: MessengerIngestAccountRef
  chat: MessengerIngestChatRef
  message_external_id: string
  attachments: MessengerIngestAttachmentInput[] // at most 20
}

type MessengerIngestAttachmentInput = {
  external_id: string        // unique within the message
  upload_url: string         // Location of a completed ingest upload
  file_name: string | null   // overrides TUS `filename`
  content_type: string | null // MIME type, overrides TUS `filetype`
  created_at: number | null  // when the collector recorded the media, epoch ms
  telegram: MessengerIngestTelegramMedia | null
}

type MessengerIngestTelegramMedia = {
  file_id: string            // decimal int64
  media_type: string | null  // Telegram media kind as reported: "photo", "voice", ...
}
```

Example request:

```json
{
  "account": {
    "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
    "external_id": "17",
    "messenger_type": "Telegram",
    "telegram": { "user_id": "7012345678" }
  },
  "chat": {
    "id": "0199e3a6-2a3b-7c4d-9e5f-6a7b8c9d0e1f",
    "external_id": "9001",
    "telegram": { "chat_id": "-1001234567890" }
  },
  "message_external_id": "5550001",
  "attachments": [
    {
      "external_id": "5550001:0",
      "upload_url": "/api/messenger-ingest/v1/uploads/0199e3a7-0c1d-7e2f-8a3b-4c5d6e7f8091",
      "file_name": "photo_2026-10-14.jpg",
      "content_type": "image/jpeg",
      "created_at": 1760431200000,
      "telegram": { "file_id": "5413920012345678901", "media_type": "photo" }
    }
  ]
}
```

Response:

```ts
type MessengerIngestAttachmentsSubmitRsp = {
  results: MessengerIngestAttachmentItem[] // request order
}

type MessengerIngestAttachmentItem = {
  id: string          // Echo media uuid
  external_id: string
  status: "created" | "existing"
}
```

Example response:

```json
{
  "results": [
    {
      "id": "0199e3a8-4d5e-7f60-8172-839405162738",
      "external_id": "5550001:0",
      "status": "created"
    }
  ]
}
```

Semantics:

- All-or-nothing per request. An unknown message `external_id` is `404`, as
  are foreign account and chat refs.
- Files are copied to storage before the attachments are recorded, outside
  any database transaction, so large uploads do not block other requests.
  If recording fails, the copies are discarded.
- Two requests that attach the same `external_id` at the same time: the one
  that records second fails with `409`
  (`details.code` = `messenger_ingest_concurrent_attach`) and stores nothing;
  resending it returns the attachment as `existing`.
- An attachment already stored under the same message and `external_id` is
  `existing`: its `upload_url` is not read again, so retrying after a
  successful but unacknowledged call succeeds even though the uploads were
  consumed.
- New attachments need completed uploads of the caller; a missing,
  incomplete, foreign or operator upload is a `400` and nothing is stored.
  Uploads are deleted only after a successful commit, so a failed request can
  be retried with the same `upload_url`s.
- A repeated `external_id` within one request is a `400`.
- Stored attachments enter the regular media pipeline (previews, OCR,
  transcription, conversion) like operator attachments.
- The media itself is a regular Echo attachment: `content_type` (the MIME
  type), file name and size describe the stored file. Messenger metadata
  (`created_at`, Telegram `file_id` and `media_type`) is kept alongside it
  and does not affect processing.
- A retry whose Telegram `file_id` or `media_type` differs from the stored
  attachment is a `400`; `created_at` is not compared.
- Telegram's `has_preview` is not ingested.

## Avatars

Avatars of accounts, chats, chat members and contacts. The content is
uploaded once with TUS (see [TUS uploads](#tus-uploads)), then recorded on
its owner by one submit endpoint per owner type. Each request carries one
avatar for one owner. Every avatar is kept: an owner has a history of avatars
and at most one **current** avatar, which the submit attaches to the owner.
Avatars are stored only; they are not shown in Echo yet and do not enter the
media pipeline (no previews, OCR or transcription). The sync endpoints
neither accept nor return avatars.

| Route | Owner | Request |
|---|---|---|
| `POST /accounts/avatar/submit` | the referenced account | `MessengerIngestAccountAvatarSubmitReq` |
| `POST /chats/avatar/submit` | a chat of the account | `MessengerIngestChatAvatarSubmitReq` |
| `POST /chats/members/avatar/submit` | a member of a chat | `MessengerIngestChatMemberAvatarSubmitReq` |
| `POST /contacts/avatar/submit` | a contact of the account | `MessengerIngestContactAvatarSubmitReq` |

All four return `MessengerIngestAvatarSubmitRsp`.

Routes: [`mod.rs`](../wdintel-rs/src/messenger_ingest/mod.rs)
`account_avatar_submit`, `chat_avatar_submit`, `chat_member_avatar_submit`,
`contact_avatar_submit`; implementation:
[`avatars.rs`](../wdintel-rs/src/messenger_ingest/avatars.rs)
`submit_account_avatar`, `submit_chat_avatar`, `submit_chat_member_avatar`,
`submit_contact_avatar`.

Each endpoint is an idempotent record of a completed upload as an avatar of
the referenced owner. The owner is referenced with the refs learned from the
sync responses. An absent or `null` `avatar` removes the owner's current
avatar and keeps its history.

```ts
type MessengerIngestAvatarInput = {
  external_id: string          // unique per owner, e.g. the Telegram photo id
  upload_url: string           // Location of a completed ingest upload
  file_name: string | null     // overrides TUS `filename`
  content_type: string | null  // MIME type, overrides TUS `filetype`
  set_at: number | null        // when the avatar was set in the messenger, epoch ms
  is_current: boolean          // make it the owner's current avatar
  telegram: MessengerIngestTelegramAvatar | null
}

type MessengerIngestTelegramAvatar = { photo_id: string }   // decimal int64

type MessengerIngestAccountAvatarSubmitReq = {
  account: MessengerIngestAccountRef
  avatar: MessengerIngestAvatarInput | null
}

type MessengerIngestChatAvatarSubmitReq = {
  account: MessengerIngestAccountRef
  chat: MessengerIngestChatRef
  avatar: MessengerIngestAvatarInput | null
}

type MessengerIngestChatMemberAvatarSubmitReq = {
  account: MessengerIngestAccountRef
  chat: MessengerIngestChatRef
  member: MessengerIngestChatMemberRef
  avatar: MessengerIngestAvatarInput | null
}

type MessengerIngestContactAvatarSubmitReq = {
  account: MessengerIngestAccountRef
  contact: MessengerIngestContactRef
  avatar: MessengerIngestAvatarInput | null
}
```

Response:

```ts
type MessengerIngestAvatarSubmitRsp = {
  avatar: MessengerIngestAvatarItem | null   // null when the current avatar was removed
}

type MessengerIngestAvatarItem = {
  id: string                   // Echo avatar uuid
  external_id: string
  status: "created" | "existing"
  is_current: boolean          // the owner's current avatar after this request
}
```

Example request to `POST /chats/avatar/submit` — a new current avatar for a
chat:

```json
{
  "account": {
    "id": "0199e3a2-4c1b-7d2e-9f10-3a4b5c6d7e8f",
    "external_id": "17",
    "messenger_type": "Telegram",
    "telegram": { "user_id": "7012345678" }
  },
  "chat": {
    "id": "0199e3a6-2a3b-7c4d-9e5f-6a7b8c9d0e1f",
    "external_id": "9001",
    "telegram": { "chat_id": "-1001234567890" }
  },
  "avatar": {
    "external_id": "5413920012345678901",
    "upload_url": "/api/messenger-ingest/v1/uploads/0199e3a7-0c1d-7e2f-8a3b-4c5d6e7f8091",
    "file_name": "chat_photo.jpg",
    "content_type": "image/jpeg",
    "set_at": 1760431200000,
    "is_current": true,
    "telegram": { "photo_id": "5413920012345678901" }
  }
}
```

Example response:

```json
{
  "avatar": {
    "id": "0199e3a9-6f70-7b1c-8d2e-3f4a5b6c7d8e",
    "external_id": "5413920012345678901",
    "status": "created",
    "is_current": true
  }
}
```

Semantics:

- The account reference is resolved first, then the owner reference under it
  (for a member, the chat first). A foreign, mismatching or deleted owner is
  a `404`.
- Accepted content is `image/*` and `video/*` (animated profile videos), at
  most 20 MiB per file. The type is the `content_type` sent or, without it,
  the TUS `filetype` or the detected type; anything else is a `400`.
- A new avatar needs a completed upload of the caller; a missing,
  incomplete, foreign or operator upload is a `400` and nothing is stored.
- `is_current: true` points the owner at the avatar, also when the avatar
  was stored earlier, so a collector can switch back to an older avatar
  without uploading it again. `is_current: false` stores the avatar as
  history and never changes the current avatar.
- Removing the current avatar (`avatar: null`) leaves the owner without a
  current avatar until a later submit sets one.
- The file is copied to storage before the avatar is recorded, outside any
  database transaction. If recording fails, the copy is discarded and the
  upload is kept, so the request can be retried with the same `upload_url`.
  The upload is consumed only after a successful commit.
- Telegram's `photo_id` is optional, and a `telegram` sub-object on a
  non-Telegram account is a `400`.

#### Duplicates

An avatar is identified by its owner and its `external_id`. The same
`external_id` under different owners is a different avatar: one Telegram
photo that is the avatar of a member in two chats and of a contact gives
three avatars and three stored copies.

| Case | Result |
|---|---|
| An avatar whose owner and `external_id` are already stored | `existing` with the stored id. `upload_url` is not read, so a consumed upload is fine. `is_current` is applied; nothing else changes |
| The same, but the Telegram `photo_id` differs from the stored one (including sent versus stored `null`) | `400 telegram fields do not match avatar <external_id>` |
| A new `external_id` whose Telegram `photo_id` is already stored under another `external_id` of the same owner | `400 telegram photo_id <id> already belongs to another avatar` |
| A new `external_id` with the same content as a stored avatar | Stored as a new avatar; there is no content deduplication |
| A concurrent request stores the same owner and `external_id` between this request's read and its write | `409` `messenger_ingest_concurrent_avatar`. Nothing is stored and the upload is kept; a retry returns `existing` |

`set_at`, `file_name` and `content_type` are not compared on retries.

## Planned

### Device sessions — pending approval

The account's active messenger sessions (device, platform, app, IP, country,
activity dates). Contains location data and needs an explicit decision before
it is specified.

## Not ingested

| Collector data | Reason |
|---|---|
| Session strings / tokens | Credentials |
| Collector users, groups, audit logs, read states | Collector administration, not intelligence data |
| AI summaries, transcriptions, search vectors | Echo produces its own |
| File paths, storage roots, download priorities, `is_downloaded` | Collector-local operational state |
| Media `has_preview` | Not needed: Echo builds its own previews |
| Account rating / hidden flag | Collector UI state |

## Open questions

- **Full snapshots**: with the delta shape the collector must track deletions
  itself. Add an optional "everything not listed is deleted" mode for chats,
  members and contacts, where the collector only knows the current list?
- **Channel senders**: channel posts and anonymous admins have no member to
  reference, so `sender` is `null`. Reference the chat (or another chat) as the
  sender instead?
- **Account `external_id`**: should collectors send their internal account id
  (consistent with chats and messages) or their human-facing display number?
- **Provider ids**: per-messenger fields (`telegram.user_id`, later
  `max.user_id`, ...) versus one generic `native_id` with the messenger
  sub-object reserved for fields that really differ.
- **Chat metadata**: add `created_at`, `is_history_loaded` (history fully
  collected) and `is_sync_paused`?
- **`chat_type` vocabulary**: free text, or a documented set shared by all
  messengers (`private`, `group`, `channel`, ...)?
- **Echo message id**: expose the Echo message uuid only, or also the numeric
  id used in the Echo UI?
- **Telegram `media_type` vocabulary**: free text for now; document or
  validate the set (`photo`, `video`, `video_note`, `voice`, `audio`,
  `document`, `sticker`, `animation`)?
- **Message edits and deletions**: not supported yet; resubmissions never
  change a stored message.

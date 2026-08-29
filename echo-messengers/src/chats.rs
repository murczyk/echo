use crate::config::{
    Config, CHAT_ATTACHMENTS_TOTAL_MAX_BYTES, CHAT_ATTACHMENT_MAX_BYTES,
    CHAT_ATTACHMENT_MAX_COUNT, CHAT_LIST_PAGE_SIZE, CHAT_MESSAGE_PAGE_SIZE,
    CHAT_UNREAD_KEY_TTL_DAYS, CHAT_WEBHOOK_BATCH_SIZE,
    CHAT_WEBHOOK_CLEANUP_BATCH_SIZE, CHAT_WEBHOOK_HISTORY_RETENTION_DAYS,
    CHAT_WEBHOOK_MAX_ATTEMPTS, CHAT_WEBHOOK_REQUEST_TIMEOUT_SECS,
};
use crate::error::{
    bad_request, conflict, not_found, service_unavailable, ShortContext,
};
use crate::h;
use base64::{engine::general_purpose, Engine};
use chrono::NaiveDateTime;
use echo_im::entities::sea_orm_active_enums::EchoMessageSource;
use echo_im::entities::{
    echo_account, echo_client, echo_group, echo_inbox_message,
};
use echo_im::types::{
    MessageSource, OutboxAttachmentInput, ReactToMessageReq, SendMessageReq,
    SendReplyReq,
};
use redis::AsyncCommands;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    EntityTrait, FromQueryResult, QueryFilter, Statement, TransactionTrait,
    Value,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

const ALLOWED_REACTIONS: [&str; 6] = ["➕", "➖", "👍", "👎", "❤️", "👀"];
const ACCOUNT_COLORS: [&str; 12] = [
    "#38bdf8", "#f97316", "#a78bfa", "#22c55e", "#f43f5e", "#eab308",
    "#14b8a6", "#ec4899", "#6366f1", "#84cc16", "#06b6d4", "#fb7185",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatKind {
    Private,
    Group,
}

impl ChatKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Group => "group",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ChatKey {
    version: u8,
    client_id: i32,
    account_id: i32,
    kind: ChatKind,
    target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub enabled: bool,
    pub clients: Vec<ClientOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientOption {
    pub id: i32,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub client_id: i32,
    pub client_name: String,
    pub account_id: i32,
    pub account_label: String,
    pub account_source: String,
    pub account_color: &'static str,
    pub kind: ChatKind,
    pub title: String,
    pub preview_sender: String,
    pub preview: String,
    pub last_message_at: NaiveDateTime,
    pub unread_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatList {
    pub chats: Vec<ChatSummary>,
    pub next_cursor: Option<String>,
    pub unread_available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListQuery {
    pub before: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptions {
    pub private: Vec<FilterOption>,
    pub groups: Vec<FilterOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOption {
    pub id: String,
    pub client_id: i32,
    pub account_id: i32,
    pub account_label: String,
    pub account_color: &'static str,
    pub kind: ChatKind,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub inbox_id: Option<i32>,
    pub outgoing: bool,
    pub sender_name: String,
    pub body: String,
    pub timestamp: NaiveDateTime,
    pub delivery_status: String,
    pub reply: Option<ReplyPreview>,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<String>,
    pub unread: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyPreview {
    pub id: String,
    pub sender_name: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i32,
    pub name: Option<String>,
    pub url: String,
    pub media_kind: &'static str,
    pub content_type: &'static str,
    pub size_bytes: Option<u64>,
    pub available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<ChatMessage>,
    pub next_cursor: Option<String>,
    pub unread_available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePageQuery {
    pub before: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub content_base64: String,
    pub filename: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReq {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyReq {
    pub inbox_message_id: i32,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionReq {
    pub inbox_message_id: i32,
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkReadReq {
    #[serde(default)]
    pub inbox_message_ids: Vec<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsReq {
    pub hide_private: bool,
    pub hide_groups: bool,
    #[serde(default)]
    pub private_filters: Vec<String>,
    #[serde(default)]
    pub group_filters: Vec<String>,
    pub private_webhook: WebhookUpdate,
    pub group_webhook: WebhookUpdate,
    pub store_data_30_days: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "lowercase")]
pub enum WebhookUpdate {
    Keep,
    Remove,
    Replace(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub client_id: i32,
    pub hide_private: bool,
    pub hide_groups: bool,
    pub private_filters: Vec<String>,
    pub group_filters: Vec<String>,
    pub private_webhook_configured: bool,
    pub group_webhook_configured: bool,
    pub store_data_30_days: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub receipt: String,
    pub message: ChatMessage,
}

#[derive(Debug, FromQueryResult)]
struct ChatRow {
    client_id: i32,
    client_name: String,
    account_id: i32,
    account_label: String,
    account_source: String,
    kind: String,
    target: String,
    title: String,
    preview_sender: String,
    preview: String,
    last_message_at: NaiveDateTime,
    linked_at: Option<NaiveDateTime>,
}

#[derive(Debug, FromQueryResult)]
struct MessageRow {
    direction: String,
    row_id: i32,
    outbox_message_id: Option<i32>,
    body: String,
    sender_name: String,
    occurred_at: NaiveDateTime,
    delivery_status: String,
    reply_direction: Option<String>,
    reply_row_id: Option<i32>,
    reply_sender_name: Option<String>,
    reply_text: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct FilterRow {
    client_id: i32,
    account_id: i32,
    chat_kind: String,
    participant_key: Option<String>,
    group_id: Option<i32>,
}

#[derive(Debug, FromQueryResult)]
struct SettingsRow {
    client_id: i32,
    hide_private: bool,
    hide_groups: bool,
    private_webhook_url: Option<String>,
    group_webhook_url: Option<String>,
    store_data_30_days: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct MessageCursor {
    occurred_at: NaiveDateTime,
    direction: String,
    row_id: i32,
}

#[derive(Debug, FromQueryResult)]
struct AttachmentRow {
    id: i32,
    message_id: i32,
    name: Option<String>,
    path: Option<String>,
    extension: Option<String>,
    direction: String,
    content_base64_size: Option<i64>,
}

#[derive(Debug, FromQueryResult)]
struct ReactionRow {
    message_id: i32,
    code: String,
    direction: String,
}

#[derive(Debug, FromQueryResult)]
struct AccountScope {
    client_id: i32,
    account_id: i32,
    linked_at: Option<NaiveDateTime>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ChatListCursor {
    last_message_at: NaiveDateTime,
    client_id: i32,
    account_id: i32,
    kind: String,
    target: String,
}

#[derive(Debug, FromQueryResult)]
struct FilterOptionRow {
    client_id: i32,
    account_id: i32,
    account_label: String,
    kind: String,
    target: String,
    title: String,
}

pub async fn capability(db: &DatabaseConnection) -> anyhow::Result<Capability> {
    let clients = enabled_clients(db).await.c(h!())?;
    Ok(Capability {
        enabled: !clients.is_empty(),
        clients,
    })
}

pub async fn filter_options(
    db: &DatabaseConnection,
    client_id: i32,
) -> anyhow::Result<FilterOptions> {
    enabled_client(db, client_id).await.c(h!())?;
    let rows = FilterOptionRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with options as (
                select c.id as client_id, a.id as account_id,
                    a.phone_number as account_label, 'private'::text as kind,
                    case when s.phone_number is not null
                        then 'p:' || regexp_replace(s.phone_number, '[^0-9+]', '', 'g')
                        else 'u:' || s.uuid end as target,
                    coalesce(s.name, s.phone_number, s.uuid) as title
                from echo_client c
                join echo_client_lock l on l.client_id = c.id and not l.remove_requested
                join echo_account a on a.id = l.account_id and a.is_linked
                join echo_sender s on s.account_id = a.id
                where c.id = $1 and not c.deleted and c.show_chats_admin_panel = true
                union all
                select c.id, a.id, a.phone_number, 'private',
                    'p:' || regexp_replace(r.phone_number, '[^0-9+]', '', 'g'),
                    coalesce(r.name, r.phone_number)
                from echo_client c
                join echo_client_lock l on l.client_id = c.id and not l.remove_requested
                join echo_account a on a.id = l.account_id and a.is_linked
                join echo_recipient r on r.account_id = a.id
                where c.id = $1 and not c.deleted and c.show_chats_admin_panel = true
                union all
                select c.id, a.id, a.phone_number, 'group', g.id::text,
                    coalesce(g.name, g.group_id)
                from echo_client c
                join echo_client_lock l on l.client_id = c.id and not l.remove_requested
                join echo_account a on a.id = l.account_id and a.is_linked
                join echo_group g on g.account_id = a.id
                where c.id = $1 and not c.deleted and c.show_chats_admin_panel = true
                    and not g.deleted_by_messanger
            )
            select distinct on (client_id, account_id, kind, target)
                client_id, account_id, account_label, kind, target, title
            from options
            order by client_id, account_id, kind, target, title
            "#,
            [client_id.into()],
        ),
    )
    .all(db)
    .await
    .c(h!())?;
    let mut options = FilterOptions {
        private: Vec::new(),
        groups: Vec::new(),
    };
    for row in rows {
        let kind = parse_chat_kind(&row.kind).c(h!())?;
        let id = encode_chat_id(&ChatKey {
            version: 1,
            client_id: row.client_id,
            account_id: row.account_id,
            kind,
            target: row.target,
        })
        .c(h!())?;
        let option = FilterOption {
            id,
            client_id: row.client_id,
            account_id: row.account_id,
            account_label: row.account_label,
            account_color: account_color(row.client_id, row.account_id),
            kind,
            title: row.title,
        };
        match kind {
            ChatKind::Private => options.private.push(option),
            ChatKind::Group => options.groups.push(option),
        }
    }
    options.private.sort_by(option_order);
    options.groups.sort_by(option_order);
    Ok(options)
}

async fn enabled_clients(
    db: &DatabaseConnection,
) -> anyhow::Result<Vec<ClientOption>> {
    let clients = echo_client::Entity::find()
        .filter(echo_client::Column::Deleted.eq(false))
        .filter(echo_client::Column::ShowChatsAdminPanel.eq(true))
        .all(db)
        .await
        .c(h!())?;
    Ok(clients
        .into_iter()
        .map(|client| ClientOption {
            id: client.id,
            name: client.name,
        })
        .collect())
}

pub async fn list(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
    query: ChatListQuery,
) -> anyhow::Result<ChatList> {
    let cursor = query
        .before
        .as_deref()
        .map(decode_chat_list_cursor)
        .transpose()
        .c(h!())?;
    let sql = r#"
        with scopes as (
            select c.id as client_id, c.name as client_name, a.id as account_id,
                a.phone_number as account_label, a.source::text as account_source,
                a.linked_at
            from echo_client c
            join echo_client_lock l on l.client_id = c.id and not l.remove_requested
            join echo_account a on a.id = l.account_id and a.is_linked
            where not c.deleted and c.show_chats_admin_panel = true
        ), private_options as (
            select scope.*, case when sender.phone_number is not null
                    then 'p:' || regexp_replace(sender.phone_number, '[^0-9+]', '', 'g')
                    else 'u:' || sender.uuid end as target,
                coalesce(sender.name, sender.phone_number, sender.uuid) as title,
                sender.id as sender_id, null::integer as recipient_id
            from scopes scope
            join echo_sender sender on sender.account_id = scope.account_id
            union all
            select scope.*, 'p:' || regexp_replace(recipient.phone_number, '[^0-9+]', '', 'g'),
                coalesce(recipient.name, recipient.phone_number), null, recipient.id
            from scopes scope
            join echo_recipient recipient on recipient.account_id = scope.account_id
        ), identities as (
            select client_id, client_name, account_id, account_label, account_source,
                linked_at, 'private'::text as kind, target, min(title) as title,
                array_agg(sender_id) filter (where sender_id is not null) as sender_ids,
                array_agg(recipient_id) filter (where recipient_id is not null) as recipient_ids,
                null::integer as group_id
            from private_options
            group by client_id, client_name, account_id, account_label,
                account_source, linked_at, target
            union all
            select scope.client_id, scope.client_name, scope.account_id,
                scope.account_label, scope.account_source, scope.linked_at,
                'group', group_item.id::text, coalesce(group_item.name, group_item.group_id),
                null::integer[], null::integer[], group_item.id
            from scopes scope
            join echo_group group_item on group_item.account_id = scope.account_id
                and not group_item.deleted_by_messanger
        ), chat_latest as (
            select identity.client_id, identity.client_name, identity.account_id,
                identity.account_label, identity.account_source, identity.kind,
                identity.target, identity.title, identity.group_id,
                latest.preview_sender,
                latest.preview, latest.last_message_at, identity.linked_at
            from identities identity
            cross join lateral (
                select candidate.preview_sender, candidate.preview,
                    candidate.last_message_at
                from (
                    (select coalesce(sender.name, sender.phone_number, sender.uuid, 'Невідомий') as preview_sender,
                        message.body as preview,
                        coalesce(message.timestamp, message.created_at) as last_message_at,
                        'in'::text as direction, message.id as row_id
                    from echo_inbox_message message
                    left join echo_sender sender on sender.id = message.sender_id
                    where message.client_id = identity.client_id
                        and message.account_id = identity.account_id
                        and not message.deleted and message.duplicate_of is null
                        and identity.kind = 'group'
                        and message.group_id = identity.group_id
                    order by coalesce(message.timestamp, message.created_at) desc,
                        message.id desc
                    limit 1)
                    union all
                    (select coalesce(sender.name, sender.phone_number, sender.uuid, 'Невідомий'),
                        message.body, coalesce(message.timestamp, message.created_at),
                        'in', message.id
                    from unnest(identity.sender_ids) as sender_item(sender_id)
                    cross join lateral (
                        select item.id, item.sender_id, item.body, item.timestamp,
                            item.created_at
                        from echo_inbox_message item
                        where item.client_id = identity.client_id
                            and item.account_id = identity.account_id
                            and item.sender_id = sender_item.sender_id
                            and item.group_id is null and not item.deleted
                            and item.duplicate_of is null
                        order by coalesce(item.timestamp, item.created_at) desc,
                            item.id desc
                        limit 1
                    ) message
                    join echo_sender sender on sender.id = message.sender_id
                    where identity.kind = 'private'
                    order by coalesce(message.timestamp, message.created_at) desc,
                        message.id desc
                    limit 1)
                    union all
                    (select 'Я', message.body,
                        coalesce(instance.sent_at, instance.created_at),
                        'out', instance.id
                    from echo_outbox_message_instance instance
                    cross join lateral (
                        select outbox.body
                        from echo_outbox_message outbox
                        where outbox.id = instance.message_id
                            and outbox.client_id = identity.client_id
                        offset 0
                    ) message
                    where instance.account_id = identity.account_id
                        and identity.kind = 'group'
                        and instance.group_id = identity.group_id
                    order by coalesce(instance.sent_at, instance.created_at) desc,
                        instance.id desc
                    limit 1)
                    union all
                    (select 'Я', message.body,
                        coalesce(instance.sent_at, instance.created_at),
                        'out', instance.id
                    from unnest(identity.recipient_ids) as recipient_item(recipient_id)
                    cross join lateral (
                        select item.id, item.message_id, item.sent_at, item.created_at
                        from echo_outbox_message_instance item
                        where item.account_id = identity.account_id
                            and item.recipient_id = recipient_item.recipient_id
                            and item.group_id is null
                            and item.reply_to_inbox_message_id is null
                        order by coalesce(item.sent_at, item.created_at) desc,
                            item.id desc
                        limit 1
                    ) instance
                    cross join lateral (
                        select outbox.body
                        from echo_outbox_message outbox
                        where outbox.id = instance.message_id
                            and outbox.client_id = identity.client_id
                        offset 0
                    ) message
                    where identity.kind = 'private'
                    order by coalesce(instance.sent_at, instance.created_at) desc,
                        instance.id desc
                    limit 1)
                    union all
                    (select 'Я', message.body,
                        coalesce(instance.sent_at, instance.created_at),
                        'out', instance.id
                    from unnest(identity.sender_ids) as sender_item(sender_id)
                    join echo_inbox_message reply_in on reply_in.sender_id = sender_item.sender_id
                        and reply_in.client_id = identity.client_id
                        and reply_in.account_id = identity.account_id
                        and reply_in.group_id is null and not reply_in.deleted
                        and reply_in.duplicate_of is null
                    join echo_outbox_message_instance instance
                        on instance.reply_to_inbox_message_id = reply_in.id
                        and instance.account_id = identity.account_id
                        and instance.reply_to_inbox_message_id is not null
                    cross join lateral (
                        select outbox.body
                        from echo_outbox_message outbox
                        where outbox.id = instance.message_id
                            and outbox.client_id = identity.client_id
                        offset 0
                    ) message
                    where identity.kind = 'private' and instance.group_id is null
                    order by coalesce(instance.sent_at, instance.created_at) desc,
                        instance.id desc
                    limit 1)
                ) candidate
                order by candidate.last_message_at desc, candidate.direction desc,
                    candidate.row_id desc
                limit 1
            ) latest
        )
        select chat_latest.client_id, chat_latest.client_name,
            chat_latest.account_id, chat_latest.account_label,
            chat_latest.account_source, chat_latest.kind, chat_latest.target,
            chat_latest.title, chat_latest.preview_sender, chat_latest.preview,
            chat_latest.last_message_at, chat_latest.linked_at
        from chat_latest
        left join echo_client_settings settings
            on settings.client_id = chat_latest.client_id
        where coalesce(
                case when kind = 'private' then settings.hide_private
                    else settings.hide_groups end,
                false
              ) = (
                (chat_latest.kind = 'private' and exists (
                    select 1
                    from echo_chat_filter filter_item
                    where filter_item.client_id = chat_latest.client_id
                        and filter_item.account_id = chat_latest.account_id
                        and filter_item.chat_kind = 'private'
                        and filter_item.participant_key = chat_latest.target
                )) or (chat_latest.kind = 'group' and exists (
                    select 1
                    from echo_chat_filter filter_item
                    where filter_item.client_id = chat_latest.client_id
                        and filter_item.account_id = chat_latest.account_id
                        and filter_item.chat_kind = 'group'
                        and filter_item.group_id = chat_latest.group_id
                ))
              )
          and ($1::timestamp is null or
            (chat_latest.last_message_at, chat_latest.client_id,
                chat_latest.account_id, chat_latest.kind, chat_latest.target) <
            ($1, $2, $3, $4, $5))
        order by chat_latest.last_message_at desc, chat_latest.client_id desc,
            chat_latest.account_id desc, chat_latest.kind desc,
            chat_latest.target desc
        limit $6
    "#;
    let (before_at, before_client, before_account, before_kind, before_target) =
        cursor
            .map(|cursor| {
                (
                    Some(cursor.last_message_at),
                    cursor.client_id,
                    cursor.account_id,
                    cursor.kind,
                    cursor.target,
                )
            })
            .unwrap_or((
                None,
                i32::MAX,
                i32::MAX,
                "zz".to_string(),
                "zz".to_string(),
            ));
    let mut rows = ChatRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [
            before_at.into(),
            before_client.into(),
            before_account.into(),
            before_kind.into(),
            before_target.into(),
            (CHAT_LIST_PAGE_SIZE + 1).into(),
        ],
    ))
    .all(db)
    .await
    .c(h!())?;
    let has_more = rows.len() > CHAT_LIST_PAGE_SIZE as usize;
    if has_more {
        rows.pop();
    }
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_chat_list_cursor(&ChatListCursor {
                    last_message_at: row.last_message_at,
                    client_id: row.client_id,
                    account_id: row.account_id,
                    kind: row.kind.clone(),
                    target: row.target.clone(),
                })
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    let rows = rows
        .into_iter()
        .map(|row| {
            let key = chat_key_from_row(&row).c(h!())?;
            Ok((row, key))
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let unread = unread_counts(chat_redis, &rows).await.c(h!())?;
    let mut chats = Vec::with_capacity(rows.len());
    for (row, key) in rows {
        let id = encode_chat_id(&key).c(h!())?;
        let unread_count = unread.counts.get(&id).copied().unwrap_or_default();
        chats.push(ChatSummary {
            id,
            client_id: row.client_id,
            client_name: row.client_name,
            account_id: row.account_id,
            account_label: row.account_label,
            account_source: row.account_source,
            account_color: account_color(row.client_id, row.account_id),
            kind: key.kind,
            title: row.title,
            preview_sender: row.preview_sender,
            preview: row.preview.replace(['\n', '\r'], " "),
            last_message_at: row.last_message_at,
            unread_count,
        });
    }
    Ok(ChatList {
        chats,
        next_cursor,
        unread_available: unread.available,
    })
}

pub async fn messages(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
    chat_id: &str,
    query: MessagePageQuery,
) -> anyhow::Result<MessagePage> {
    let key = require_visible_chat(db, chat_id).await.c(h!())?;
    let cursor = query
        .before
        .as_deref()
        .map(decode_cursor)
        .transpose()
        .c(h!())?;
    let (selected_sql, target_values) =
        message_selection(db, &key).await.c(h!())?;
    let sql = format!(
        r#"
        with selected as ({selected_sql})
        select direction, row_id, outbox_message_id, body, sender_name, occurred_at,
            delivery_status, reply_direction, reply_row_id, reply_sender_name, reply_text
        from (
            select selected.direction, selected.row_id, selected.outbox_message_id,
                case when selected.direction = 'in' then inbox.body else outbox.body end as body,
                case when selected.direction = 'in'
                    then coalesce(sender.name, sender.phone_number, sender.uuid, 'Невідомий')
                    else 'Я' end as sender_name,
                selected.occurred_at, selected.delivery_status,
                case when reply_in.id is not null then 'in'
                    when reply_instance.id is not null then 'out' end as reply_direction,
                coalesce(reply_in.id, reply_instance.id) as reply_row_id,
                case when reply_in.id is not null
                    then coalesce(reply_sender.name, reply_sender.phone_number, reply_sender.uuid, 'Невідомий')
                    when reply_instance.id is not null then 'Я' end as reply_sender_name,
                coalesce(reply_in.body, reply_out.body) as reply_text
            from selected
            left join echo_inbox_message inbox
                on selected.direction = 'in' and inbox.id = selected.row_id
            left join echo_sender sender on sender.id = inbox.sender_id
            left join echo_outbox_message_instance outbox_instance
                on selected.direction = 'out' and outbox_instance.id = selected.row_id
            left join echo_outbox_message outbox on outbox.id = selected.outbox_message_id
            left join echo_inbox_message reply_in on reply_in.id =
                coalesce(inbox.reply_to_inbox_message_id, outbox_instance.reply_to_inbox_message_id)
            left join echo_sender reply_sender on reply_sender.id = reply_in.sender_id
            left join echo_outbox_message_instance reply_instance
                on reply_instance.id = inbox.reply_to_outbox_message_id
            left join echo_outbox_message reply_out on reply_out.id = reply_instance.message_id
        ) chat_messages
        order by occurred_at desc, direction desc, row_id desc
        limit $8
    "#
    );
    let (before_at, before_direction, before_id) = cursor
        .as_ref()
        .map(|cursor| {
            (
                Some(cursor.occurred_at),
                cursor.direction.clone(),
                cursor.row_id,
            )
        })
        .unwrap_or((None, "zz".to_string(), i32::MAX));
    let mut values = vec![key.client_id.into(), key.account_id.into()];
    values.extend(target_values);
    values.extend([
        before_at.into(),
        before_direction.into(),
        before_id.into(),
        (CHAT_MESSAGE_PAGE_SIZE + 1).into(),
    ]);
    let mut rows = MessageRow::find_by_statement(
        Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values),
    )
    .all(db)
    .await
    .c(h!())?;
    let has_more = rows.len() > CHAT_MESSAGE_PAGE_SIZE as usize;
    if has_more {
        rows.pop();
    }
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_cursor(&MessageCursor {
                    occurred_at: row.occurred_at,
                    direction: row.direction.clone(),
                    row_id: row.row_id,
                })
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    let inbox_ids = rows
        .iter()
        .filter(|row| row.direction == "in")
        .map(|row| row.row_id)
        .collect::<Vec<_>>();
    let outbox_ids = rows
        .iter()
        .filter_map(|row| row.outbox_message_id)
        .collect::<Vec<_>>();
    let attachments = load_attachments(db, chat_id, &inbox_ids, &outbox_ids)
        .await
        .c(h!())?;
    let reactions = load_reactions(db, &inbox_ids, &rows).await.c(h!())?;
    let unread = unread_ids(
        chat_redis,
        chat_id,
        account_linked_at(db, &key).await.c(h!())?,
    )
    .await;
    let mut messages = rows
        .into_iter()
        .map(|row| {
            let attachment_key = if row.direction == "in" {
                format!("in:{}", row.row_id)
            } else {
                format!("out:{}", row.outbox_message_id.unwrap_or_default())
            };
            let reply = reply_preview(&row);
            ChatMessage {
                id: format!("{}:{}", row.direction, row.row_id),
                inbox_id: (row.direction == "in").then_some(row.row_id),
                outgoing: row.direction == "out",
                sender_name: row.sender_name,
                body: row.body,
                timestamp: row.occurred_at,
                delivery_status: row.delivery_status,
                reply,
                attachments: attachments
                    .get(&attachment_key)
                    .cloned()
                    .unwrap_or_default(),
                reactions: reactions
                    .get(&format!("{}:{}", row.direction, row.row_id))
                    .cloned()
                    .unwrap_or_default(),
                unread: row.direction == "in"
                    && unread.ids.contains(&row.row_id),
            }
        })
        .collect::<Vec<_>>();
    messages.reverse();
    Ok(MessagePage {
        messages,
        next_cursor,
        unread_available: unread.available,
    })
}

async fn message_selection(
    db: &DatabaseConnection,
    key: &ChatKey,
) -> anyhow::Result<(String, Vec<Value>)> {
    let (sql, values) = match key.kind {
        ChatKind::Group => {
            let group_id = key
                .target
                .parse::<i32>()
                .map_err(|_| bad_request("Некоректний чат."))
                .c(h!())?;
            (
                GROUP_MESSAGE_SELECTION,
                vec![group_id.into(), group_id.into()],
            )
        }
        ChatKind::Private => {
            let (sender_ids, recipient_ids) =
                private_participant_ids(db, key).await.c(h!())?;
            (
                PRIVATE_MESSAGE_SELECTION,
                vec![sender_ids.into(), recipient_ids.into()],
            )
        }
    };
    Ok((sql.to_string(), values))
}

async fn private_participant_ids(
    db: &DatabaseConnection,
    key: &ChatKey,
) -> anyhow::Result<(Vec<i32>, Vec<i32>)> {
    #[derive(FromQueryResult)]
    struct ParticipantId {
        direction: String,
        id: i32,
    }
    let rows = ParticipantId::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select 'sender'::text as direction, id from echo_sender
            where account_id = $1 and
                (case when phone_number is not null
                    then 'p:' || regexp_replace(phone_number, '[^0-9+]', '', 'g')
                    else 'u:' || uuid end) = $2
            union all
            select 'recipient', id from echo_recipient
            where account_id = $1 and
                ('p:' || regexp_replace(phone_number, '[^0-9+]', '', 'g')) = $2
            "#,
            [key.account_id.into(), key.target.clone().into()],
        ),
    )
    .all(db)
    .await
    .c(h!())?;
    let mut sender_ids = Vec::new();
    let mut recipient_ids = Vec::new();
    for row in rows {
        if row.direction == "sender" {
            sender_ids.push(row.id);
        } else {
            recipient_ids.push(row.id);
        }
    }
    Ok((sender_ids, recipient_ids))
}

const GROUP_MESSAGE_SELECTION: &str = r#"
    (select 'in'::text as direction, message.id as row_id,
        null::integer as outbox_message_id,
        coalesce(message.timestamp, message.created_at) as occurred_at,
        'received'::text as delivery_status
    from echo_inbox_message message
    where message.client_id = $1 and message.account_id = $2
        and message.group_id = $3 and not message.deleted
        and message.duplicate_of is null
        and ($5::timestamp is null or
            (coalesce(message.timestamp, message.created_at), 'in'::text, message.id) <
            ($5, $6, $7))
    order by coalesce(message.timestamp, message.created_at) desc,
        message.id desc
    limit $8)
    union all
    (select 'out', instance.id, outbox.id,
        coalesce(instance.sent_at, instance.created_at), instance.status::text
    from echo_outbox_message_instance instance
    join echo_outbox_message outbox on outbox.id = instance.message_id
        and outbox.client_id = $1
    where instance.account_id = $2 and instance.group_id = $4
        and ($5::timestamp is null or
            (coalesce(instance.sent_at, instance.created_at), 'out'::text, instance.id) <
            ($5, $6, $7))
    order by coalesce(instance.sent_at, instance.created_at) desc,
        instance.id desc
    limit $8)
"#;

const PRIVATE_MESSAGE_SELECTION: &str = r#"
    (select 'in'::text as direction, message.id as row_id,
        null::integer as outbox_message_id,
        coalesce(message.timestamp, message.created_at) as occurred_at,
        'received'::text as delivery_status
    from unnest($3::integer[]) as sender_item(sender_id)
    cross join lateral (
        select item.id, item.timestamp, item.created_at
        from echo_inbox_message item
        where item.client_id = $1 and item.account_id = $2
            and item.sender_id = sender_item.sender_id and item.group_id is null
            and not item.deleted and item.duplicate_of is null
            and ($5::timestamp is null or
                (coalesce(item.timestamp, item.created_at), 'in'::text, item.id) <
                ($5, $6, $7))
        order by coalesce(item.timestamp, item.created_at) desc, item.id desc
        limit $8
    ) message
    order by coalesce(message.timestamp, message.created_at) desc,
        message.id desc
    limit $8)
    union all
    (select 'out', instance.id, outbox.id,
        coalesce(instance.sent_at, instance.created_at), instance.status::text
    from unnest($4::integer[]) as recipient_item(recipient_id)
    cross join lateral (
        select item.id, item.message_id, item.sent_at, item.created_at, item.status
        from echo_outbox_message_instance item
        where item.account_id = $2
            and item.recipient_id = recipient_item.recipient_id
            and item.group_id is null
            and item.reply_to_inbox_message_id is null
            and ($5::timestamp is null or
                (coalesce(item.sent_at, item.created_at), 'out'::text, item.id) <
                ($5, $6, $7))
        order by coalesce(item.sent_at, item.created_at) desc, item.id desc
        limit $8
    ) instance
    join echo_outbox_message outbox on outbox.id = instance.message_id
        and outbox.client_id = $1
    order by coalesce(instance.sent_at, instance.created_at) desc,
        instance.id desc
    limit $8)
    union all
    (select 'out', instance.id, outbox.id,
        coalesce(instance.sent_at, instance.created_at), instance.status::text
    from echo_outbox_message_instance instance
    join echo_inbox_message reply_in on reply_in.id = instance.reply_to_inbox_message_id
        and reply_in.client_id = $1 and reply_in.account_id = $2
        and reply_in.group_id is null and not reply_in.deleted
        and reply_in.duplicate_of is null
        and reply_in.sender_id = any($3::integer[])
    join echo_outbox_message outbox on outbox.id = instance.message_id
        and outbox.client_id = $1
    where instance.account_id = $2 and instance.group_id is null
        and instance.reply_to_inbox_message_id is not null
        and ($5::timestamp is null or
            (coalesce(instance.sent_at, instance.created_at), 'out'::text, instance.id) <
            ($5, $6, $7))
    order by coalesce(instance.sent_at, instance.created_at) desc,
        instance.id desc
    limit $8)
"#;

pub async fn send(
    db: &DatabaseConnection,
    config: &Config,
    chat_id: &str,
    req: SendReq,
) -> anyhow::Result<QueuedMessage> {
    let key = require_visible_chat(db, chat_id).await.c(h!())?;
    let text = req.text;
    let attachments = validate_attachments(req.attachments).c(h!())?;
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(bad_request("Вкажіть текст або додайте вкладення."));
    }
    let client = enabled_client(db, key.client_id).await.c(h!())?;
    let account = linked_account(db, &key).await.c(h!())?;
    let (group_ids, recipient_phone_numbers) =
        destination(db, &key).await.c(h!())?;
    let txn = db.begin().await.c(h!())?;
    let receipt = echo_im::send_message(
        SendMessageReq {
            text: text.clone(),
            source: message_source(account.source),
            group_ids,
            recipient_phone_numbers,
            attachments,
        },
        &client.name,
        &txn,
        Some(echo_im::types::Config {
            storage_dir: config.chat_storage_dir().to_string(),
        }),
    )
    .await
    .c(h!())?
    .ok_or_else(|| conflict("Обліковий запис не підключено."))
    .c(h!())?;
    txn.commit().await.c(h!())?;
    queued_message(db, &key, receipt, text, None).await.c(h!())
}

pub async fn reply(
    db: &DatabaseConnection,
    config: &Config,
    chat_id: &str,
    req: ReplyReq,
) -> anyhow::Result<QueuedMessage> {
    let key = require_visible_chat(db, chat_id).await.c(h!())?;
    require_inbox_in_chat(db, &key, req.inbox_message_id)
        .await
        .c(h!())?;
    let text = req.text;
    let attachments = validate_attachments(req.attachments).c(h!())?;
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(bad_request("Вкажіть текст або додайте вкладення."));
    }
    let client = enabled_client(db, key.client_id).await.c(h!())?;
    let txn = db.begin().await.c(h!())?;
    let receipt = echo_im::reply_to_inbox_message(
        SendReplyReq {
            echo_inbox_message_id: req.inbox_message_id,
            attachments,
            text: text.clone(),
        },
        &client.name,
        &txn,
        Some(echo_im::types::Config {
            storage_dir: config.chat_storage_dir().to_string(),
        }),
    )
    .await
    .c(h!())?
    .ok_or_else(|| conflict("Обліковий запис не підключено."))
    .c(h!())?;
    txn.commit().await.c(h!())?;
    queued_message(db, &key, receipt, text, Some(req.inbox_message_id))
        .await
        .c(h!())
}

async fn queued_message(
    db: &DatabaseConnection,
    key: &ChatKey,
    receipt: String,
    body: String,
    reply_to_inbox_id: Option<i32>,
) -> anyhow::Result<QueuedMessage> {
    #[derive(FromQueryResult)]
    struct QueuedRow {
        id: i32,
        status: String,
        occurred_at: NaiveDateTime,
    }
    let outbox_id = receipt
        .strip_prefix("id:")
        .ok_or_else(|| conflict("Некоректна квитанція відправлення."))
        .c(h!())?
        .parse::<i32>()
        .map_err(|_| conflict("Некоректна квитанція відправлення."))
        .c(h!())?;
    let (group_id, participant) = chat_target_values(key).c(h!())?;
    let row = QueuedRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        select i.id, i.status::text as status, i.created_at as occurred_at
        from echo_outbox_message_instance i
        left join echo_recipient r on r.id = i.recipient_id
        left join echo_inbox_message reply_in on reply_in.id = i.reply_to_inbox_message_id
        left join echo_sender reply_sender on reply_sender.id = reply_in.sender_id
        where i.message_id = $1 and i.account_id = $2
          and (($3::integer is not null and i.group_id = $3)
            or ($4::text is not null and i.group_id is null and
                (('p:' || regexp_replace(r.phone_number, '[^0-9+]', '', 'g')) = $4
                    or (case when reply_sender.phone_number is not null then 'p:' || regexp_replace(reply_sender.phone_number, '[^0-9+]', '', 'g') else 'u:' || reply_sender.uuid end) = $4)))
        order by i.id desc
        limit 1
        "#,
        [
            outbox_id.into(),
            key.account_id.into(),
            group_id.into(),
            participant.into(),
        ],
    ))
    .one(db)
    .await
    .c(h!())?
    .c(h!())?;
    let chat_id = encode_chat_id(key).c(h!())?;
    let attachments = load_attachments(db, &chat_id, &[], &[outbox_id])
        .await
        .c(h!())?
        .remove(&format!("out:{outbox_id}"))
        .unwrap_or_default();
    let reply = if let Some(inbox_id) = reply_to_inbox_id {
        inbox_reply_preview(db, inbox_id).await.c(h!())?
    } else {
        None
    };
    Ok(QueuedMessage {
        receipt,
        message: ChatMessage {
            id: format!("out:{}", row.id),
            inbox_id: None,
            outgoing: true,
            sender_name: "Я".to_string(),
            body,
            timestamp: row.occurred_at,
            delivery_status: row.status,
            reply,
            attachments,
            reactions: Vec::new(),
            unread: false,
        },
    })
}

async fn inbox_reply_preview(
    db: &DatabaseConnection,
    inbox_id: i32,
) -> anyhow::Result<Option<ReplyPreview>> {
    #[derive(FromQueryResult)]
    struct ReplyRow {
        body: String,
        sender_name: String,
    }
    let row = ReplyRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        select m.body, coalesce(s.name, s.phone_number, s.uuid, 'Невідомий') as sender_name
        from echo_inbox_message m
        left join echo_sender s on s.id = m.sender_id
        where m.id = $1
        "#,
        [inbox_id.into()],
    ))
    .one(db)
    .await
    .c(h!())?;
    Ok(row.map(|row| ReplyPreview {
        id: format!("in:{inbox_id}"),
        sender_name: row.sender_name,
        body: row.body,
    }))
}

pub async fn react(
    db: &DatabaseConnection,
    chat_id: &str,
    req: ReactionReq,
) -> anyhow::Result<()> {
    if !ALLOWED_REACTIONS.contains(&req.code.as_str()) {
        return Err(bad_request("Непідтримувана реакція."));
    }
    let key = require_visible_chat(db, chat_id).await.c(h!())?;
    require_inbox_in_chat(db, &key, req.inbox_message_id)
        .await
        .c(h!())?;
    let client = enabled_client(db, key.client_id).await.c(h!())?;
    let txn = db.begin().await.c(h!())?;
    echo_im::react_to_inbox_message(
        ReactToMessageReq {
            message_internal_id: req.inbox_message_id,
            reaction_code: req.code,
        },
        &client.name,
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub async fn mark_read(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
    chat_id: &str,
    req: MarkReadReq,
    all: bool,
) -> anyhow::Result<()> {
    let key = require_visible_chat(db, chat_id).await.c(h!())?;
    let Some(mut redis) = chat_redis.connection().await else {
        return Err(service_unavailable(
            "Сервіс стану прочитаних повідомлень тимчасово недоступний. Повторіть спробу.",
        ));
    };
    let redis_key =
        unread_key(chat_id, account_linked_at(db, &key).await.c(h!())?);
    let result = if all {
        redis.del::<_, ()>(&redis_key).await
    } else if req.inbox_message_ids.is_empty() {
        Ok(())
    } else {
        redis
            .srem::<_, _, ()>(&redis_key, req.inbox_message_ids)
            .await
    };
    result.map_err(|err| {
        log::warn!("failed to update chat unread state: {err}");
        service_unavailable(
            "Не вдалося оновити стан прочитаних повідомлень. Повторіть спробу.",
        )
    })
}

pub async fn settings(
    db: &DatabaseConnection,
    client_id: i32,
) -> anyhow::Result<SettingsView> {
    enabled_client(db, client_id).await.c(h!())?;
    let settings = settings_row(db, client_id).await.c(h!())?;
    let filters = filter_rows(db, Some(client_id)).await.c(h!())?;
    let mut private_filters = Vec::new();
    let mut group_filters = Vec::new();
    for filter in filters {
        let kind = if filter.chat_kind == "group" {
            ChatKind::Group
        } else {
            ChatKind::Private
        };
        let target = filter
            .participant_key
            .or_else(|| filter.group_id.map(|id| id.to_string()))
            .c(h!())?;
        let id = encode_chat_id(&ChatKey {
            version: 1,
            client_id,
            account_id: filter.account_id,
            kind,
            target,
        })
        .c(h!())?;
        match kind {
            ChatKind::Private => private_filters.push(id),
            ChatKind::Group => group_filters.push(id),
        }
    }
    Ok(SettingsView {
        client_id,
        hide_private: settings.as_ref().is_some_and(|row| row.hide_private),
        hide_groups: settings.as_ref().is_some_and(|row| row.hide_groups),
        private_webhook_configured: settings
            .as_ref()
            .is_some_and(|row| row.private_webhook_url.is_some()),
        group_webhook_configured: settings
            .as_ref()
            .is_some_and(|row| row.group_webhook_url.is_some()),
        store_data_30_days: settings
            .as_ref()
            .is_some_and(|row| row.store_data_30_days),
        private_filters,
        group_filters,
    })
}

pub async fn save_settings(
    db: &DatabaseConnection,
    client_id: i32,
    req: SaveSettingsReq,
) -> anyhow::Result<SettingsView> {
    let client = enabled_client(db, client_id).await.c(h!())?;
    let private_filters =
        decode_filter_ids(client_id, ChatKind::Private, &req.private_filters)
            .c(h!())?;
    let group_filters =
        decode_filter_ids(client_id, ChatKind::Group, &req.group_filters)
            .c(h!())?;
    validate_filter_keys(db, &private_filters).await.c(h!())?;
    validate_filter_keys(db, &group_filters).await.c(h!())?;
    validate_webhook_update(&req.private_webhook)
        .await
        .c(h!())?;
    validate_webhook_update(&req.group_webhook).await.c(h!())?;
    let current = settings_row(db, client_id).await.c(h!())?;
    let private_webhook_url = apply_webhook_update(
        current
            .as_ref()
            .and_then(|row| row.private_webhook_url.clone()),
        req.private_webhook,
    );
    let group_webhook_url = apply_webhook_update(
        current
            .as_ref()
            .and_then(|row| row.group_webhook_url.clone()),
        req.group_webhook,
    );
    let txn = db.begin().await.c(h!())?;
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            insert into echo_client_settings (
                client_id, hide_private, hide_groups, private_webhook_url,
                group_webhook_url, store_data_30_days
            ) values ($1, $2, $3, $4, $5, $6)
            on conflict (client_id) do update set
                hide_private = excluded.hide_private,
                hide_groups = excluded.hide_groups,
                private_webhook_url = excluded.private_webhook_url,
                group_webhook_url = excluded.group_webhook_url,
                store_data_30_days = excluded.store_data_30_days,
                updated_at = now() at time zone 'utc'
        "#,
        [
            client_id.into(),
            req.hide_private.into(),
            req.hide_groups.into(),
            private_webhook_url.into(),
            group_webhook_url.into(),
            req.store_data_30_days.into(),
        ],
    ))
    .await
    .c(h!())?;
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from echo_chat_filter where client_id = $1",
        [client_id.into()],
    ))
    .await
    .c(h!())?;
    for key in private_filters.into_iter().chain(group_filters) {
        let (participant, group_id) = match key.kind {
            ChatKind::Private => (Some(key.target), None),
            ChatKind::Group => (None, key.target.parse::<i32>().ok()),
        };
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into echo_chat_filter (client_id, account_id, chat_kind, participant_key, group_id) values ($1, $2, $3, $4, $5)",
            [client_id.into(), key.account_id.into(), key.kind.as_str().into(), participant.into(), group_id.into()],
        ))
        .await
        .c(h!())?;
    }
    echo_im::store_messenger_data(client_id, req.store_data_30_days, &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    if let Err(err) = echo_im::restart_client(db, client.id).await {
        log::warn!(
            "chat settings were saved but client {} could not be restarted: {err:#}",
            client.name
        );
        return Err(service_unavailable(
            "Налаштування збережено, але воркер клієнта не перезапущено. Повторно збережіть налаштування, щоб безпечно повторити перезапуск.",
        ));
    }
    settings(db, client_id).await.c(h!())
}

pub async fn attachment(
    db: &DatabaseConnection,
    chat_id: &str,
    direction: &str,
    id: i32,
) -> anyhow::Result<(Vec<u8>, String, String, bool)> {
    let key = require_visible_chat(db, chat_id).await.c(h!())?;
    #[derive(FromQueryResult)]
    struct FileRow {
        path: Option<String>,
        content_base64: Option<String>,
        name: Option<String>,
        extension: Option<String>,
    }
    let (group_id, participant) = chat_target_values(&key).c(h!())?;
    let (sql, values) = if direction == "in" {
        (
            r#"
                select a.path, null::text as content_base64, a.name, null::text as extension
                from echo_attachment a
                join echo_inbox_message m on m.id = a.message_id
                join echo_client c on c.id = m.client_id and not c.deleted and c.show_chats_admin_panel = true
                join echo_client_lock l on l.client_id = c.id and l.account_id = m.account_id and not l.remove_requested
                left join echo_sender s on s.id = m.sender_id
                where a.id = $1 and m.client_id = $2 and m.account_id = $3
                  and (($4::integer is not null and m.group_id = $4)
                    or ($5::text is not null and m.group_id is null and
                        (case when s.phone_number is not null then 'p:' || regexp_replace(s.phone_number, '[^0-9+]', '', 'g') else 'u:' || s.uuid end) = $5))
            "#,
            vec![
                id.into(),
                key.client_id.into(),
                key.account_id.into(),
                group_id.into(),
                participant.into(),
            ],
        )
    } else if direction == "out" {
        (
            r#"
                select a.path, a.content_base64, null::text as name, a.extension
                from echo_outbox_message_attachment a
                join echo_outbox_message m on m.id = a.message_id
                join echo_client c on c.id = m.client_id and not c.deleted and c.show_chats_admin_panel = true
                where a.id = $1 and m.client_id = $2 and exists (
                    select 1 from echo_outbox_message_instance i
                    left join echo_recipient r on r.id = i.recipient_id
                    left join echo_inbox_message reply_in on reply_in.id = i.reply_to_inbox_message_id
                    left join echo_sender reply_sender on reply_sender.id = reply_in.sender_id
                    join echo_client_lock l on l.client_id = c.id and l.account_id = i.account_id and not l.remove_requested
                    where i.message_id = m.id and i.account_id = $3
                      and (($4::integer is not null and i.group_id = $4)
                        or ($5::text is not null and i.group_id is null and
                            (('p:' || regexp_replace(r.phone_number, '[^0-9+]', '', 'g')) = $5
                                or (case when reply_sender.phone_number is not null then 'p:' || regexp_replace(reply_sender.phone_number, '[^0-9+]', '', 'g') else 'u:' || reply_sender.uuid end) = $5)))
                )
            "#,
            vec![
                id.into(),
                key.client_id.into(),
                key.account_id.into(),
                group_id.into(),
                participant.into(),
            ],
        )
    } else {
        return Err(not_found("Вкладення не знайдено."));
    };
    let file = FileRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .one(db)
    .await
    .c(h!())?
    .ok_or_else(|| not_found("Вкладення не знайдено."))
    .c(h!())?;
    let bytes = read_attachment_bytes(file.path, file.content_base64)
        .await
        .c(h!())?;
    let filename = file.name.unwrap_or_else(|| {
        format!(
            "attachment-{}.{}",
            id,
            file.extension.unwrap_or_else(|| "bin".to_string())
        )
    });
    let content_type = content_type_for_name(&filename).to_string();
    let inline = content_type.starts_with("image/")
        || content_type.starts_with("video/")
        || content_type.starts_with("audio/")
        || content_type == "application/pdf";
    Ok((bytes, filename, content_type, inline))
}

async fn read_attachment_bytes(
    path: Option<String>,
    content_base64: Option<String>,
) -> anyhow::Result<Vec<u8>> {
    if let Some(path) = path {
        match tokio::fs::read(path).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).c(h!()),
        }
    }
    if let Some(content) = content_base64 {
        return general_purpose::STANDARD.decode(content).c(h!());
    }
    Err(not_found("Файл вкладення відсутній."))
}

pub async fn ingestion_tick(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
) -> anyhow::Result<()> {
    let Some(mut redis) = chat_redis.connection().await else {
        return Ok(());
    };
    let scopes = AccountScope::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        r#"
            select c.id as client_id, a.id as account_id, a.linked_at
            from echo_client c
            join echo_client_lock l on l.client_id = c.id and not l.remove_requested
            join echo_account a on a.id = l.account_id and a.is_linked
            where not c.deleted and c.show_chats_admin_panel = true
        "#,
    ))
    .all(db)
    .await
    .c(h!())?;
    let visibility = Visibility::load(db).await.c(h!())?;
    for scope in scopes {
        if let Err(err) = ingest_account(
            db,
            &mut redis,
            &visibility,
            scope.client_id,
            scope.account_id,
            scope.linked_at,
        )
        .await
        {
            log::warn!("failed to ingest chat messages: {err:#}");
        }
    }
    Ok(())
}

pub async fn prune_unread(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
) -> anyhow::Result<()> {
    let Some(mut redis) = chat_redis.connection().await else {
        return Ok(());
    };
    let (next_cursor, keys) = redis::cmd("SCAN")
        .arg(chat_redis.cleanup_cursor())
        .arg("MATCH")
        .arg("echo-messengers:chats:v1:*:unread")
        .arg("COUNT")
        .arg(100)
        .query_async::<(u64, Vec<String>)>(&mut redis)
        .await
        .c(h!())?;
    if keys.is_empty() {
        chat_redis.set_cleanup_cursor(next_cursor);
        return Ok(());
    }
    let mut ids_by_key = HashMap::<String, HashSet<i32>>::new();
    let mut all_ids = HashSet::new();
    for key in keys {
        let ids = redis.smembers::<_, HashSet<i32>>(&key).await.c(h!())?;
        all_ids.extend(ids.iter().copied());
        ids_by_key.insert(key, ids);
    }
    let existing = if all_ids.is_empty() {
        HashSet::new()
    } else {
        db.query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select id from echo_inbox_message where id = any($1::integer[]) and not deleted and duplicate_of is null",
            [all_ids.into_iter().collect::<Vec<_>>().into()],
        ))
        .await
        .c(h!())?
        .into_iter()
        .map(|row| row.try_get::<i32>("", "id").c(h!()))
        .collect::<anyhow::Result<HashSet<_>>>()
        .c(h!())?
    };
    let mut pipe = redis::pipe();
    let mut command_count = 0;
    for (key, ids) in ids_by_key {
        let missing = ids.difference(&existing).copied().collect::<Vec<_>>();
        if !missing.is_empty() {
            pipe.cmd("SREM").arg(key).arg(missing);
            command_count += 1;
        }
    }
    if command_count > 0 {
        pipe.query_async::<Vec<usize>>(&mut redis).await.c(h!())?;
    }
    chat_redis.set_cleanup_cursor(next_cursor);
    Ok(())
}

pub async fn cleanup_webhook_deliveries(
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        delete from echo_chat_webhook_delivery
        where id = any(array(
            select id
            from echo_chat_webhook_delivery
            where (delivered_at is not null or failed_at is not null)
                and coalesce(delivered_at, failed_at) <
                    (now() at time zone 'utc') - make_interval(days => $1)
            order by coalesce(delivered_at, failed_at), id
            limit $2
        ))
        "#,
        [
            CHAT_WEBHOOK_HISTORY_RETENTION_DAYS.into(),
            CHAT_WEBHOOK_CLEANUP_BATCH_SIZE.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

#[derive(Debug, FromQueryResult)]
struct IngestMessage {
    id: i32,
    group_id: Option<i32>,
    participant_key: Option<String>,
    sender_name: String,
    body: String,
    occurred_at: NaiveDateTime,
    reply_direction: Option<String>,
    reply_row_id: Option<i32>,
    reply_sender_name: Option<String>,
    reply_text: Option<String>,
}

async fn ingest_account(
    db: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    visibility: &Visibility,
    client_id: i32,
    account_id: i32,
    linked_at: Option<NaiveDateTime>,
) -> anyhow::Result<()> {
    #[derive(FromQueryResult)]
    struct StateRow {
        linked_at: Option<NaiveDateTime>,
        last_inbox_message_id: i32,
    }
    let state = StateRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select linked_at, last_inbox_message_id from echo_chat_ingestion_state where client_id = $1 and account_id = $2",
        [client_id.into(), account_id.into()],
    ))
    .one(db)
    .await
    .c(h!())?;
    let state = match state {
        Some(state) if state.linked_at == linked_at => state,
        _ => {
            let last_inbox_message_id =
                initial_ingestion_id(db, client_id, account_id, linked_at)
                    .await
                    .c(h!())?;
            upsert_ingestion_state(
                db,
                client_id,
                account_id,
                linked_at,
                last_inbox_message_id,
            )
            .await
            .c(h!())?;
            StateRow {
                linked_at,
                last_inbox_message_id,
            }
        }
    };
    let messages = IngestMessage::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            select m.id, m.group_id,
                case when m.group_id is null then
                    case when s.phone_number is not null then 'p:' || regexp_replace(s.phone_number, '[^0-9+]', '', 'g') else 'u:' || s.uuid end
                end as participant_key,
                coalesce(s.name, s.phone_number, s.uuid, 'Невідомий') as sender_name,
                m.body, coalesce(m.timestamp, m.created_at) as occurred_at,
                case when reply_in.id is not null then 'in' when reply_instance.id is not null then 'out' end as reply_direction,
                coalesce(reply_in.id, reply_instance.id) as reply_row_id,
                case when reply_in.id is not null then coalesce(reply_sender.name, reply_sender.phone_number, reply_sender.uuid, 'Невідомий')
                    when reply_instance.id is not null then 'Я' end as reply_sender_name,
                coalesce(reply_in.body, reply_out.body) as reply_text
            from echo_inbox_message m
            left join echo_sender s on s.id = m.sender_id
            left join echo_inbox_message reply_in on reply_in.id = m.reply_to_inbox_message_id
            left join echo_sender reply_sender on reply_sender.id = reply_in.sender_id
            left join echo_outbox_message_instance reply_instance on reply_instance.id = m.reply_to_outbox_message_id
            left join echo_outbox_message reply_out on reply_out.id = reply_instance.message_id
            where m.client_id = $1 and m.account_id = $2 and m.id > $3
                and not m.deleted and m.duplicate_of is null
            order by m.id
            limit 500
        "#,
        [client_id.into(), account_id.into(), state.last_inbox_message_id.into()],
    ))
    .all(db)
    .await
    .c(h!())?;
    let mut last_id = state.last_inbox_message_id;
    for message in messages {
        last_id = last_id.max(message.id);
        let key = if let Some(group_id) = message.group_id {
            ChatKey {
                version: 1,
                client_id,
                account_id,
                kind: ChatKind::Group,
                target: group_id.to_string(),
            }
        } else if let Some(participant) = message.participant_key.clone() {
            ChatKey {
                version: 1,
                client_id,
                account_id,
                kind: ChatKind::Private,
                target: participant,
            }
        } else {
            continue;
        };
        if !visibility.allows(&key) {
            continue;
        }
        let chat_id = encode_chat_id(&key).c(h!())?;
        let redis_key = unread_key(&chat_id, linked_at);
        redis::pipe()
            .atomic()
            .cmd("SADD")
            .arg(&redis_key)
            .arg(message.id)
            .ignore()
            .cmd("EXPIRE")
            .arg(&redis_key)
            .arg(CHAT_UNREAD_KEY_TTL_DAYS * 24 * 60 * 60)
            .ignore()
            .query_async::<()>(&mut *redis)
            .await
            .c(h!())?;
        enqueue_webhook(db, visibility, &key, &message)
            .await
            .c(h!())?;
    }
    if last_id != state.last_inbox_message_id {
        upsert_ingestion_state(db, client_id, account_id, linked_at, last_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn initial_ingestion_id(
    db: &DatabaseConnection,
    client_id: i32,
    account_id: i32,
    linked_at: Option<NaiveDateTime>,
) -> anyhow::Result<i32> {
    let Some(linked_at) = linked_at else {
        return Ok(0);
    };
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            select coalesce(max(id), 0) as initial_id
            from echo_inbox_message
            where client_id = $1 and account_id = $2
                and created_at < $3
        "#,
        [client_id.into(), account_id.into(), linked_at.into()],
    ))
    .await
    .c(h!())?
    .map(|row| row.try_get::<i32>("", "initial_id"))
    .transpose()
    .c(h!())
    .map(|id| id.unwrap_or_default())
}

async fn upsert_ingestion_state(
    db: &DatabaseConnection,
    client_id: i32,
    account_id: i32,
    linked_at: Option<NaiveDateTime>,
    last_id: i32,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            insert into echo_chat_ingestion_state (client_id, account_id, linked_at, last_inbox_message_id)
            values ($1, $2, $3, $4)
            on conflict (client_id, account_id) do update set linked_at = excluded.linked_at,
                last_inbox_message_id = excluded.last_inbox_message_id,
                updated_at = now() at time zone 'utc'
        "#,
        [client_id.into(), account_id.into(), linked_at.into(), last_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn enqueue_webhook(
    db: &DatabaseConnection,
    visibility: &Visibility,
    key: &ChatKey,
    message: &IngestMessage,
) -> anyhow::Result<()> {
    let Some(settings) = visibility.settings.get(&key.client_id) else {
        return Ok(());
    };
    let endpoint = match key.kind {
        ChatKind::Private => settings.private_webhook_url.as_ref(),
        ChatKind::Group => settings.group_webhook_url.as_ref(),
    };
    let Some(endpoint) = endpoint else {
        return Ok(());
    };
    let event_id = format!(
        "echo-chat-message:v1:{}:{}:{}",
        key.client_id, key.account_id, message.id
    );
    let chat_id = encode_chat_id(key).c(h!())?;
    let attachments = load_attachments(db, &chat_id, &[message.id], &[])
        .await
        .c(h!())?
        .remove(&format!("in:{}", message.id))
        .unwrap_or_default();
    let reactions = load_reactions(db, &[message.id], &[])
        .await
        .c(h!())?
        .remove(&format!("in:{}", message.id))
        .unwrap_or_default();
    let chat_message = ChatMessage {
        id: format!("in:{}", message.id),
        inbox_id: Some(message.id),
        outgoing: false,
        sender_name: message.sender_name.clone(),
        body: message.body.clone(),
        timestamp: message.occurred_at,
        delivery_status: "received".to_string(),
        reply: ingest_reply_preview(message),
        attachments,
        reactions,
        unread: true,
    };
    let payload = json!({
        "version": 1,
        "eventId": event_id,
        "chatId": chat_id,
        "message": chat_message
    });
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            insert into echo_chat_webhook_delivery
                (event_id, client_id, inbox_message_id, endpoint_url, payload)
            values ($1, $2, $3, $4, $5)
            on conflict (client_id, inbox_message_id) do nothing
        "#,
        [
            event_id.into(),
            key.client_id.into(),
            message.id.into(),
            endpoint.clone().into(),
            payload.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

struct WebhookTarget {
    url: reqwest::Url,
    hostname: Option<String>,
    addresses: Vec<SocketAddr>,
}

async fn resolve_webhook(url: &str) -> anyhow::Result<WebhookTarget> {
    let url = validate_webhook_url(url).c(h!())?;
    let host = url
        .host_str()
        .map(normalize_webhook_host)
        .ok_or_else(|| bad_request("Некоректна URL-адреса webhook."))
        .c(h!())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| bad_request("Некоректна URL-адреса webhook."))
        .c(h!())?;
    let addresses =
        await_webhook_lookup(tokio::net::lookup_host((host.as_str(), port)))
            .await
            .c(h!())?
            .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses.iter().any(|address| !is_public_ip(address.ip()))
    {
        return Err(bad_request(
            "Webhook повинен вести лише на публічні IP-адреси.",
        ));
    }
    Ok(WebhookTarget {
        url,
        hostname: host.parse::<IpAddr>().is_err().then_some(host),
        addresses,
    })
}

fn validate_webhook_url(url: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(url.trim())
        .map_err(|_| bad_request("Некоректна URL-адреса webhook."))
        .c(h!())?;
    let public_literal = url
        .host_str()
        .map(normalize_webhook_host)
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_none_or(is_public_ip);
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !public_literal
    {
        return Err(bad_request(
            "Webhook повинен використовувати HTTPS без облікових даних або приватних IP-адрес.",
        ));
    }
    Ok(url)
}

fn normalize_webhook_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
}

async fn await_webhook_lookup<T>(
    lookup: impl Future<Output = std::io::Result<T>>,
) -> anyhow::Result<T> {
    tokio::time::timeout(
        Duration::from_secs(CHAT_WEBHOOK_REQUEST_TIMEOUT_SECS),
        lookup,
    )
    .await
    .map_err(|_| bad_request("Не вдалося вчасно перевірити адресу webhook."))
    .c(h!())?
    .map_err(|_| bad_request("Не вдалося знайти адресу сервера webhook."))
    .c(h!())
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map_or_else(|| is_public_ipv6(address), is_public_ipv4),
    }
}

fn is_public_ipv4(address: std::net::Ipv4Addr) -> bool {
    let [first, second, third, fourth] = address.octets();
    first != 0
        && !address.is_private()
        && !(first == 100 && second & 0xc0 == 0x40)
        && !address.is_loopback()
        && !address.is_link_local()
        && !(first == 192
            && second == 0
            && third == 0
            && fourth != 9
            && fourth != 10)
        && !(first == 192 && second == 88 && third == 99)
        && !address.is_documentation()
        && !(first == 198 && second & 0xfe == 18)
        && first < 224
}

fn is_public_ipv6(address: std::net::Ipv6Addr) -> bool {
    let segments = address.segments();
    if let [0x0064, 0xff9b, 0, 0, 0, 0, high, low] = segments {
        return is_public_ipv4(std::net::Ipv4Addr::new(
            (high >> 8) as u8,
            high as u8,
            (low >> 8) as u8,
            low as u8,
        ));
    }
    let [first, second, third, ..] = segments;
    if first == 0x2001 && second < 0x0200 {
        return matches!(segments, [0x2001, 1, 0, 0, 0, 0, 0, 1..=3])
            || second == 3
            || (second == 4 && third == 0x0112)
            || (0x0020..=0x003f).contains(&second);
    }
    (0x2000..=0x3fff).contains(&first)
        && first != 0x2002
        && !(first == 0x2001 && second == 0x0db8)
        && !(first == 0x3fff && second < 0x1000)
}

async fn deliver_webhook(
    endpoint_url: &str,
    payload: &serde_json::Value,
) -> anyhow::Result<reqwest::Response> {
    let target = resolve_webhook(endpoint_url).await.c(h!())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CHAT_WEBHOOK_REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none());
    let client = if let Some(hostname) = target.hostname.as_deref() {
        client.resolve_to_addrs(hostname, &target.addresses)
    } else {
        client
    }
    .build()
    .c(h!())?;
    client.post(target.url).json(payload).send().await.c(h!())
}

#[derive(FromQueryResult)]
struct WebhookDelivery {
    id: i64,
    endpoint_url: String,
    payload: serde_json::Value,
    attempts: i32,
}

pub async fn webhook_tick(db: &DatabaseConnection) -> anyhow::Result<()> {
    let deliveries = WebhookDelivery::find_by_statement(
        Statement::from_string(
            DatabaseBackend::Postgres,
            format!(
                "select id, endpoint_url, payload, attempts from echo_chat_webhook_delivery where delivered_at is null and failed_at is null and attempts < {CHAT_WEBHOOK_MAX_ATTEMPTS} and next_attempt_at <= now() at time zone 'utc' order by next_attempt_at, id limit {CHAT_WEBHOOK_BATCH_SIZE}"
            ),
        ),
    )
    .all(db)
    .await
    .c(h!())?;
    for delivery in deliveries {
        deliver_webhook_delivery(db, delivery).await.c(h!())?;
    }
    Ok(())
}

async fn deliver_webhook_delivery(
    db: &DatabaseConnection,
    delivery: WebhookDelivery,
) -> anyhow::Result<()> {
    let result =
        deliver_webhook(&delivery.endpoint_url, &delivery.payload).await;
    match result {
        Ok(response) if response.status().is_success() => {
            db.execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "update echo_chat_webhook_delivery set delivered_at = now() at time zone 'utc', updated_at = now() at time zone 'utc', last_error = null where id = $1",
                [delivery.id.into()],
            )).await.c(h!())?;
        }
        result => {
            let error = match result {
                Ok(response) => format!("HTTP {}", response.status()),
                Err(_) => "network request failed".to_string(),
            };
            let attempts = delivery.attempts + 1;
            let backoff = 2_i64.pow(attempts.min(8) as u32).min(300);
            let terminal = attempts >= CHAT_WEBHOOK_MAX_ATTEMPTS;
            db.execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "update echo_chat_webhook_delivery set attempts = $2, next_attempt_at = (now() at time zone 'utc') + make_interval(secs => $3), last_error = $4, failed_at = case when $5 then now() at time zone 'utc' else null end, updated_at = now() at time zone 'utc' where id = $1",
                [delivery.id.into(), attempts.into(), backoff.into(), error.into(), terminal.into()],
            )).await.c(h!())?;
            if terminal {
                log::warn!(
                    "chat webhook delivery {} reached the terminal retry limit",
                    delivery.id
                );
            }
        }
    }
    Ok(())
}

struct Visibility {
    settings: HashMap<i32, SettingsRow>,
    filters: HashSet<(i32, i32, ChatKind, String)>,
}

impl Visibility {
    async fn load(db: &DatabaseConnection) -> anyhow::Result<Self> {
        let settings = SettingsRow::find_by_statement(Statement::from_string(
            DatabaseBackend::Postgres,
            "select client_id, hide_private, hide_groups, private_webhook_url, group_webhook_url, store_data_30_days from echo_client_settings",
        )).all(db).await.c(h!())?.into_iter().map(|row| (row.client_id, row)).collect();
        let filters = filter_rows(db, None)
            .await
            .c(h!())?
            .into_iter()
            .filter_map(|row| {
                let kind = if row.chat_kind == "group" {
                    ChatKind::Group
                } else {
                    ChatKind::Private
                };
                let target = row
                    .participant_key
                    .or_else(|| row.group_id.map(|id| id.to_string()))?;
                Some((row.client_id, row.account_id, kind, target))
            })
            .collect();
        Ok(Self { settings, filters })
    }

    fn allows(&self, key: &ChatKey) -> bool {
        let selected = self.filters.contains(&(
            key.client_id,
            key.account_id,
            key.kind,
            key.target.clone(),
        ));
        let hide_all =
            self.settings
                .get(&key.client_id)
                .is_some_and(|settings| match key.kind {
                    ChatKind::Private => settings.hide_private,
                    ChatKind::Group => settings.hide_groups,
                });
        if hide_all {
            selected
        } else {
            !selected
        }
    }
}

async fn require_visible_chat(
    db: &DatabaseConnection,
    id: &str,
) -> anyhow::Result<ChatKey> {
    let key = decode_chat_id(id).c(h!())?;
    enabled_client(db, key.client_id).await.c(h!())?;
    linked_account(db, &key).await.c(h!())?;
    if !Visibility::load(db).await.c(h!())?.allows(&key) {
        return Err(not_found("Чат не знайдено."));
    }
    require_chat_target(db, &key).await.c(h!())?;
    Ok(key)
}

async fn require_chat_target(
    db: &DatabaseConnection,
    key: &ChatKey,
) -> anyhow::Result<()> {
    match key.kind {
        ChatKind::Group => {
            let group_id = key
                .target
                .parse::<i32>()
                .map_err(|_| bad_request("Некоректний чат."))
                .c(h!())?;
            echo_group::Entity::find_by_id(group_id)
                .filter(echo_group::Column::AccountId.eq(key.account_id))
                .filter(echo_group::Column::DeletedByMessanger.eq(false))
                .one(db)
                .await
                .c(h!())?
                .ok_or_else(|| not_found("Чат не знайдено."))
                .c(h!())?;
        }
        ChatKind::Private => {
            if !(key.target.starts_with("p:") || key.target.starts_with("u:")) {
                return Err(bad_request("Некоректний чат."));
            }
            let row = db
                .query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    r#"
                    select exists (
                        select 1 from echo_sender s
                        where s.account_id = $1 and
                            (case when s.phone_number is not null
                                then 'p:' || regexp_replace(s.phone_number, '[^0-9+]', '', 'g')
                                else 'u:' || s.uuid end) = $2
                        union all
                        select 1 from echo_recipient r
                        where r.account_id = $1 and
                            ('p:' || regexp_replace(r.phone_number, '[^0-9+]', '', 'g')) = $2
                    ) as found
                    "#,
                    [key.account_id.into(), key.target.clone().into()],
                ))
                .await
                .c(h!())?
                .c(h!())?;
            if !row.try_get::<bool>("", "found").c(h!())? {
                return Err(not_found("Чат не знайдено."));
            }
        }
    }
    Ok(())
}

async fn enabled_client(
    db: &DatabaseConnection,
    id: i32,
) -> anyhow::Result<echo_client::Model> {
    echo_client::Entity::find_by_id(id)
        .filter(echo_client::Column::Deleted.eq(false))
        .filter(echo_client::Column::ShowChatsAdminPanel.eq(true))
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(|| not_found("Клієнт чатів не знайдений."))
}

async fn linked_account(
    db: &DatabaseConnection,
    key: &ChatKey,
) -> anyhow::Result<echo_account::Model> {
    let sql = r#"
        select a.* from echo_account a
        join echo_client_lock l on l.account_id = a.id
        where a.id = $1 and l.client_id = $2 and not l.remove_requested and a.is_linked
    "#;
    echo_account::Model::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [key.account_id.into(), key.client_id.into()],
    ))
    .one(db)
    .await
    .c(h!())?
    .ok_or_else(|| conflict("Обліковий запис не підключено."))
}

async fn account_linked_at(
    db: &DatabaseConnection,
    key: &ChatKey,
) -> anyhow::Result<Option<NaiveDateTime>> {
    Ok(linked_account(db, key).await.c(h!())?.linked_at)
}

async fn destination(
    db: &DatabaseConnection,
    key: &ChatKey,
) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    match key.kind {
        ChatKind::Group => {
            let id = key
                .target
                .parse::<i32>()
                .map_err(|_| bad_request("Некоректний чат."))
                .c(h!())?;
            let group = echo_group::Entity::find_by_id(id)
                .filter(echo_group::Column::AccountId.eq(key.account_id))
                .one(db)
                .await
                .c(h!())?
                .ok_or_else(|| not_found("Групу не знайдено."))
                .c(h!())?;
            Ok((vec![group.group_id], vec![]))
        }
        ChatKind::Private => {
            let phone = key
                .target
                .strip_prefix("p:")
                .ok_or_else(|| {
                    conflict(
                        "Неможливо надіслати повідомлення контакту без номера телефону.",
                    )
                })
                .c(h!())?;
            Ok((vec![], vec![phone.to_string()]))
        }
    }
}

async fn require_inbox_in_chat(
    db: &DatabaseConnection,
    key: &ChatKey,
    id: i32,
) -> anyhow::Result<()> {
    let message = echo_inbox_message::Entity::find_by_id(id)
        .filter(echo_inbox_message::Column::Deleted.eq(false))
        .filter(echo_inbox_message::Column::DuplicateOf.is_null())
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(|| not_found("Повідомлення не знайдено."))
        .c(h!())?;
    if message.client_id != Some(key.client_id)
        || message.account_id != key.account_id
    {
        return Err(not_found("Повідомлення не знайдено."));
    }
    let matches = match key.kind {
        ChatKind::Group => {
            message.group_id.map(|id| id.to_string()).as_deref()
                == Some(key.target.as_str())
        }
        ChatKind::Private => {
            if message.group_id.is_some() {
                false
            } else {
                let sender = db.query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "select case when phone_number is not null then 'p:' || regexp_replace(phone_number, '[^0-9+]', '', 'g') else 'u:' || uuid end as participant from echo_sender where id = $1",
                    [message.sender_id.into()],
                )).await.c(h!())?;
                sender
                    .and_then(|row| {
                        row.try_get::<String>("", "participant").ok()
                    })
                    .as_deref()
                    == Some(key.target.as_str())
            }
        }
    };
    if !matches {
        return Err(not_found("Повідомлення не знайдено."));
    }
    Ok(())
}

async fn validate_filter_keys(
    db: &DatabaseConnection,
    keys: &[ChatKey],
) -> anyhow::Result<()> {
    for key in keys {
        linked_account(db, key).await.c(h!())?;
        require_chat_target(db, key).await.c(h!())?;
    }
    Ok(())
}

fn validate_attachments(
    inputs: Vec<AttachmentInput>,
) -> anyhow::Result<Vec<OutboxAttachmentInput>> {
    if inputs.len() > CHAT_ATTACHMENT_MAX_COUNT {
        return Err(bad_request(
            "До повідомлення можна додати не більше 10 файлів.",
        ));
    }
    let mut total_bytes = 0;
    inputs
        .into_iter()
        .map(|input| {
            let bytes = general_purpose::STANDARD
                .decode(&input.content_base64)
                .c(h!())?;
            if bytes.len() > CHAT_ATTACHMENT_MAX_BYTES {
                return Err(bad_request("Вкладення перевищує 25 МБ."));
            }
            total_bytes += bytes.len();
            if total_bytes > CHAT_ATTACHMENTS_TOTAL_MAX_BYTES {
                return Err(bad_request(
                    "Загальний розмір вкладень перевищує 100 МБ.",
                ));
            }
            let extension = input
                .filename
                .as_deref()
                .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext))
                .filter(|ext| {
                    !ext.is_empty()
                        && ext.len() <= 12
                        && ext.chars().all(|c| c.is_ascii_alphanumeric())
                })
                .map(|ext| ext.to_ascii_lowercase());
            Ok(OutboxAttachmentInput {
                content_base64: input.content_base64,
                extension,
            })
        })
        .collect()
}

fn message_source(source: EchoMessageSource) -> MessageSource {
    match source {
        EchoMessageSource::Signal => MessageSource::Signal,
        EchoMessageSource::Whatsapp => MessageSource::Whatsapp,
    }
}

fn chat_key_from_row(row: &ChatRow) -> anyhow::Result<ChatKey> {
    let kind = parse_chat_kind(&row.kind).c(h!())?;
    Ok(ChatKey {
        version: 1,
        client_id: row.client_id,
        account_id: row.account_id,
        kind,
        target: row.target.clone(),
    })
}

fn parse_chat_kind(kind: &str) -> anyhow::Result<ChatKind> {
    match kind {
        "group" => Ok(ChatKind::Group),
        "private" => Ok(ChatKind::Private),
        _ => Err(bad_request("Некоректний тип чату.")),
    }
}

fn option_order(
    left: &FilterOption,
    right: &FilterOption,
) -> std::cmp::Ordering {
    left.title
        .to_lowercase()
        .cmp(&right.title.to_lowercase())
        .then_with(|| left.account_label.cmp(&right.account_label))
        .then_with(|| left.id.cmp(&right.id))
}

fn encode_chat_id(key: &ChatKey) -> anyhow::Result<String> {
    Ok(general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(key).c(h!())?))
}

fn decode_chat_id(id: &str) -> anyhow::Result<ChatKey> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| bad_request("Некоректний ідентифікатор чату."))
        .c(h!())?;
    let key: ChatKey = serde_json::from_slice(&bytes)
        .map_err(|_| bad_request("Некоректний ідентифікатор чату."))
        .c(h!())?;
    if key.version != 1 {
        return Err(bad_request("Непідтримувана версія ідентифікатора чату."));
    }
    Ok(key)
}

fn encode_cursor(cursor: &MessageCursor) -> anyhow::Result<String> {
    Ok(general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(cursor).c(h!())?))
}

fn decode_cursor(cursor: &str) -> anyhow::Result<MessageCursor> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| bad_request("Некоректний курсор."))
        .c(h!())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| bad_request("Некоректний курсор."))
}

fn encode_chat_list_cursor(cursor: &ChatListCursor) -> anyhow::Result<String> {
    Ok(general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(cursor).c(h!())?))
}

fn decode_chat_list_cursor(cursor: &str) -> anyhow::Result<ChatListCursor> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| bad_request("Некоректний курсор списку чатів."))
        .c(h!())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| bad_request("Некоректний курсор списку чатів."))
}

fn chat_target_values(
    key: &ChatKey,
) -> anyhow::Result<(Option<i32>, Option<String>)> {
    match key.kind {
        ChatKind::Group => Ok((
            Some(
                key.target
                    .parse::<i32>()
                    .map_err(|_| bad_request("Некоректний чат."))
                    .c(h!())?,
            ),
            None,
        )),
        ChatKind::Private => Ok((None, Some(key.target.clone()))),
    }
}

fn reply_preview(row: &MessageRow) -> Option<ReplyPreview> {
    Some(ReplyPreview {
        id: format!(
            "{}:{}",
            row.reply_direction.as_deref()?,
            row.reply_row_id?
        ),
        sender_name: row.reply_sender_name.clone()?,
        body: row.reply_text.clone()?,
    })
}

fn ingest_reply_preview(message: &IngestMessage) -> Option<ReplyPreview> {
    Some(ReplyPreview {
        id: format!(
            "{}:{}",
            message.reply_direction.as_deref()?,
            message.reply_row_id?
        ),
        sender_name: message.reply_sender_name.clone()?,
        body: message.reply_text.clone()?,
    })
}

fn account_color(client_id: i32, account_id: i32) -> &'static str {
    let index = (client_id as i64 * 31 + account_id as i64).unsigned_abs()
        as usize
        % ACCOUNT_COLORS.len();
    ACCOUNT_COLORS[index]
}

fn unread_key(chat_id: &str, linked_at: Option<NaiveDateTime>) -> String {
    let watermark = linked_at
        .map(|value| value.and_utc().timestamp())
        .unwrap_or_default();
    format!("echo-messengers:chats:v1:{watermark}:{chat_id}:unread")
}

struct UnreadCounts {
    available: bool,
    counts: HashMap<String, usize>,
}

async fn unread_counts(
    chat_redis: &crate::chat_redis::ChatRedis,
    rows: &[(ChatRow, ChatKey)],
) -> anyhow::Result<UnreadCounts> {
    let Some(mut redis) = chat_redis.connection().await else {
        return Ok(UnreadCounts {
            available: false,
            counts: HashMap::new(),
        });
    };
    let mut pipe = redis::pipe();
    let mut ids = Vec::with_capacity(rows.len());
    for (row, key) in rows {
        let id = encode_chat_id(key).c(h!())?;
        pipe.cmd("SCARD").arg(unread_key(&id, row.linked_at));
        ids.push(id);
    }
    match pipe.query_async::<Vec<usize>>(&mut redis).await {
        Ok(counts) => Ok(UnreadCounts {
            available: true,
            counts: ids.into_iter().zip(counts).collect(),
        }),
        Err(err) => {
            log::warn!("failed to read chat unread counts: {err}");
            Ok(UnreadCounts {
                available: false,
                counts: HashMap::new(),
            })
        }
    }
}

struct UnreadIds {
    available: bool,
    ids: HashSet<i32>,
}

async fn unread_ids(
    chat_redis: &crate::chat_redis::ChatRedis,
    chat_id: &str,
    linked_at: Option<NaiveDateTime>,
) -> UnreadIds {
    let Some(mut redis) = chat_redis.connection().await else {
        return UnreadIds {
            available: false,
            ids: HashSet::new(),
        };
    };
    match redis
        .smembers::<_, HashSet<i32>>(unread_key(chat_id, linked_at))
        .await
    {
        Ok(ids) => UnreadIds {
            available: true,
            ids,
        },
        Err(err) => {
            log::warn!("failed to read chat unread ids: {err}");
            UnreadIds {
                available: false,
                ids: HashSet::new(),
            }
        }
    }
}

async fn settings_row(
    db: &DatabaseConnection,
    client_id: i32,
) -> anyhow::Result<Option<SettingsRow>> {
    SettingsRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select client_id, hide_private, hide_groups, private_webhook_url, group_webhook_url, store_data_30_days from echo_client_settings where client_id = $1",
        [client_id.into()],
    )).one(db).await.c(h!())
}

async fn filter_rows(
    db: &DatabaseConnection,
    client_id: Option<i32>,
) -> anyhow::Result<Vec<FilterRow>> {
    let (sql, values) = if let Some(client_id) = client_id {
        ("select client_id, account_id, chat_kind, participant_key, group_id from echo_chat_filter where client_id = $1", vec![client_id.into()])
    } else {
        ("select client_id, account_id, chat_kind, participant_key, group_id from echo_chat_filter", vec![])
    };
    FilterRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .all(db)
    .await
    .c(h!())
}

fn decode_filter_ids(
    client_id: i32,
    kind: ChatKind,
    ids: &[String],
) -> anyhow::Result<Vec<ChatKey>> {
    let mut unique_ids = HashSet::new();
    ids.iter()
        .filter(|id| unique_ids.insert(id.as_str()))
        .map(|id| {
            let key = decode_chat_id(id).c(h!())?;
            if key.client_id != client_id || key.kind != kind {
                return Err(bad_request(
                    "Фільтр містить чат іншого клієнта або типу.",
                ));
            }
            Ok(key)
        })
        .collect()
}

async fn validate_webhook_update(update: &WebhookUpdate) -> anyhow::Result<()> {
    if let WebhookUpdate::Replace(url) = update {
        resolve_webhook(url).await.c(h!())?;
    }
    Ok(())
}

fn apply_webhook_update(
    current: Option<String>,
    update: WebhookUpdate,
) -> Option<String> {
    match update {
        WebhookUpdate::Keep => current,
        WebhookUpdate::Remove => None,
        WebhookUpdate::Replace(url) => Some(url.trim().to_string()),
    }
}

async fn load_attachments(
    db: &DatabaseConnection,
    chat_id: &str,
    inbox_ids: &[i32],
    outbox_ids: &[i32],
) -> anyhow::Result<HashMap<String, Vec<Attachment>>> {
    if inbox_ids.is_empty() && outbox_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = r#"
        select id, message_id, name, path, null::text as extension,
            'in'::text as direction, null::bigint as content_base64_size
        from echo_attachment where message_id = any($1::integer[])
        union all
        select id, message_id, null, path, extension, 'out',
            case when content_base64 is null then null else (length(content_base64)::bigint * 3 / 4) end
        from echo_outbox_message_attachment where message_id = any($2::integer[])
    "#;
    let rows =
        AttachmentRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [inbox_ids.to_vec().into(), outbox_ids.to_vec().into()],
        ))
        .all(db)
        .await
        .c(h!())?;
    let mut result = HashMap::<String, Vec<Attachment>>::new();
    for row in rows {
        let name = row.name.clone().or_else(|| {
            row.extension
                .as_ref()
                .map(|extension| format!("attachment.{}", extension))
        });
        let kind =
            media_kind(name.as_deref().or(row.path.as_deref()).unwrap_or(""));
        let content_type = content_type_for_name(
            name.as_deref().or(row.path.as_deref()).unwrap_or(""),
        );
        let path_size = if let Some(path) = row.path.as_ref() {
            tokio::fs::metadata(path)
                .await
                .ok()
                .map(|metadata| metadata.len())
        } else {
            None
        };
        let size_bytes = path_size.or_else(|| {
            row.content_base64_size
                .and_then(|size| u64::try_from(size).ok())
        });
        result
            .entry(format!("{}:{}", row.direction, row.message_id))
            .or_default()
            .push(Attachment {
                id: row.id,
                name,
                url: format!(
                    "/ui-api/chats/{}/attachments/{}/{}",
                    chat_id, row.direction, row.id
                ),
                media_kind: kind,
                content_type,
                size_bytes,
                available: size_bytes.is_some(),
            });
    }
    Ok(result)
}

async fn load_reactions(
    db: &DatabaseConnection,
    inbox_ids: &[i32],
    rows: &[MessageRow],
) -> anyhow::Result<HashMap<String, Vec<String>>> {
    let outbox_instance_ids = rows
        .iter()
        .filter(|row| row.direction == "out")
        .map(|row| row.row_id)
        .collect::<Vec<_>>();
    if inbox_ids.is_empty() && outbox_instance_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = r#"
        select inbox_message_id as message_id, code, 'in'::text as direction
        from echo_message_reaction_queue
        where inbox_message_id = any($1::integer[])
        union all
        select message_id, code, 'out'
        from echo_outbox_message_reaction
        where message_id = any($2::integer[])
    "#;
    let reaction_rows =
        ReactionRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [inbox_ids.to_vec().into(), outbox_instance_ids.into()],
        ))
        .all(db)
        .await
        .c(h!())?;
    let mut result = HashMap::<String, Vec<String>>::new();
    for row in reaction_rows {
        result
            .entry(format!("{}:{}", row.direction, row.message_id))
            .or_default()
            .push(row.code);
    }
    Ok(result)
}

fn media_kind(name: &str) -> &'static str {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" => "image",
        "mp4" | "webm" | "mov" => "video",
        "mp3" | "wav" | "ogg" | "m4a" | "opus" => "audio",
        _ => "file",
    }
}

fn content_type_for_name(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
#[path = "chats_tests.rs"]
mod tests;

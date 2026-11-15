use crate::config::{
    MESSENGERS_MESSAGES_DEFAULT_LIMIT, MESSENGERS_MESSAGES_MAX_LIMIT,
};
use crate::entities::{sigint_chat_message, signal_message};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::refs::parse_echo_uuid;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::attachments::{build_attachments, load_media_metadata};
use crate::messengers::chats::resolve_chat;
use crate::messengers::paging::{page_limit, parse_cursor_page, CursorPage};
use crate::messengers::types::{
    MessengersAttachment, MessengersMessageItem, MessengersMessagesListReq,
    MessengersMessagesListRsp, MessengersTelegramMessageId,
};
use crate::types::{Env, ShortContext};
use chrono::{DateTime, NaiveDateTime};
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::*;
use std::collections::HashMap;
use uuid::Uuid;

/// A place in a chat timeline. `id` breaks ties between messages sent at the
/// same moment. It cannot order messages alone: backfilled history is stored
/// out of send order.
#[derive(Clone, Copy)]
struct TimelinePosition {
    sent_at: NaiveDateTime,
    id: i64,
}

impl TimelinePosition {
    fn encode(&self) -> String {
        format!("{}_{}", self.sent_at.and_utc().timestamp_micros(), self.id)
    }

    fn decode(cursor: &str) -> Result<Self, AppError> {
        Self::parse(cursor).ok_or_else(|| AppError::BL {
            msg: format!("invalid cursor: {cursor}"),
        })
    }

    fn parse(cursor: &str) -> Option<Self> {
        let (micros, id) = cursor.split_once('_')?;
        let micros = micros.parse::<i64>().ok()?;
        let sent_at = DateTime::from_timestamp_micros(micros)?.naive_utc();
        Some(Self {
            sent_at,
            id: id.parse().ok()?,
        })
    }
}

enum PageRequest {
    Cursor(CursorPage<TimelinePosition>),
    Around(Uuid),
}

#[derive(FromQueryResult)]
struct MessageRow {
    id: i64,
    messenger_external_id: String,
    messenger_sent_at: NaiveDateTime,
    telegram_message_id: Option<i64>,
    messenger_sender_id: Option<Uuid>,
    messenger_is_outgoing: Option<bool>,
    messenger_has_media: Option<bool>,
    id_uuid: Option<Uuid>,
    body: Option<String>,
}

impl MessageRow {
    fn position(&self) -> TimelinePosition {
        TimelinePosition {
            sent_at: self.messenger_sent_at,
            id: self.id,
        }
    }
}

/// Rows are newest first.
struct MessagePage {
    rows: Vec<MessageRow>,
    older: Option<TimelinePosition>,
    newer: Option<TimelinePosition>,
}

pub(crate) async fn list_messages(
    env: &Env,
    scope: &MessengersScope,
    req: MessengersMessagesListReq,
) -> Result<MessengersMessagesListRsp, AppError> {
    let limit = page_limit(
        req.limit,
        MESSENGERS_MESSAGES_DEFAULT_LIMIT,
        MESSENGERS_MESSAGES_MAX_LIMIT,
    )
    .c(h!())?;
    let page_request = page_request(&req).c(h!())?;
    let account = resolve_account(&env.dbx, scope, &req.account_id)
        .await
        .c(h!())?;
    let chat = resolve_chat(&env.dbx, &account, &req.chat_id)
        .await
        .c(h!())?;
    let page = load_page(&env.dbx, chat.id, page_request, limit)
        .await
        .c(h!())?;
    let items = message_items(env, scope, page.rows).await.c(h!())?;
    Ok(MessengersMessagesListRsp {
        items,
        older_cursor: page.older.map(|position| position.encode()),
        newer_cursor: page.newer.map(|position| position.encode()),
    })
}

fn page_request(
    req: &MessengersMessagesListReq,
) -> Result<PageRequest, AppError> {
    if let Some(message_id) = &req.around_message_id {
        if req.cursor.is_some() || req.direction.is_some() {
            return Err(AppError::BL {
                msg: "around_message_id excludes cursor and direction"
                    .to_string(),
            });
        }
        return Ok(PageRequest::Around(parse_echo_uuid(message_id).c(h!())?));
    }
    let page = parse_cursor_page(
        req.cursor.as_deref(),
        req.direction,
        TimelinePosition::decode,
    )
    .c(h!())?;
    Ok(PageRequest::Cursor(page))
}

async fn load_page(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    page_request: PageRequest,
    limit: u64,
) -> Result<MessagePage, AppError> {
    match page_request {
        PageRequest::Cursor(CursorPage::Latest) => {
            load_older_page(dbx, chat_id, None, limit).await
        }
        PageRequest::Cursor(CursorPage::Oldest) => {
            load_oldest_page(dbx, chat_id, limit).await
        }
        PageRequest::Cursor(CursorPage::Older(position)) => {
            load_older_page(dbx, chat_id, Some(position), limit).await
        }
        PageRequest::Cursor(CursorPage::Newer(position)) => {
            load_newer_page(dbx, chat_id, position, limit).await
        }
        PageRequest::Around(message_id) => {
            load_around_page(dbx, chat_id, message_id, limit).await
        }
    }
}

async fn load_older_page(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    before: Option<TimelinePosition>,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let filter = before.map(|position| timeline_filter("<", position));
    let (rows, older) =
        load_older_rows(dbx, chat_id, filter, limit).await.c(h!())?;
    let newer = rows.first().map(MessageRow::position).or(before);
    Ok(MessagePage { rows, older, newer })
}

/// The start of the chat, so nothing is older than this page.
async fn load_oldest_page(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let rows = load_newer_rows(dbx, chat_id, None, limit).await.c(h!())?;
    let newer = rows.first().map(MessageRow::position);
    Ok(MessagePage {
        rows,
        older: None,
        newer,
    })
}

async fn load_newer_page(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    after: TimelinePosition,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let rows = load_newer_rows(dbx, chat_id, Some(after), limit)
        .await
        .c(h!())?;
    let older = rows.last().map(MessageRow::position).or(Some(after));
    let newer = rows.first().map(MessageRow::position).or(Some(after));
    Ok(MessagePage { rows, older, newer })
}

/// The message with the older half of the page below it and the newer half
/// above it, so the page reads the same as any other.
async fn load_around_page(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    message_id: Uuid,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let target = find_message_position(dbx, chat_id, message_id)
        .await
        .c(h!())?;
    let newer_limit = limit / 2;
    let mut rows = load_newer_rows(dbx, chat_id, Some(target), newer_limit)
        .await
        .c(h!())?;
    let filter = Some(timeline_filter("<=", target));
    let (older_rows, older) =
        load_older_rows(dbx, chat_id, filter, limit - newer_limit)
            .await
            .c(h!())?;
    rows.extend(older_rows);
    let newer = rows.first().map(MessageRow::position);
    Ok(MessagePage { rows, older, newer })
}

/// Reads one row past the page to learn whether older messages remain.
async fn load_older_rows(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    filter: Option<SimpleExpr>,
    limit: u64,
) -> Result<(Vec<MessageRow>, Option<TimelinePosition>), AppError> {
    let mut query = visible_messages(chat_id);
    if let Some(filter) = filter {
        query = query.filter(filter);
    }
    let mut rows = query
        .order_by_desc(sigint_chat_message::Column::MessengerSentAt)
        .order_by_desc(sigint_chat_message::Column::Id)
        .limit(limit + 1)
        .into_model::<MessageRow>()
        .all(dbx)
        .await
        .c(h!())?;
    let has_older = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    let older = rows.last().filter(|_| has_older).map(MessageRow::position);
    Ok((rows, older))
}

/// The `limit` messages closest after `after`, or from the start of the chat
/// without it, newest first.
async fn load_newer_rows(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    after: Option<TimelinePosition>,
    limit: u64,
) -> Result<Vec<MessageRow>, AppError> {
    let mut query = visible_messages(chat_id);
    if let Some(after) = after {
        query = query.filter(timeline_filter(">", after));
    }
    let mut rows = query
        .order_by_asc(sigint_chat_message::Column::MessengerSentAt)
        .order_by_asc(sigint_chat_message::Column::Id)
        .limit(limit)
        .into_model::<MessageRow>()
        .all(dbx)
        .await
        .c(h!())?;
    rows.reverse();
    Ok(rows)
}

async fn find_message_position(
    dbx: &DatabaseConnection,
    chat_id: Uuid,
    message_id: Uuid,
) -> Result<TimelinePosition, AppError> {
    let row = visible_messages(chat_id)
        .filter(signal_message::Column::IdUuid.eq(message_id))
        .into_model::<MessageRow>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(row.position())
}

fn visible_messages(chat_id: Uuid) -> Select<sigint_chat_message::Entity> {
    let signal_message_relation =
        sigint_chat_message::Entity::belongs_to(signal_message::Entity)
            .from(sigint_chat_message::Column::Id)
            .to(signal_message::Column::Id)
            .into();
    sigint_chat_message::Entity::find()
        .select_only()
        .columns([
            sigint_chat_message::Column::Id,
            sigint_chat_message::Column::MessengerExternalId,
            sigint_chat_message::Column::MessengerSentAt,
            sigint_chat_message::Column::TelegramMessageId,
            sigint_chat_message::Column::MessengerSenderId,
            sigint_chat_message::Column::MessengerIsOutgoing,
            sigint_chat_message::Column::MessengerHasMedia,
        ])
        .columns([signal_message::Column::IdUuid, signal_message::Column::Body])
        .join(JoinType::InnerJoin, signal_message_relation)
        .filter(sigint_chat_message::Column::MessengerChatId.eq(chat_id))
        .filter(signal_message::Column::Deleted.eq(false))
}

/// A row comparison, so PostgreSQL applies it as a single range on
/// `sigint_chat_message_chat_timeline_idx` in either direction.
fn timeline_filter(operator: &str, position: TimelinePosition) -> SimpleExpr {
    Expr::cust_with_values(
        format!(
            "(sigint_chat_message.messenger_sent_at, sigint_chat_message.id) \
             {operator} ($1, $2)"
        ),
        [Value::from(position.sent_at), Value::from(position.id)],
    )
}

async fn message_items(
    env: &Env,
    scope: &MessengersScope,
    rows: Vec<MessageRow>,
) -> Result<Vec<MessengersMessageItem>, AppError> {
    let message_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let mut attachments =
        load_attachments(env, scope, &message_ids).await.c(h!())?;
    rows.into_iter()
        .map(|row| {
            let attachments = attachments.remove(&row.id).unwrap_or_default();
            message_item(row, attachments)
        })
        .collect()
}

fn message_item(
    row: MessageRow,
    attachments: Vec<MessengersAttachment>,
) -> Result<MessengersMessageItem, AppError> {
    Ok(MessengersMessageItem {
        id: row.id_uuid.c(h!())?.to_string(),
        external_id: row.messenger_external_id,
        sent_at: row.messenger_sent_at.and_utc().timestamp_millis(),
        text: row.body.unwrap_or_default(),
        is_outgoing: row.messenger_is_outgoing,
        has_media: row.messenger_has_media,
        sender_chat_member_id: row
            .messenger_sender_id
            .map(|sender_id| sender_id.to_string()),
        attachments,
        telegram: row.telegram_message_id.map(|id| {
            MessengersTelegramMessageId {
                message_id: id.to_string(),
            }
        }),
    })
}

async fn load_attachments(
    env: &Env,
    scope: &MessengersScope,
    message_ids: &[i64],
) -> Result<HashMap<i64, Vec<MessengersAttachment>>, AppError> {
    let media_entries =
        crate::messenger::audio_ref::for_messages(env, &env.dbx, message_ids)
            .await
            .c(h!())?;
    let media_ids = media_entries.iter().map(|media| media.id).collect();
    let metadata = load_media_metadata(&env.dbx, media_ids).await.c(h!())?;
    let mut built = build_attachments(env, scope, &media_entries, &metadata)
        .await
        .c(h!())?;
    let mut attachments: HashMap<i64, Vec<MessengersAttachment>> =
        HashMap::new();
    for media in &media_entries {
        let Some(attachment) = built.remove(&media.id) else {
            continue;
        };
        attachments
            .entry(media.signal_message_id)
            .or_default()
            .push(attachment);
    }
    Ok(attachments)
}

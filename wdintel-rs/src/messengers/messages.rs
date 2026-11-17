use crate::config::{
    MESSENGERS_HEADLINE_START, MESSENGERS_HEADLINE_STOP,
    MESSENGERS_MESSAGES_DEFAULT_LIMIT, MESSENGERS_MESSAGES_MAX_LIMIT,
};
use crate::entities::{sigint_chat_message, sigint_search, signal_message};
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
use chrono::{DateTime, Duration, NaiveDateTime};
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
    /// The end of the millisecond `ms`: every message sent within it is at or
    /// before this position, the next millisecond's messages after it. It
    /// matches how read bounds are stored, so a chat's `newest_read_at`
    /// splits its read messages from its unread ones.
    fn end_of_millisecond(ms: i64) -> Result<Self, AppError> {
        let sent_at = DateTime::from_timestamp_millis(ms)
            .and_then(|dt| {
                dt.naive_utc()
                    .checked_add_signed(Duration::microseconds(999))
            })
            .ok_or_else(|| AppError::BL {
                msg: format!("invalid around_sent_at: {ms}"),
            })?;
        Ok(Self {
            sent_at,
            id: i64::MAX,
        })
    }

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
    AroundMessage(Uuid),
    AroundPosition(TimelinePosition),
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
    headline: Option<String>,
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
    let timeline = ChatTimeline {
        chat_id: chat.id,
        query: req
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty()),
    };
    let page = load_page(&env.dbx, &timeline, page_request, limit)
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
    let around =
        req.around_message_id.is_some() || req.around_sent_at.is_some();
    if around && (req.cursor.is_some() || req.direction.is_some()) {
        return Err(AppError::BL {
            msg: "around_message_id and around_sent_at exclude cursor and \
                  direction"
                .to_string(),
        });
    }
    match (&req.around_message_id, req.around_sent_at) {
        (Some(_), Some(_)) => {
            return Err(AppError::BL {
                msg: "around_message_id excludes around_sent_at".to_string(),
            });
        }
        (Some(message_id), None) => {
            let message_id = parse_echo_uuid(message_id).c(h!())?;
            return Ok(PageRequest::AroundMessage(message_id));
        }
        (None, Some(ms)) => {
            let position = TimelinePosition::end_of_millisecond(ms).c(h!())?;
            return Ok(PageRequest::AroundPosition(position));
        }
        (None, None) => {}
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
    timeline: &ChatTimeline<'_>,
    page_request: PageRequest,
    limit: u64,
) -> Result<MessagePage, AppError> {
    match page_request {
        PageRequest::Cursor(CursorPage::Latest) => {
            load_older_page(dbx, timeline, None, limit).await
        }
        PageRequest::Cursor(CursorPage::Oldest) => {
            load_oldest_page(dbx, timeline, limit).await
        }
        PageRequest::Cursor(CursorPage::Older(position)) => {
            load_older_page(dbx, timeline, Some(position), limit).await
        }
        PageRequest::Cursor(CursorPage::Newer(position)) => {
            load_newer_page(dbx, timeline, position, limit).await
        }
        PageRequest::AroundMessage(message_id) => {
            let target = find_message_position(dbx, timeline, message_id)
                .await
                .c(h!())?;
            load_around_page(dbx, timeline, target, limit).await
        }
        PageRequest::AroundPosition(position) => {
            load_around_page(dbx, timeline, position, limit).await
        }
    }
}

async fn load_older_page(
    dbx: &DatabaseConnection,
    timeline: &ChatTimeline<'_>,
    before: Option<TimelinePosition>,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let filter = before.map(|position| timeline_filter("<", position));
    let (rows, older) = load_older_rows(dbx, timeline, filter, limit)
        .await
        .c(h!())?;
    let newer = rows.first().map(MessageRow::position).or(before);
    Ok(MessagePage { rows, older, newer })
}

/// The start of the chat, so nothing is older than this page.
async fn load_oldest_page(
    dbx: &DatabaseConnection,
    timeline: &ChatTimeline<'_>,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let rows = load_newer_rows(dbx, timeline, None, limit).await.c(h!())?;
    let newer = rows.first().map(MessageRow::position);
    Ok(MessagePage {
        rows,
        older: None,
        newer,
    })
}

async fn load_newer_page(
    dbx: &DatabaseConnection,
    timeline: &ChatTimeline<'_>,
    after: TimelinePosition,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let rows = load_newer_rows(dbx, timeline, Some(after), limit)
        .await
        .c(h!())?;
    let older = rows.last().map(MessageRow::position).or(Some(after));
    let newer = rows.first().map(MessageRow::position).or(Some(after));
    Ok(MessagePage { rows, older, newer })
}

/// The page split at `target`: the newer half of the page above it, the older
/// half below it including a message at `target` itself, so the page reads the
/// same as any other.
async fn load_around_page(
    dbx: &DatabaseConnection,
    timeline: &ChatTimeline<'_>,
    target: TimelinePosition,
    limit: u64,
) -> Result<MessagePage, AppError> {
    let newer_limit = limit / 2;
    let mut rows = load_newer_rows(dbx, timeline, Some(target), newer_limit)
        .await
        .c(h!())?;
    let filter = Some(timeline_filter("<=", target));
    let (older_rows, older) =
        load_older_rows(dbx, timeline, filter, limit - newer_limit)
            .await
            .c(h!())?;
    rows.extend(older_rows);
    let newer = rows.first().map(MessageRow::position);
    Ok(MessagePage { rows, older, newer })
}

/// Reads one row past the page to learn whether older messages remain.
async fn load_older_rows(
    dbx: &DatabaseConnection,
    timeline: &ChatTimeline<'_>,
    filter: Option<SimpleExpr>,
    limit: u64,
) -> Result<(Vec<MessageRow>, Option<TimelinePosition>), AppError> {
    let mut query = timeline.messages();
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
    timeline: &ChatTimeline<'_>,
    after: Option<TimelinePosition>,
    limit: u64,
) -> Result<Vec<MessageRow>, AppError> {
    let mut query = timeline.messages();
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
    timeline: &ChatTimeline<'_>,
    message_id: Uuid,
) -> Result<TimelinePosition, AppError> {
    let row = timeline
        .messages()
        .filter(signal_message::Column::IdUuid.eq(message_id))
        .into_model::<MessageRow>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(row.position())
}

/// The messages of one chat, all of them or only those matching a search.
struct ChatTimeline<'a> {
    chat_id: Uuid,
    query: Option<&'a str>,
}

impl ChatTimeline<'_> {
    fn messages(&self) -> Select<sigint_chat_message::Entity> {
        let signal_message_relation =
            sigint_chat_message::Entity::belongs_to(signal_message::Entity)
                .from(sigint_chat_message::Column::Id)
                .to(signal_message::Column::Id)
                .into();
        let query = sigint_chat_message::Entity::find()
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
            .columns([
                signal_message::Column::IdUuid,
                signal_message::Column::Body,
            ])
            .join(JoinType::InnerJoin, signal_message_relation)
            .filter(
                sigint_chat_message::Column::MessengerChatId.eq(self.chat_id),
            )
            .filter(signal_message::Column::Deleted.eq(false));
        match self.query {
            Some(search) => matching_messages(query, search),
            None => query.column_as(Expr::cust("null::text"), "headline"),
        }
    }
}

/// `sigint_search.id` is the message id, so the search joins the timeline
/// directly. PostgreSQL picks the GIN index `sigint_search_tsv_idx` and
/// hash-joins it to the chat's range of
/// `sigint_chat_message_chat_timeline_idx`, or probes the chat messages by id
/// for a rare term. `ts_headline` runs only on the rows of the page.
fn matching_messages(
    query: Select<sigint_chat_message::Entity>,
    search: &str,
) -> Select<sigint_chat_message::Entity> {
    let sigint_search_relation =
        sigint_chat_message::Entity::belongs_to(sigint_search::Entity)
            .from(sigint_chat_message::Column::Id)
            .to(sigint_search::Column::Id)
            .into();
    query
        .column_as(
            Expr::cust_with_values(
                "ts_headline('russian', coalesce(signal_message.body, ''), \
                 plainto_tsquery('russian', $1), $2)",
                [Value::from(search), Value::from(headline_options())],
            ),
            "headline",
        )
        .join(JoinType::InnerJoin, sigint_search_relation)
        .filter(Expr::cust_with_values(
            "sigint_search.search_tsv @@ plainto_tsquery('russian', $1)",
            [Value::from(search)],
        ))
}

/// One short fragment around the first match.
fn headline_options() -> String {
    format!(
        "MaxWords=10, MinWords=3, ShortWord=3, HighlightAll=false, \
         MaxFragments=1, StartSel=\"{MESSENGERS_HEADLINE_START}\", \
         StopSel=\"{MESSENGERS_HEADLINE_STOP}\""
    )
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
        headline: row.headline,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_INGEST_GROUP_KEY_PREFIX,
    };
    use crate::entities::datasource;
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::access::IngestScope;
    use crate::messenger_ingest::refs::{
        MessengerIngestAccountRef, MessengerIngestChatRef,
    };
    use crate::messenger_ingest::types::{
        MessengerIngestMessageInput, MessengerIngestMessagesSubmitReq,
    };
    use crate::messengers::attachments::tests::{sync_account, sync_chat};
    use crate::messengers::types::MessengersMessagesListRsp;
    use serial_test::serial;

    struct Fixture {
        env: Env,
        scope: MessengersScope,
        account_id: String,
        chat_id: String,
    }

    /// `chat-1` has `m-1`..`m-4`, oldest first, with `m-4` deleted. The
    /// other chat has one message with the same word.
    async fn fixture() -> Fixture {
        let env = (*cleanup().await.unwrap()).clone();
        let login = mk_login(&env.dbx, Default::default()).await.unwrap();
        let datasource = mk_datasource(
            &env.dbx,
            datasource::ActiveModel {
                kind: Set(MESSENGER_INGEST_DATASOURCE_KIND.to_string()),
                api_login_id: Set(Some(login.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let ingest = IngestScope {
            login_id: login.id,
            datasource,
        };
        let account = sync_account(&env, &ingest).await;
        let chat_1 = sync_chat(&env, &ingest, &account, "chat-1").await;
        let chat_2 = sync_chat(&env, &ingest, &account, "chat-2").await;
        submit(
            &env,
            &ingest,
            &account,
            &chat_1,
            &[
                ("m-1", 1_000, "танки идут к реке"),
                ("m-2", 2_000, "погода сегодня хорошая"),
                ("m-3", 3_000, "вчера видели танк у моста"),
                ("m-4", 4_000, "танк уехал"),
            ],
        )
        .await;
        submit(
            &env,
            &ingest,
            &account,
            &chat_2,
            &[("m-5", 5_000, "танк в другом чате")],
        )
        .await;
        let deleted = sigint_chat_message::Entity::find()
            .filter(
                sigint_chat_message::Column::MessengerChatId
                    .eq(Uuid::parse_str(&chat_1.id).unwrap()),
            )
            .filter(sigint_chat_message::Column::MessengerExternalId.eq("m-4"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        signal_message::Entity::update_many()
            .col_expr(signal_message::Column::Deleted, Expr::value(true))
            .filter(signal_message::Column::Id.eq(deleted.id))
            .exec(&env.dbx)
            .await
            .unwrap();
        let scope = MessengersScope {
            login_id: login.id,
            group_master_keys: vec![format!(
                "{MESSENGER_INGEST_GROUP_KEY_PREFIX}{}",
                account.id
            )],
        };
        Fixture {
            env,
            scope,
            account_id: account.id,
            chat_id: chat_1.id,
        }
    }

    async fn submit(
        env: &Env,
        ingest: &IngestScope,
        account: &MessengerIngestAccountRef,
        chat: &MessengerIngestChatRef,
        messages: &[(&str, i64, &str)],
    ) {
        crate::messenger_ingest::messages::submit_messages(
            env,
            ingest,
            MessengerIngestMessagesSubmitReq {
                account: account.clone(),
                chat: chat.clone(),
                messages: messages
                    .iter()
                    .map(|(external_id, date, text)| {
                        MessengerIngestMessageInput {
                            external_id: (*external_id).to_owned(),
                            date: 1_760_431_000_000 + date,
                            text: Some((*text).to_owned()),
                            is_outgoing: None,
                            has_media: Some(false),
                            sender: None,
                            telegram: None,
                        }
                    })
                    .collect(),
            },
        )
        .await
        .unwrap();
    }

    async fn list(
        fixture: &Fixture,
        query: Option<&str>,
        cursor: Option<String>,
        limit: i64,
    ) -> MessengersMessagesListRsp {
        list_messages(
            &fixture.env,
            &fixture.scope,
            MessengersMessagesListReq {
                account_id: fixture.account_id.clone(),
                chat_id: fixture.chat_id.clone(),
                cursor,
                limit: Some(limit),
                direction: None,
                around_message_id: None,
                around_sent_at: None,
                query: query.map(str::to_owned),
            },
        )
        .await
        .unwrap()
    }

    fn external_ids(rsp: &MessengersMessagesListRsp) -> Vec<&str> {
        rsp.items
            .iter()
            .map(|item| item.external_id.as_str())
            .collect()
    }

    fn highlighted(word: &str) -> String {
        format!("{MESSENGERS_HEADLINE_START}{word}{MESSENGERS_HEADLINE_STOP}")
    }

    #[tokio::test]
    #[serial]
    async fn search_lists_matches_of_the_chat_with_headlines() {
        let fixture = fixture().await;
        let rsp = list(&fixture, Some(" танк "), None, 50).await;
        assert_eq!(external_ids(&rsp), ["m-3", "m-1"]);
        assert_eq!(rsp.older_cursor, None);
        let headlines = rsp
            .items
            .iter()
            .map(|item| item.headline.clone().unwrap())
            .collect::<Vec<_>>();
        assert!(headlines[0].contains(&highlighted("танк")), "{headlines:?}");
        assert!(
            headlines[1].contains(&highlighted("танки")),
            "{headlines:?}"
        );
    }

    #[tokio::test]
    #[serial]
    async fn search_pages_through_matches_only() {
        let fixture = fixture().await;
        let first = list(&fixture, Some("танк"), None, 1).await;
        assert_eq!(external_ids(&first), ["m-3"]);
        let second =
            list(&fixture, Some("танк"), first.older_cursor.clone(), 1).await;
        assert_eq!(external_ids(&second), ["m-1"]);
        assert_eq!(second.older_cursor, None);
    }

    #[tokio::test]
    #[serial]
    async fn blank_query_lists_the_whole_chat_without_headlines() {
        let fixture = fixture().await;
        for query in [None, Some("  ")] {
            let rsp = list(&fixture, query, None, 50).await;
            assert_eq!(external_ids(&rsp), ["m-3", "m-2", "m-1"]);
            assert!(rsp.items.iter().all(|item| item.headline.is_none()));
        }
    }
}

use crate::config::{
    MESSENGERS_ATTACHMENTS_DEFAULT_LIMIT, MESSENGERS_ATTACHMENTS_MAX_LIMIT,
};
use crate::entities::{
    messenger_chat, messenger_media_meta, signal_message, signal_message_media,
};
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::chats::resolve_chat;
use crate::messengers::paging::{page_limit, parse_cursor_page, CursorPage};
use crate::messengers::types::{
    MessengersAttachment, MessengersAttachmentItem,
    MessengersAttachmentsListReq, MessengersAttachmentsListRsp,
    MessengersTelegramMedia,
};
use crate::rer_importer::highlight::CNPosition;
use crate::rer_importer::inbox::bl::{
    load_message_media_details, message_media_info, MessageMediaDetails,
};
use crate::types::{Env, ShortContext};
use chrono::{DateTime, NaiveDateTime};
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::*;
use std::collections::HashMap;
use uuid::Uuid;

/// A place in an attachment timeline: the message's send time and id, as in
/// the message timeline, then the media id for attachments of one message.
#[derive(Clone, Copy)]
struct AttachmentPosition {
    sent_at: NaiveDateTime,
    message_id: i64,
    media_id: Uuid,
}

impl AttachmentPosition {
    fn encode(&self) -> String {
        format!(
            "{}_{}_{}",
            self.sent_at.and_utc().timestamp_micros(),
            self.message_id,
            self.media_id
        )
    }

    fn decode(cursor: &str) -> Result<Self, AppError> {
        Self::parse(cursor).ok_or_else(|| AppError::BL {
            msg: format!("invalid cursor: {cursor}"),
        })
    }

    fn parse(cursor: &str) -> Option<Self> {
        let mut parts = cursor.splitn(3, '_');
        let micros = parts.next()?.parse::<i64>().ok()?;
        let message_id = parts.next()?.parse().ok()?;
        let media_id = Uuid::parse_str(parts.next()?).ok()?;
        let sent_at = DateTime::from_timestamp_micros(micros)?.naive_utc();
        Some(Self {
            sent_at,
            message_id,
            media_id,
        })
    }
}

/// The timeline a request pages: one chat, or every live chat of an account.
#[derive(Clone, Copy)]
enum AttachmentScope {
    Chat(Uuid),
    Account(Uuid),
}

#[derive(FromQueryResult)]
struct AttachmentRow {
    id: Uuid,
    sigint_chat_message_id: i64,
    messenger_chat_id: Uuid,
    messenger_sent_at: NaiveDateTime,
    messenger_sender_id: Option<Uuid>,
    id_uuid: Option<Uuid>,
}

impl AttachmentRow {
    fn position(&self) -> AttachmentPosition {
        AttachmentPosition {
            sent_at: self.messenger_sent_at,
            message_id: self.sigint_chat_message_id,
            media_id: self.id,
        }
    }
}

/// Rows are newest first.
struct AttachmentPage {
    rows: Vec<AttachmentRow>,
    older: Option<AttachmentPosition>,
    newer: Option<AttachmentPosition>,
}

pub(crate) async fn list_attachments(
    env: &Env,
    scope: &MessengersScope,
    req: MessengersAttachmentsListReq,
) -> Result<MessengersAttachmentsListRsp, AppError> {
    let limit = page_limit(
        req.limit,
        MESSENGERS_ATTACHMENTS_DEFAULT_LIMIT,
        MESSENGERS_ATTACHMENTS_MAX_LIMIT,
    )
    .c(h!())?;
    let page_request = parse_cursor_page(
        req.cursor.as_deref(),
        req.direction,
        AttachmentPosition::decode,
    )
    .c(h!())?;
    let attachment_scope =
        resolve_attachment_scope(env, scope, &req).await.c(h!())?;
    let attachments =
        visible_attachments(attachment_scope, req.telegram_media_type);
    let page = load_page(&env.dbx, attachments, page_request, limit)
        .await
        .c(h!())?;
    let items = attachment_items(env, scope, page.rows).await.c(h!())?;
    Ok(MessengersAttachmentsListRsp {
        items,
        older_cursor: page.older.map(|position| position.encode()),
        newer_cursor: page.newer.map(|position| position.encode()),
    })
}

async fn resolve_attachment_scope(
    env: &Env,
    scope: &MessengersScope,
    req: &MessengersAttachmentsListReq,
) -> Result<AttachmentScope, AppError> {
    let account = resolve_account(&env.dbx, scope, &req.account_id)
        .await
        .c(h!())?;
    let Some(chat_id) = &req.chat_id else {
        return Ok(AttachmentScope::Account(account.id));
    };
    let chat = resolve_chat(&env.dbx, &account, chat_id).await.c(h!())?;
    Ok(AttachmentScope::Chat(chat.id))
}

async fn load_page(
    dbx: &DatabaseConnection,
    attachments: Select<messenger_media_meta::Entity>,
    page_request: CursorPage<AttachmentPosition>,
    limit: u64,
) -> Result<AttachmentPage, AppError> {
    match page_request {
        CursorPage::Latest => {
            load_older_page(dbx, attachments, None, limit).await
        }
        CursorPage::Oldest => load_oldest_page(dbx, attachments, limit).await,
        CursorPage::Older(position) => {
            load_older_page(dbx, attachments, Some(position), limit).await
        }
        CursorPage::Newer(position) => {
            load_newer_page(dbx, attachments, position, limit).await
        }
    }
}

async fn load_older_page(
    dbx: &DatabaseConnection,
    attachments: Select<messenger_media_meta::Entity>,
    before: Option<AttachmentPosition>,
    limit: u64,
) -> Result<AttachmentPage, AppError> {
    let (rows, older) =
        load_older_rows(dbx, attachments, before, limit).await.c(h!())?;
    let newer = rows.first().map(AttachmentRow::position).or(before);
    Ok(AttachmentPage { rows, older, newer })
}

/// The start of the timeline, so nothing is older than this page.
async fn load_oldest_page(
    dbx: &DatabaseConnection,
    attachments: Select<messenger_media_meta::Entity>,
    limit: u64,
) -> Result<AttachmentPage, AppError> {
    let rows = load_newer_rows(dbx, attachments, None, limit)
        .await
        .c(h!())?;
    let newer = rows.first().map(AttachmentRow::position);
    Ok(AttachmentPage {
        rows,
        older: None,
        newer,
    })
}

async fn load_newer_page(
    dbx: &DatabaseConnection,
    attachments: Select<messenger_media_meta::Entity>,
    after: AttachmentPosition,
    limit: u64,
) -> Result<AttachmentPage, AppError> {
    let rows = load_newer_rows(dbx, attachments, Some(after), limit)
        .await
        .c(h!())?;
    let older = rows.last().map(AttachmentRow::position).or(Some(after));
    let newer = rows.first().map(AttachmentRow::position).or(Some(after));
    Ok(AttachmentPage { rows, older, newer })
}

/// Reads one row past the page to learn whether older attachments remain.
async fn load_older_rows(
    dbx: &DatabaseConnection,
    attachments: Select<messenger_media_meta::Entity>,
    before: Option<AttachmentPosition>,
    limit: u64,
) -> Result<(Vec<AttachmentRow>, Option<AttachmentPosition>), AppError> {
    let mut query = attachments;
    if let Some(before) = before {
        query = query.filter(timeline_filter("<", before));
    }
    let mut rows = query
        .order_by_desc(messenger_media_meta::Column::MessengerSentAt)
        .order_by_desc(messenger_media_meta::Column::SigintChatMessageId)
        .order_by_desc(messenger_media_meta::Column::Id)
        .limit(limit + 1)
        .into_model::<AttachmentRow>()
        .all(dbx)
        .await
        .c(h!())?;
    let has_older = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    let older = rows
        .last()
        .filter(|_| has_older)
        .map(AttachmentRow::position);
    Ok((rows, older))
}

/// The `limit` attachments closest after `after`, or from the start of the
/// timeline without it, newest first.
async fn load_newer_rows(
    dbx: &DatabaseConnection,
    attachments: Select<messenger_media_meta::Entity>,
    after: Option<AttachmentPosition>,
    limit: u64,
) -> Result<Vec<AttachmentRow>, AppError> {
    let mut query = attachments;
    if let Some(after) = after {
        query = query.filter(timeline_filter(">", after));
    }
    let mut rows = query
        .order_by_asc(messenger_media_meta::Column::MessengerSentAt)
        .order_by_asc(messenger_media_meta::Column::SigintChatMessageId)
        .order_by_asc(messenger_media_meta::Column::Id)
        .limit(limit)
        .into_model::<AttachmentRow>()
        .all(dbx)
        .await
        .c(h!())?;
    rows.reverse();
    Ok(rows)
}

/// Attachments of live messages in the scope, of the given Telegram media
/// type unless it is empty. The joins are primary key lookups, so PostgreSQL
/// walks the scope's timeline index, or its type timeline index, and stops at
/// the limit.
fn visible_attachments(
    scope: AttachmentScope,
    media_type: Option<String>,
) -> Select<messenger_media_meta::Entity> {
    let signal_message_relation =
        messenger_media_meta::Entity::belongs_to(signal_message::Entity)
            .from(messenger_media_meta::Column::SigintChatMessageId)
            .to(signal_message::Column::Id)
            .into();
    let query = messenger_media_meta::Entity::find()
        .select_only()
        .columns([
            messenger_media_meta::Column::Id,
            messenger_media_meta::Column::SigintChatMessageId,
            messenger_media_meta::Column::MessengerChatId,
            messenger_media_meta::Column::MessengerSentAt,
        ])
        .column(crate::entities::sigint_chat_message::Column::MessengerSenderId)
        .column(signal_message::Column::IdUuid)
        .join(
            JoinType::InnerJoin,
            messenger_media_meta::Relation::SigintChatMessage.def(),
        )
        .join(JoinType::InnerJoin, signal_message_relation)
        .filter(signal_message::Column::Deleted.eq(false))
        .apply_if(
            media_type.filter(|media_type| !media_type.is_empty()),
            |query, media_type| {
                query.filter(
                    messenger_media_meta::Column::TelegramMediaType
                        .eq(media_type),
                )
            },
        );
    match scope {
        AttachmentScope::Chat(chat_id) => query
            .filter(messenger_media_meta::Column::MessengerChatId.eq(chat_id)),
        AttachmentScope::Account(account_id) => query
            .join(
                JoinType::InnerJoin,
                messenger_media_meta::Relation::MessengerChat.def(),
            )
            .filter(
                messenger_media_meta::Column::MessengerAccountId.eq(account_id),
            )
            .filter(messenger_chat::Column::Deleted.eq(false)),
    }
}

/// A row comparison, so PostgreSQL applies it as a single range on
/// `messenger_media_meta_{chat,account}_timeline_idx` in either direction.
fn timeline_filter(operator: &str, position: AttachmentPosition) -> SimpleExpr {
    Expr::cust_with_values(
        format!(
            "(messenger_media_meta.messenger_sent_at, \
             messenger_media_meta.sigint_chat_message_id, \
             messenger_media_meta.id) {operator} ($1, $2, $3)"
        ),
        [
            Value::from(position.sent_at),
            Value::from(position.message_id),
            Value::from(position.media_id),
        ],
    )
}

async fn attachment_items(
    env: &Env,
    scope: &MessengersScope,
    rows: Vec<AttachmentRow>,
) -> Result<Vec<MessengersAttachmentItem>, AppError> {
    let media_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let media_entries = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::Id.is_in(media_ids.clone()))
        .order_by_asc(signal_message_media::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let metadata = load_media_metadata(&env.dbx, media_ids).await.c(h!())?;
    let mut attachments =
        build_attachments(env, scope, &media_entries, &metadata)
            .await
            .c(h!())?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        // Media deleted since the page was read is left out.
        let Some(attachment) = attachments.remove(&row.id) else {
            continue;
        };
        items.push(attachment_item(row, attachment).c(h!())?);
    }
    Ok(items)
}

fn attachment_item(
    row: AttachmentRow,
    attachment: MessengersAttachment,
) -> Result<MessengersAttachmentItem, AppError> {
    Ok(MessengersAttachmentItem {
        chat_id: row.messenger_chat_id.to_string(),
        message_id: row.id_uuid.c(h!())?.to_string(),
        sent_at: row.messenger_sent_at.and_utc().timestamp_millis(),
        sender_chat_member_id: row
            .messenger_sender_id
            .map(|sender_id| sender_id.to_string()),
        attachment,
    })
}

/// The viewer form of each media entry that has messenger metadata, by
/// media id. Every attachment of an ingested message has its metadata row;
/// other media, such as audio references, is left out.
pub(crate) async fn build_attachments(
    env: &Env,
    scope: &MessengersScope,
    media_entries: &[signal_message_media::Model],
    metadata: &HashMap<Uuid, messenger_media_meta::Model>,
) -> Result<HashMap<Uuid, MessengersAttachment>, AppError> {
    let media_ids = media_entries.iter().map(|media| media.id).collect();
    let details = load_message_media_details(env, media_entries)
        .await
        .c(h!())?;
    let mut positions =
        load_media_positions(env, scope, &media_ids).await.c(h!())?;
    let mut attachments = HashMap::new();
    for media in media_entries {
        let Some(meta) = metadata.get(&media.id) else {
            continue;
        };
        let positions = positions.remove(&media.id).unwrap_or_default();
        attachments
            .insert(media.id, attachment(media, meta, &details, positions));
    }
    Ok(attachments)
}

fn attachment(
    media: &signal_message_media::Model,
    meta: &messenger_media_meta::Model,
    details: &MessageMediaDetails,
    positions: Vec<CNPosition>,
) -> MessengersAttachment {
    MessengersAttachment {
        media: message_media_info(media, details, positions),
        external_id: meta.external_id.clone(),
        created_at: meta
            .external_created_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        telegram: meta.telegram_file_id.map(|id| MessengersTelegramMedia {
            file_id: id.to_string(),
            media_type: meta.telegram_media_type.clone(),
        }),
    }
}

pub(crate) async fn load_media_metadata(
    dbx: &DatabaseConnection,
    media_ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, messenger_media_meta::Model>, AppError> {
    let metadata = messenger_media_meta::Entity::find()
        .filter(messenger_media_meta::Column::Id.is_in(media_ids))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(metadata.into_iter().map(|meta| (meta.id, meta)).collect())
}

async fn load_media_positions(
    env: &Env,
    scope: &MessengersScope,
    media_ids: &Vec<Uuid>,
) -> Result<HashMap<Uuid, Vec<CNPosition>>, AppError> {
    let enabled = crate::user_settings::ai_position_highlights_enabled(
        &env.dbx,
        scope.login_id,
    )
    .await
    .c(h!())?;
    if !enabled {
        return Ok(HashMap::new());
    }
    Ok(crate::ai_position::list::positions_by_media(
        &env.dbx,
        media_ids.clone(),
        &scope.group_master_keys.iter().cloned().collect(),
    )
    .await
    .c(h!())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_INGEST_GROUP_KEY_PREFIX,
        MESSENGER_TYPE_MAX,
    };
    use crate::entities::{datasource, sigint_chat_message};
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::access::IngestScope;
    use crate::messenger_ingest::refs::{
        MessengerIngestAccountRef, MessengerIngestChatRef,
    };
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestAccountsSyncReq,
        MessengerIngestChatInput, MessengerIngestChatsSyncReq,
        MessengerIngestMessageInput, MessengerIngestMessagesSubmitReq,
    };
    use crate::messengers::types::MessengersMessagesDirection;
    use chrono::Utc;
    use serial_test::serial;
    use std::collections::BTreeMap;

    struct Fixture {
        env: Env,
        scope: MessengersScope,
        account_id: Uuid,
        chats: Vec<Uuid>,
        /// Every stored attachment, newest first.
        timeline: Vec<(i64, Uuid, Uuid)>,
    }

    /// Two chats of one account. `m-2` and `m-3` share a send time, and
    /// `m-2` has two attachments.
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
        submit(&env, &ingest, &account, &chat_1, &[("m-1", 1_000)]).await;
        submit(&env, &ingest, &account, &chat_2, &[("m-4", 1_500)]).await;
        submit(
            &env,
            &ingest,
            &account,
            &chat_1,
            &[("m-2", 2_000), ("m-3", 2_000)],
        )
        .await;

        let account_id = Uuid::parse_str(&account.id).unwrap();
        let chats = [&chat_1, &chat_2]
            .map(|chat| Uuid::parse_str(&chat.id).unwrap())
            .to_vec();
        let mut timeline = vec![];
        for (chat_id, message, count) in [
            (chats[0], "m-1", 1),
            (chats[0], "m-2", 2),
            (chats[0], "m-3", 1),
            (chats[1], "m-4", 1),
        ] {
            let chat_message = chat_message(&env, chat_id, message).await;
            for index in 0..count {
                let media_id =
                    attach(&env, account_id, &chat_message, index).await;
                timeline.push((
                    chat_message.messenger_sent_at,
                    chat_message.id,
                    media_id,
                    chat_id,
                ));
            }
        }
        timeline.sort();
        timeline.reverse();
        let timeline = timeline
            .into_iter()
            .map(|(_, message_id, media_id, chat_id)| {
                (message_id, media_id, chat_id)
            })
            .collect();
        let scope = MessengersScope {
            login_id: login.id,
            group_master_keys: vec![format!(
                "{MESSENGER_INGEST_GROUP_KEY_PREFIX}{account_id}"
            )],
        };
        Fixture {
            env,
            scope,
            account_id,
            chats,
            timeline,
        }
    }

    async fn sync_account(
        env: &Env,
        ingest: &IngestScope,
    ) -> MessengerIngestAccountRef {
        let accounts = crate::messenger_ingest::accounts::sync_accounts(
            &env.dbx,
            ingest,
            MessengerIngestAccountsSyncReq {
                created: vec![MessengerIngestAccountInput {
                    messenger_type: MESSENGER_TYPE_MAX.to_string(),
                    external_id: "account-1".to_string(),
                    display_name: "Account 1".to_string(),
                    phone: None,
                    username: None,
                    first_name: None,
                    last_name: None,
                    status: None,
                    status_error: None,
                    status_changed_at: None,
                    is_active: Some(true),
                    is_paused: None,
                    notes: None,
                    created_at: None,
                    last_sync: None,
                    telegram: None,
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap();
        let account = accounts.created.into_values().next().unwrap();
        MessengerIngestAccountRef {
            id: account.id,
            external_id: account.external_id,
            messenger_type: account.messenger_type,
            telegram: account.telegram,
        }
    }

    async fn sync_chat(
        env: &Env,
        ingest: &IngestScope,
        account: &MessengerIngestAccountRef,
        external_id: &str,
    ) -> MessengerIngestChatRef {
        let chats = crate::messenger_ingest::chats::sync_chats(
            &env.dbx,
            ingest,
            MessengerIngestChatsSyncReq {
                account: account.clone(),
                created: vec![MessengerIngestChatInput {
                    external_id: external_id.to_string(),
                    chat_type: None,
                    title: None,
                    username: None,
                    members_count: None,
                    account_member_status: None,
                    last_message_date: None,
                    telegram: None,
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap();
        let chat = chats.created.into_values().next().unwrap();
        MessengerIngestChatRef {
            id: chat.id,
            external_id: chat.external_id,
            telegram: chat.telegram,
        }
    }

    async fn submit(
        env: &Env,
        ingest: &IngestScope,
        account: &MessengerIngestAccountRef,
        chat: &MessengerIngestChatRef,
        messages: &[(&str, i64)],
    ) {
        crate::messenger_ingest::messages::submit_messages(
            env,
            ingest,
            MessengerIngestMessagesSubmitReq {
                account: account.clone(),
                chat: chat.clone(),
                messages: messages
                    .iter()
                    .map(|(external_id, date)| MessengerIngestMessageInput {
                        external_id: (*external_id).to_owned(),
                        date: 1_760_431_000_000 + date,
                        text: None,
                        is_outgoing: None,
                        has_media: Some(true),
                        sender: None,
                        telegram: None,
                    })
                    .collect(),
            },
        )
        .await
        .unwrap();
    }

    async fn chat_message(
        env: &Env,
        chat_id: Uuid,
        external_id: &str,
    ) -> sigint_chat_message::Model {
        sigint_chat_message::Entity::find()
            .filter(sigint_chat_message::Column::MessengerChatId.eq(chat_id))
            .filter(
                sigint_chat_message::Column::MessengerExternalId
                    .eq(external_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
    }

    /// Stores the rows an ingest attach leaves, without the media content.
    async fn attach(
        env: &Env,
        account_id: Uuid,
        chat_message: &sigint_chat_message::Model,
        index: usize,
    ) -> Uuid {
        let media_id = Uuid::now_v7();
        let now = Utc::now().naive_utc();
        signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(chat_message.id),
            content_type: Set("image/jpeg".to_string()),
            file_ext: Set(Some("jpg".to_string())),
            file_name: Set(Some(format!("photo-{index}.jpg"))),
            size_bytes: Set(10),
            created_at: Set(now),
            is_encrypted: Set(true),
            storage_key: Set(None),
            signal_message_uuid: Set(None),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        messenger_media_meta::ActiveModel {
            id: Set(media_id),
            sigint_chat_message_id: Set(chat_message.id),
            external_id: Set(format!(
                "{}:{index}",
                chat_message.messenger_external_id
            )),
            telegram_file_id: Set(None),
            telegram_media_type: Set(None),
            external_created_at: Set(None),
            created_at: Set(now),
            messenger_account_id: Set(account_id),
            messenger_chat_id: Set(chat_message.messenger_chat_id),
            messenger_sent_at: Set(chat_message.messenger_sent_at),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        media_id
    }

    fn request(
        fixture: &Fixture,
        chat_id: Option<Uuid>,
        cursor: Option<String>,
        direction: Option<MessengersMessagesDirection>,
    ) -> MessengersAttachmentsListReq {
        MessengersAttachmentsListReq {
            account_id: fixture.account_id.to_string(),
            chat_id: chat_id.map(|chat_id| chat_id.to_string()),
            cursor,
            limit: Some(2),
            direction,
            telegram_media_type: None,
        }
    }

    async fn list(
        fixture: &Fixture,
        req: MessengersAttachmentsListReq,
    ) -> Result<MessengersAttachmentsListRsp, AppError> {
        list_attachments(&fixture.env, &fixture.scope, req).await
    }

    fn media_ids(rsp: &MessengersAttachmentsListRsp) -> Vec<Uuid> {
        rsp.items
            .iter()
            .map(|item| Uuid::parse_str(&item.attachment.media.id).unwrap())
            .collect()
    }

    /// Pages from the newest attachment with `Older` until none remain.
    async fn walk_older(fixture: &Fixture, chat_id: Option<Uuid>) -> Vec<Uuid> {
        let mut seen = vec![];
        let mut cursor = None;
        loop {
            let direction =
                cursor.as_ref().map(|_| MessengersMessagesDirection::Older);
            let rsp =
                list(fixture, request(fixture, chat_id, cursor, direction))
                    .await
                    .unwrap();
            seen.extend(media_ids(&rsp));
            let Some(older) = rsp.older_cursor else {
                return seen;
            };
            cursor = Some(older);
        }
    }

    /// Pages from the oldest attachment with `Newer` until a page is empty.
    async fn walk_newer(fixture: &Fixture, chat_id: Option<Uuid>) -> Vec<Uuid> {
        let first = list(
            fixture,
            request(
                fixture,
                chat_id,
                None,
                Some(MessengersMessagesDirection::Oldest),
            ),
        )
        .await
        .unwrap();
        assert_eq!(first.older_cursor, None);
        let mut pages = vec![media_ids(&first)];
        let mut cursor = first.newer_cursor.unwrap();
        loop {
            let rsp = list(
                fixture,
                request(
                    fixture,
                    chat_id,
                    Some(cursor.clone()),
                    Some(MessengersMessagesDirection::Newer),
                ),
            )
            .await
            .unwrap();
            if rsp.items.is_empty() {
                // Nothing new: both cursors repeat the request's cursor.
                assert_eq!(rsp.older_cursor.as_ref(), Some(&cursor));
                assert_eq!(rsp.newer_cursor.as_ref(), Some(&cursor));
                break;
            }
            pages.push(media_ids(&rsp));
            cursor = rsp.newer_cursor.unwrap();
        }
        // Pages are newest first, so the newest page comes first.
        pages.into_iter().rev().flatten().collect()
    }

    #[tokio::test]
    #[serial]
    async fn attachments_page_through_the_account_and_a_chat() {
        let fixture = fixture().await;
        let account_timeline = fixture
            .timeline
            .iter()
            .map(|(_, media_id, _)| *media_id)
            .collect::<Vec<_>>();
        assert_eq!(account_timeline.len(), 5);
        assert_eq!(walk_older(&fixture, None).await, account_timeline);
        assert_eq!(walk_newer(&fixture, None).await, account_timeline);

        let chat_id = fixture.chats[0];
        let chat_timeline = fixture
            .timeline
            .iter()
            .filter(|(_, _, chat)| *chat == chat_id)
            .map(|(_, media_id, _)| *media_id)
            .collect::<Vec<_>>();
        assert_eq!(chat_timeline.len(), 4);
        assert_eq!(walk_older(&fixture, Some(chat_id)).await, chat_timeline);
        assert_eq!(walk_newer(&fixture, Some(chat_id)).await, chat_timeline);

        let rsp = list(&fixture, request(&fixture, Some(chat_id), None, None))
            .await
            .unwrap();
        let item = &rsp.items[0];
        assert_eq!(item.chat_id, chat_id.to_string());
        let message = signal_message::Entity::find_by_id(fixture.timeline[0].0)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(item.message_id, message.id_uuid.unwrap().to_string());
        assert_eq!(item.attachment.external_id.split(':').count(), 2);
    }

    #[tokio::test]
    #[serial]
    async fn attachments_leave_out_deleted_messages_and_chats() {
        let fixture = fixture().await;
        let (deleted_message, _, _) = fixture.timeline[0];
        signal_message::Entity::update_many()
            .col_expr(signal_message::Column::Deleted, Expr::value(true))
            .filter(signal_message::Column::Id.eq(deleted_message))
            .exec(&fixture.env.dbx)
            .await
            .unwrap();
        messenger_chat::Entity::update_many()
            .col_expr(messenger_chat::Column::Deleted, Expr::value(true))
            .filter(messenger_chat::Column::Id.eq(fixture.chats[1]))
            .exec(&fixture.env.dbx)
            .await
            .unwrap();
        let expected = fixture
            .timeline
            .iter()
            .filter(|(message_id, _, chat_id)| {
                *message_id != deleted_message && *chat_id != fixture.chats[1]
            })
            .map(|(_, media_id, _)| *media_id)
            .collect::<Vec<_>>();
        assert!(expected.len() < fixture.timeline.len() - 1);
        assert_eq!(walk_older(&fixture, None).await, expected);

        let error = list(
            &fixture,
            request(&fixture, Some(fixture.chats[1]), None, None),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::NotFound), "{error:?}");
    }

    #[tokio::test]
    #[serial]
    async fn attachments_reject_invalid_requests() {
        let fixture = fixture().await;
        let mut req = request(&fixture, None, Some("1_2".to_string()), None);
        let error = list(&fixture, req.clone()).await.unwrap_err();
        assert!(matches!(error, AppError::BL { .. }), "{error:?}");

        req.cursor = Some(walk_cursor(&fixture).await);
        req.direction = Some(MessengersMessagesDirection::Oldest);
        let error = list(&fixture, req).await.unwrap_err();
        assert!(matches!(error, AppError::BL { .. }), "{error:?}");

        let mut req = request(&fixture, None, None, None);
        req.limit = Some(MESSENGERS_ATTACHMENTS_MAX_LIMIT + 1);
        let error = list(&fixture, req).await.unwrap_err();
        assert!(matches!(error, AppError::BL { .. }), "{error:?}");

        let req = request(&fixture, Some(Uuid::now_v7()), None, None);
        let error = list(&fixture, req).await.unwrap_err();
        assert!(matches!(error, AppError::NotFound), "{error:?}");

        let outsider = MessengersScope {
            login_id: fixture.scope.login_id,
            group_master_keys: vec![],
        };
        let req = request(&fixture, None, None, None);
        let error = list_attachments(&fixture.env, &outsider, req)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound), "{error:?}");
    }

    async fn walk_cursor(fixture: &Fixture) -> String {
        list(fixture, request(fixture, None, None, None))
            .await
            .unwrap()
            .older_cursor
            .unwrap()
    }
}

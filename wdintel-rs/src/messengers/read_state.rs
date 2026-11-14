use crate::entities::{
    messenger_chat, messenger_chat_read_state, sigint_chat_message,
};
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::chats::resolve_chat;
use crate::messengers::types::{
    MessengersChatReadState, MessengersChatReadStateGetReq,
    MessengersChatReadStateUpdateReq, MessengersChatsMarkAllReadReq,
};
use crate::types::ShortContext;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use sea_orm::sea_query::{
    Alias, Asterisk, Expr, Func, IntoCondition, OnConflict, Query,
    SelectStatement, SimpleExpr, SubQueryStatement,
};
use sea_orm::*;
use uuid::Uuid;

// A login's read state of a chat is the span of the chat timeline
// (`messenger_sent_at`) it has read, bounds included. Messages outside the
// span are unread, and a chat without a read state is unread entirely.
//
// Counts read only `sigint_chat_message`, never `signal_message`: messenger
// ingest does not soft-delete messages, and skipping the `deleted` check
// keeps every count an index-only range scan on
// `sigint_chat_message_chat_timeline_idx`.

pub(crate) const OLDEST_READ_AT: &str = "oldest_read_at";
pub(crate) const NEWEST_READ_AT: &str = "newest_read_at";
pub(crate) const UNREAD_COUNT: &str = "unread_count";

#[derive(FromQueryResult)]
struct ReadStateRow {
    oldest_read_at: Option<NaiveDateTime>,
    newest_read_at: Option<NaiveDateTime>,
    unread_count: i64,
}

/// Adds the caller's read state of each chat to a chat query: the read
/// bounds as `oldest_read_at` and `newest_read_at`, and `unread_count`.
pub(crate) fn with_read_state(
    select: Select<messenger_chat::Entity>,
    login_id: Uuid,
) -> Select<messenger_chat::Entity> {
    let read_state = messenger_chat::Relation::MessengerChatReadState
        .def()
        .on_condition(move |_left, right| {
            Expr::col((right, messenger_chat_read_state::Column::LoginId))
                .eq(login_id)
                .into_condition()
        });
    select
        .join(JoinType::LeftJoin, read_state)
        .column_as(
            Expr::col((
                messenger_chat_read_state::Entity,
                messenger_chat_read_state::Column::OldestReadAt,
            )),
            OLDEST_READ_AT,
        )
        .column_as(
            Expr::col((
                messenger_chat_read_state::Entity,
                messenger_chat_read_state::Column::NewestReadAt,
            )),
            NEWEST_READ_AT,
        )
        .column_as(unread_count_expr(), UNREAD_COUNT)
}

/// Each bound is its own subquery, so PostgreSQL applies it as a range on the
/// timeline index (`messenger_chat_id = c.id AND messenger_sent_at < bound`).
/// A single `count(*)` filtered by `bound IS NULL OR sent_at < oldest OR
/// sent_at > newest` cannot use the bounds in the index condition and walks
/// the whole chat. `CASE` only runs the subqueries of the branch it takes.
///
/// ```sql
/// CASE WHEN messenger_chat_read_state.login_id IS NULL
///   THEN (SELECT COUNT(*) FROM sigint_chat_message
///         WHERE sigint_chat_message.messenger_chat_id = messenger_chat.id)
///   ELSE (SELECT COUNT(*) FROM sigint_chat_message
///         WHERE sigint_chat_message.messenger_chat_id = messenger_chat.id
///           AND sigint_chat_message.messenger_sent_at
///               < messenger_chat_read_state.oldest_read_at)
///      + (SELECT COUNT(*) FROM sigint_chat_message
///         WHERE sigint_chat_message.messenger_chat_id = messenger_chat.id
///           AND sigint_chat_message.messenger_sent_at
///               > messenger_chat_read_state.newest_read_at)
/// END
/// ```
fn unread_count_expr() -> SimpleExpr {
    let state_col =
        |column| Expr::col((messenger_chat_read_state::Entity, column));
    let sent_at = || {
        Expr::col((
            sigint_chat_message::Entity,
            sigint_chat_message::Column::MessengerSentAt,
        ))
    };
    let before_oldest = sent_at()
        .lt(state_col(messenger_chat_read_state::Column::OldestReadAt));
    let after_newest = sent_at()
        .gt(state_col(messenger_chat_read_state::Column::NewestReadAt));
    Expr::case(
        state_col(messenger_chat_read_state::Column::LoginId).is_null(),
        count_messages(None),
    )
    .finally(
        count_messages(Some(before_oldest))
            .add(count_messages(Some(after_newest))),
    )
    .into()
}

/// The messages of the chat in the enclosing `messenger_chat` row.
fn chat_messages() -> SelectStatement {
    Query::select()
        .from(sigint_chat_message::Entity)
        .and_where(
            Expr::col((
                sigint_chat_message::Entity,
                sigint_chat_message::Column::MessengerChatId,
            ))
            .equals((messenger_chat::Entity, messenger_chat::Column::Id)),
        )
        .to_owned()
}

fn count_messages(range: Option<SimpleExpr>) -> SimpleExpr {
    let mut query = chat_messages();
    query.expr(Expr::col(Asterisk).count());
    if let Some(range) = range {
        query.and_where(range);
    }
    sub_query(query)
}

/// The send time of the chat's oldest (`Asc`) or newest (`Desc`) message,
/// one probe of the timeline index.
fn edge_sent_at(order: Order) -> SimpleExpr {
    let sent_at = (
        sigint_chat_message::Entity,
        sigint_chat_message::Column::MessengerSentAt,
    );
    let mut query = chat_messages();
    query.column(sent_at).order_by(sent_at, order).limit(1);
    sub_query(query)
}

fn sub_query(query: SelectStatement) -> SimpleExpr {
    SimpleExpr::SubQuery(
        None,
        Box::new(SubQueryStatement::SelectStatement(query)),
    )
}

pub(crate) async fn get_read_state(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersChatReadStateGetReq,
) -> Result<MessengersChatReadState, AppError> {
    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let chat = resolve_chat(dbx, &account, &req.chat_id).await.c(h!())?;
    load_read_state(dbx, scope.login_id, chat.id).await
}

pub(crate) async fn update_read_state(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersChatReadStateUpdateReq,
) -> Result<MessengersChatReadState, AppError> {
    let (oldest, newest) =
        read_bounds(req.oldest_read_at, req.newest_read_at).c(h!())?;
    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let chat = resolve_chat(dbx, &account, &req.chat_id).await.c(h!())?;
    let state = read_state_model(scope.login_id, chat.id, oldest, newest);
    messenger_chat_read_state::Entity::insert(state)
        .on_conflict(widen_on_conflict())
        .exec(dbx)
        .await
        .c(h!())?;
    load_read_state(dbx, scope.login_id, chat.id).await
}

/// Rows per `mark_all_read` insert. Each row binds 5 parameters and a
/// PostgreSQL statement takes at most 65535, so one insert caps at 13107.
const MARK_ALL_READ_CHUNK: usize = 1000;

/// Marks every chat of the account read up to its newest message, from its
/// oldest one. Chats without messages have nothing to read and are skipped.
pub(crate) async fn mark_all_read(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersChatsMarkAllReadReq,
) -> Result<(), AppError> {
    #[derive(FromQueryResult)]
    struct ChatSpan {
        id: Uuid,
        oldest: Option<NaiveDateTime>,
        newest: Option<NaiveDateTime>,
    }

    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    let spans = messenger_chat::Entity::find()
        .select_only()
        .column(messenger_chat::Column::Id)
        .column_as(edge_sent_at(Order::Asc), "oldest")
        .column_as(edge_sent_at(Order::Desc), "newest")
        .filter(messenger_chat::Column::MessengerAccountId.eq(account.id))
        .filter(messenger_chat::Column::Deleted.eq(false))
        .into_model::<ChatSpan>()
        .all(&txn)
        .await
        .c(h!())?;
    let states = spans
        .into_iter()
        .filter_map(|span| {
            let (oldest, newest) = span.oldest.zip(span.newest)?;
            Some(read_state_model(scope.login_id, span.id, oldest, newest))
        })
        .collect::<Vec<_>>();
    for chunk in states.chunks(MARK_ALL_READ_CHUNK) {
        messenger_chat_read_state::Entity::insert_many(chunk.iter().cloned())
            .on_conflict(widen_on_conflict())
            .exec(&txn)
            .await
            .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn load_read_state(
    dbx: &DatabaseConnection,
    login_id: Uuid,
    chat_id: Uuid,
) -> Result<MessengersChatReadState, AppError> {
    let select = messenger_chat::Entity::find_by_id(chat_id).select_only();
    let row = with_read_state(select, login_id)
        .into_model::<ReadStateRow>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(MessengersChatReadState {
        oldest_read_at: row.oldest_read_at.map(epoch_ms),
        newest_read_at: row.newest_read_at.map(epoch_ms),
        unread_count: row.unread_count,
    })
}

/// The API carries milliseconds while send times have microseconds, so the
/// span covers the whole millisecond of each bound: every message the client
/// saw at that millisecond is read.
fn read_bounds(
    oldest_ms: i64,
    newest_ms: i64,
) -> Result<(NaiveDateTime, NaiveDateTime), AppError> {
    if oldest_ms > newest_ms {
        return Err(AppError::BL {
            msg: format!(
                "oldest_read_at {oldest_ms} is after newest_read_at \
                 {newest_ms}"
            ),
        });
    }
    let oldest = timestamp(oldest_ms, 0).c(h!())?;
    let newest = timestamp(newest_ms, 999).c(h!())?;
    Ok((oldest, newest))
}

/// `ms` plus `micros` microseconds within that millisecond.
fn timestamp(ms: i64, micros: i64) -> Result<NaiveDateTime, AppError> {
    DateTime::from_timestamp_millis(ms)
        .and_then(|dt| {
            dt.naive_utc()
                .checked_add_signed(Duration::microseconds(micros))
        })
        .ok_or_else(|| AppError::BL {
            msg: format!("invalid timestamp: {ms}"),
        })
}

fn epoch_ms(dt: NaiveDateTime) -> i64 {
    dt.and_utc().timestamp_millis()
}

fn read_state_model(
    login_id: Uuid,
    chat_id: Uuid,
    oldest: NaiveDateTime,
    newest: NaiveDateTime,
) -> messenger_chat_read_state::ActiveModel {
    messenger_chat_read_state::ActiveModel {
        login_id: Set(login_id),
        messenger_chat_id: Set(chat_id),
        oldest_read_at: Set(Some(oldest)),
        newest_read_at: Set(Some(newest)),
        updated_at: Set(Utc::now().naive_utc()),
    }
}

/// An existing span only widens, so a stale tab or a late request cannot
/// make read messages unread again. `LEAST` and `GREATEST` ignore NULLs.
fn widen_on_conflict() -> OnConflict {
    let merge = |func: &str, column: messenger_chat_read_state::Column| {
        Func::cust(Alias::new(func))
            .arg(Expr::col((messenger_chat_read_state::Entity, column)))
            .arg(Expr::col((Alias::new("excluded"), column)))
    };
    OnConflict::columns([
        messenger_chat_read_state::Column::LoginId,
        messenger_chat_read_state::Column::MessengerChatId,
    ])
    .value(
        messenger_chat_read_state::Column::OldestReadAt,
        merge("least", messenger_chat_read_state::Column::OldestReadAt),
    )
    .value(
        messenger_chat_read_state::Column::NewestReadAt,
        merge("greatest", messenger_chat_read_state::Column::NewestReadAt),
    )
    .update_column(messenger_chat_read_state::Column::UpdatedAt)
    .to_owned()
}

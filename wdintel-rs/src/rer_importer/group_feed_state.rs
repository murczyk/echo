use crate::error::AppError;
use crate::messenger::group::{
    get_identity_sigint_groups, types::SignalGroupColor,
};
use crate::types::*;
use crate::users::{ensure_base_role_by_id, login_id_from_identity};
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{get, post};
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
pub struct GroupFeedCursorDto {
    pub created_at: i64,
    pub message_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupFeedState {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub unread_count: i64,
    pub oldest_unread_message_ref: Option<String>,
    pub last_activity_at: Option<i64>,
    pub latest_cursor: Option<GroupFeedCursorDto>,
    pub color_key: SignalGroupColor,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupFeedStatesRsp {
    pub groups: Vec<GroupFeedState>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AcknowledgeGroupFeedReq {
    pub master_key: String,
    pub cursor: GroupFeedCursorDto,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupFeedCursor {
    pub created_at: NaiveDateTime,
    pub message_id: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupFeedStateRecord {
    pub group_master_key: String,
    pub group_name: Option<String>,
    pub ignore_operativny: bool,
    pub unread_count: i64,
    pub oldest_unread_message_ref: Option<Uuid>,
    pub last_activity_cursor: Option<GroupFeedCursor>,
    pub last_read_cursor: Option<GroupFeedCursor>,
    pub color_key: SignalGroupColor,
}

#[derive(FromQueryResult)]
struct GroupFeedStateRow {
    group_master_key: String,
    group_name: Option<String>,
    ignore_operativny: bool,
    unread_count: i64,
    oldest_unread_message_ref: Option<Uuid>,
    last_activity_created_at: Option<NaiveDateTime>,
    last_activity_message_id: Option<i64>,
    last_read_created_at: Option<NaiveDateTime>,
    last_read_message_id: Option<i64>,
    color_key: Option<String>,
}

impl GroupFeedStateRow {
    fn into_record(self) -> GroupFeedStateRecord {
        GroupFeedStateRecord {
            group_master_key: self.group_master_key,
            group_name: self.group_name,
            ignore_operativny: self.ignore_operativny,
            unread_count: self.unread_count,
            oldest_unread_message_ref: self.oldest_unread_message_ref,
            last_activity_cursor: cursor_from_parts(
                self.last_activity_created_at,
                self.last_activity_message_id,
            ),
            last_read_cursor: cursor_from_parts(
                self.last_read_created_at,
                self.last_read_message_id,
            ),
            color_key: SignalGroupColor::from_optional_db_value(
                self.color_key.as_deref(),
            )
            .unwrap_or(SignalGroupColor::BlueGrey),
        }
    }
}

fn cursor_from_parts(
    created_at: Option<NaiveDateTime>,
    message_id: Option<i64>,
) -> Option<GroupFeedCursor> {
    Some(GroupFeedCursor {
        created_at: created_at?,
        message_id: message_id?,
    })
}

pub async fn list_group_feed_states(
    dbx: &DatabaseConnection,
    login: Uuid,
) -> anyhow::Result<Vec<GroupFeedStateRecord>> {
    let txn = dbx.begin().await.c(h!())?;
    let group_master_keys =
        get_identity_sigint_groups(&txn, &login).await.c(h!())?;

    if group_master_keys.is_empty() {
        txn.commit().await.c(h!())?;
        return Ok(vec![]);
    }

    initialize_missing_states(&txn, login, &group_master_keys)
        .await
        .c(h!())?;
    let rows = load_states(&txn, login, &group_master_keys).await.c(h!())?;
    txn.commit().await.c(h!())?;

    Ok(rows
        .into_iter()
        .map(GroupFeedStateRow::into_record)
        .collect())
}

pub async fn list_group_feed_states_authorized(
    dbx: &DatabaseConnection,
    login: Uuid,
) -> Result<Vec<GroupFeedStateRecord>, AppError> {
    ensure_base_role_by_id(dbx, &login).await.c(h!())?;
    Ok(list_group_feed_states(dbx, login).await.c(h!())?)
}

async fn initialize_missing_states(
    txn: &DatabaseTransaction,
    login: Uuid,
    group_master_keys: &[String],
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
insert into user_group_feed_read_state (
    login_id,
    group_master_key,
    last_read_created_at,
    last_read_message_id
)
select
    $1,
    signal_group.master_key,
    latest.created_at,
    latest.id
from signal_group
left join lateral (
    select signal_message.created_at, signal_message.id
    from signal_message_group
    join signal_message
        on signal_message.id = signal_message_group.signal_message_id
    join sigint_inbox_item
        on sigint_inbox_item.id = signal_message.id
    where signal_message_group.group_master_key = signal_group.master_key
        and signal_message.deleted = false
    order by signal_message.created_at desc, signal_message.id desc
    limit 1
) latest on true
where signal_group.master_key = any($2)
on conflict (login_id, group_master_key) do nothing
        "#,
        vec![login.into(), group_master_keys.to_vec().into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn load_states(
    txn: &DatabaseTransaction,
    login: Uuid,
    group_master_keys: &[String],
) -> anyhow::Result<Vec<GroupFeedStateRow>> {
    GroupFeedStateRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
with messages as (
    select distinct
        signal_message_group.group_master_key,
        signal_message.created_at,
        signal_message.id,
        signal_message.id_uuid
    from signal_message_group
    join signal_message
        on signal_message.id = signal_message_group.signal_message_id
    join sigint_inbox_item
        on sigint_inbox_item.id = signal_message.id
    where signal_message_group.group_master_key = any($2)
        and signal_message.deleted = false
)
select
    signal_group.master_key as group_master_key,
    signal_group.name as group_name,
    signal_group.ignore_operativny,
    signal_group.color_key,
    count(messages.id) filter (
        where read_state.last_read_created_at is null
            or (messages.created_at, messages.id) > (
                read_state.last_read_created_at,
                read_state.last_read_message_id
            )
    )::bigint as unread_count,
    (array_agg(
        messages.id_uuid
        order by messages.created_at, messages.id
    ) filter (
        where read_state.last_read_created_at is null
            or (messages.created_at, messages.id) > (
                read_state.last_read_created_at,
                read_state.last_read_message_id
            )
    ))[1] as oldest_unread_message_ref,
    (array_agg(
        messages.created_at
        order by messages.created_at desc, messages.id desc
    ) filter (where messages.id is not null))[1] as last_activity_created_at,
    (array_agg(
        messages.id
        order by messages.created_at desc, messages.id desc
    ) filter (where messages.id is not null))[1] as last_activity_message_id,
    read_state.last_read_created_at,
    read_state.last_read_message_id
from user_group_feed_read_state read_state
join signal_group
    on signal_group.master_key = read_state.group_master_key
left join messages
    on messages.group_master_key = read_state.group_master_key
where read_state.login_id = $1
    and read_state.group_master_key = any($2)
group by
    signal_group.master_key,
    signal_group.name,
    signal_group.ignore_operativny,
    signal_group.color_key,
    read_state.last_read_created_at,
    read_state.last_read_message_id
order by
    last_activity_created_at desc nulls last,
    last_activity_message_id desc nulls last,
    signal_group.name nulls last,
    signal_group.master_key
        "#,
        vec![login.into(), group_master_keys.to_vec().into()],
    ))
    .all(txn)
    .await
    .c(h!())
}

pub async fn acknowledge_group_feed_tail(
    dbx: &DatabaseConnection,
    login: Uuid,
    group_master_key: &str,
    cursor: GroupFeedCursor,
) -> anyhow::Result<GroupFeedStateRecord> {
    let txn = dbx.begin().await.c(h!())?;
    if !is_group_accessible(&txn, login, group_master_key)
        .await
        .c(h!())?
    {
        anyhow::bail!("group is not accessible");
    }

    upsert_read_state(&txn, login, group_master_key, &cursor)
        .await
        .c(h!())?;
    let state = load_group_state(&txn, login, group_master_key)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(state)
}

async fn is_group_accessible(
    txn: &DatabaseTransaction,
    login: Uuid,
    group_master_key: &str,
) -> anyhow::Result<bool> {
    Ok(get_identity_sigint_groups(txn, &login)
        .await
        .c(h!())?
        .iter()
        .any(|master_key| master_key == group_master_key))
}

async fn upsert_read_state(
    txn: &DatabaseTransaction,
    login: Uuid,
    group_master_key: &str,
    cursor: &GroupFeedCursor,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
insert into user_group_feed_read_state (
    login_id,
    group_master_key,
    last_read_created_at,
    last_read_message_id
)
values ($1, $2, $3, $4)
on conflict (login_id, group_master_key) do update
set
    last_read_created_at = excluded.last_read_created_at,
    last_read_message_id = excluded.last_read_message_id,
    updated_at = now() at time zone 'utc'
where user_group_feed_read_state.last_read_created_at is null
    or (
        user_group_feed_read_state.last_read_created_at,
        user_group_feed_read_state.last_read_message_id
    ) < (
        excluded.last_read_created_at,
        excluded.last_read_message_id
    )
        "#,
        vec![
            login.into(),
            group_master_key.into(),
            cursor.created_at.into(),
            cursor.message_id.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn load_group_state(
    txn: &DatabaseTransaction,
    login: Uuid,
    group_master_key: &str,
) -> anyhow::Result<GroupFeedStateRecord> {
    let group_master_keys = [group_master_key.to_string()];
    load_states(txn, login, &group_master_keys)
        .await
        .c(h!())?
        .into_iter()
        .next()
        .map(GroupFeedStateRow::into_record)
        .c(h!())
}

#[derive(FromQueryResult)]
struct LatestGroupCursorRow {
    created_at: NaiveDateTime,
    message_id: i64,
}

async fn load_latest_group_cursor(
    txn: &DatabaseTransaction,
    group_master_key: &str,
) -> anyhow::Result<Option<GroupFeedCursor>> {
    Ok(
        LatestGroupCursorRow::find_by_statement(
            Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
select messages.created_at, messages.id as message_id
from (
    select distinct
        signal_message.created_at,
        signal_message.id
    from signal_message_group
    join signal_message
        on signal_message.id = signal_message_group.signal_message_id
    join sigint_inbox_item
        on sigint_inbox_item.id = signal_message.id
    where signal_message_group.group_master_key = $1
        and signal_message.deleted = false
) messages
order by messages.created_at desc, messages.id desc
limit 1
            "#,
                [group_master_key.into()],
            ),
        )
        .one(txn)
        .await
        .c(h!())?
        .map(|row| GroupFeedCursor {
            created_at: row.created_at,
            message_id: row.message_id,
        }),
    )
}

pub async fn acknowledge_current_group_feed_tail(
    dbx: &DatabaseConnection,
    login: Uuid,
    group_master_key: &str,
    cursor: GroupFeedCursor,
) -> Result<GroupFeedStateRecord, AppError> {
    ensure_base_role_by_id(dbx, &login).await.c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    if !is_group_accessible(&txn, login, group_master_key)
        .await
        .c(h!())?
    {
        return Err(AppError::Forbidden("group is not accessible".to_string()));
    }

    let latest_cursor = load_latest_group_cursor(&txn, group_master_key)
        .await
        .c(h!())?;
    if latest_cursor.as_ref() != Some(&cursor) {
        return Err(AppError::ConflictJson {
            body: serde_json::json!({
                "message": "group feed tail has changed",
                "latest_cursor": latest_cursor.map(cursor_to_dto),
            }),
        });
    }

    upsert_read_state(&txn, login, group_master_key, &cursor)
        .await
        .c(h!())?;
    let state = load_group_state(&txn, login, group_master_key)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(state)
}

fn cursor_to_dto(cursor: GroupFeedCursor) -> GroupFeedCursorDto {
    GroupFeedCursorDto {
        created_at: cursor.created_at.and_utc().timestamp_millis(),
        message_id: cursor.message_id,
    }
}

fn cursor_from_dto(
    cursor: GroupFeedCursorDto,
) -> Result<GroupFeedCursor, AppError> {
    let created_at = chrono::DateTime::from_timestamp_millis(cursor.created_at)
        .map(|created_at| created_at.naive_utc())
        .ok_or_else(|| AppError::BadRequestJson {
            body: serde_json::json!({
                "message": "invalid group feed cursor timestamp",
            }),
        })
        .c(h!())?;
    Ok(GroupFeedCursor {
        created_at,
        message_id: cursor.message_id,
    })
}

fn record_to_dto(record: GroupFeedStateRecord) -> GroupFeedState {
    GroupFeedState {
        name: record
            .group_name
            .unwrap_or_else(|| record.group_master_key.clone()),
        master_key: record.group_master_key,
        ignore_operativny: record.ignore_operativny,
        unread_count: record.unread_count,
        oldest_unread_message_ref: record
            .oldest_unread_message_ref
            .map(|reference| reference.to_string()),
        last_activity_at: record
            .last_activity_cursor
            .as_ref()
            .map(|cursor| cursor.created_at.and_utc().timestamp_millis()),
        latest_cursor: record.last_activity_cursor.map(cursor_to_dto),
        color_key: record.color_key,
    }
}

#[get("/api/rer-importer/group-feed-state")]
pub async fn group_feed_states(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<GroupFeedStatesRsp>, AppError> {
    let login = login_id_from_identity(&user).c(h!())?;
    let groups = list_group_feed_states_authorized(&env.dbx, login)
        .await
        .c(h!())?
        .into_iter()
        .map(record_to_dto)
        .collect();
    Ok(Json(GroupFeedStatesRsp { groups }))
}

#[post("/api/rer-importer/group-feed-state/acknowledge")]
pub async fn acknowledge_group_feed_state(
    user: Identity,
    env: Data<Env>,
    request: Json<AcknowledgeGroupFeedReq>,
) -> Result<Json<GroupFeedState>, AppError> {
    let login = login_id_from_identity(&user).c(h!())?;
    let cursor = cursor_from_dto(request.cursor.clone()).c(h!())?;
    let state = acknowledge_current_group_feed_tail(
        &env.dbx,
        login,
        &request.master_key,
        cursor,
    )
    .await
    .c(h!())?;
    Ok(Json(record_to_dto(state)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::*;
    use crate::functest::tests::*;
    use chrono::{NaiveDate, NaiveDateTime};
    use sea_orm::sea_query::Expr;

    fn at(second: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2035, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, second)
            .unwrap()
    }

    async fn add_message(
        dbx: &DatabaseConnection,
        group_master_key: &str,
        created_at: NaiveDateTime,
    ) -> signal_message::Model {
        let datasource_group = find_test_datasource_group(dbx).await.unwrap();
        let message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                created_at: Set(created_at),
                timestamp: Set(Some(created_at)),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group_master_key.to_string())),
                created_at: Set(created_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        message
    }

    #[tokio::test]
    async fn group_feed_state_returns_persisted_color() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        crate::messenger::group::set_signal_group_color(
            &env.dbx,
            &group.master_key,
            SignalGroupColor::Cyan,
        )
        .await
        .unwrap();

        let state = list_group_feed_states(&env.dbx, login.id)
            .await
            .unwrap()
            .into_iter()
            .find(|state| state.group_master_key == group.master_key)
            .unwrap();

        assert_eq!(state.color_key, SignalGroupColor::Cyan);
    }

    #[tokio::test]
    async fn first_list_initializes_existing_messages_as_read() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let message = add_message(&env.dbx, &group.master_key, at(1)).await;

        let states = list_group_feed_states(&env.dbx, login.id).await.unwrap();
        let state = states
            .iter()
            .find(|state| state.group_master_key == group.master_key)
            .unwrap();

        assert_eq!(state.unread_count, 0);
        assert_eq!(
            state.last_read_cursor.as_ref().unwrap().message_id,
            message.id
        );
    }

    #[tokio::test]
    async fn new_messages_increment_only_their_accessible_group() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        list_group_feed_states(&env.dbx, login.id).await.unwrap();

        add_message(&env.dbx, &group.master_key, at(2)).await;
        let inaccessible_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                name: Set(Some("Недоступна".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        add_message(&env.dbx, &inaccessible_group.master_key, at(3)).await;

        let states = list_group_feed_states(&env.dbx, login.id).await.unwrap();

        assert_eq!(
            states.iter().map(|state| state.unread_count).sum::<i64>(),
            1
        );
        assert!(!states.iter().any(
            |state| state.group_master_key == inaccessible_group.master_key
        ));
    }

    #[tokio::test]
    async fn oldest_unread_uses_created_at_then_id() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        list_group_feed_states(&env.dbx, login.id).await.unwrap();

        let first = add_message(&env.dbx, &group.master_key, at(4)).await;
        add_message(&env.dbx, &group.master_key, at(4)).await;

        let states = list_group_feed_states(&env.dbx, login.id).await.unwrap();
        let state = states
            .iter()
            .find(|state| state.group_master_key == group.master_key)
            .unwrap();

        assert_eq!(state.unread_count, 2);
        assert_eq!(state.oldest_unread_message_ref, first.id_uuid);
    }

    #[tokio::test]
    async fn acknowledgement_is_monotonic_and_idempotent() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        list_group_feed_states(&env.dbx, login.id).await.unwrap();
        let first = add_message(&env.dbx, &group.master_key, at(5)).await;
        let second = add_message(&env.dbx, &group.master_key, at(6)).await;

        let latest = GroupFeedCursor {
            created_at: second.created_at,
            message_id: second.id,
        };
        acknowledge_group_feed_tail(
            &env.dbx,
            login.id,
            &group.master_key,
            latest.clone(),
        )
        .await
        .unwrap();
        acknowledge_group_feed_tail(
            &env.dbx,
            login.id,
            &group.master_key,
            GroupFeedCursor {
                created_at: first.created_at,
                message_id: first.id,
            },
        )
        .await
        .unwrap();

        let state = list_group_feed_states(&env.dbx, login.id)
            .await
            .unwrap()
            .into_iter()
            .find(|state| state.group_master_key == group.master_key)
            .unwrap();
        assert_eq!(state.last_read_cursor, Some(latest));
        assert_eq!(state.unread_count, 0);
    }

    #[tokio::test]
    async fn deleted_boundary_message_does_not_move_cursor_backwards() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        list_group_feed_states(&env.dbx, login.id).await.unwrap();
        let message = add_message(&env.dbx, &group.master_key, at(7)).await;
        let cursor = GroupFeedCursor {
            created_at: message.created_at,
            message_id: message.id,
        };
        acknowledge_group_feed_tail(
            &env.dbx,
            login.id,
            &group.master_key,
            cursor.clone(),
        )
        .await
        .unwrap();
        signal_message::Entity::update_many()
            .col_expr(signal_message::Column::Deleted, Expr::value(true))
            .filter(signal_message::Column::Id.eq(message.id))
            .exec(&env.dbx)
            .await
            .unwrap();

        let state = list_group_feed_states(&env.dbx, login.id)
            .await
            .unwrap()
            .into_iter()
            .find(|state| state.group_master_key == group.master_key)
            .unwrap();
        assert_eq!(state.last_read_cursor, Some(cursor));
        assert_eq!(state.unread_count, 0);
    }

    #[tokio::test]
    async fn concurrent_initialization_creates_one_row_per_user_and_group() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();

        let (left, right) = tokio::join!(
            list_group_feed_states(&env.dbx, login.id),
            list_group_feed_states(&env.dbx, login.id),
        );
        left.unwrap();
        right.unwrap();

        #[derive(FromQueryResult)]
        struct Counts {
            rows: i64,
            groups: i64,
        }
        let counts = Counts::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select
    count(*)::bigint as rows,
    count(distinct group_master_key)::bigint as groups
from user_group_feed_read_state
where login_id = $1
            "#,
            [login.id.into()],
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(counts.rows, counts.groups);
    }

    #[tokio::test]
    async fn group_feed_state_excludes_inaccessible_groups() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let inaccessible_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                name: Set(Some("Недоступна".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let states = list_group_feed_states_authorized(&env.dbx, login.id)
            .await
            .unwrap();

        assert!(!states.iter().any(|state| {
            state.group_master_key == inaccessible_group.master_key
        }));
    }

    #[tokio::test]
    async fn group_feed_state_requires_base_role() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!([])),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(list_group_feed_states_authorized(&env.dbx, login.id)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn acknowledge_rejects_inaccessible_group() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let inaccessible_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(acknowledge_current_group_feed_tail(
            &env.dbx,
            login.id,
            &inaccessible_group.master_key,
            GroupFeedCursor {
                created_at: at(8),
                message_id: 1,
            },
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn acknowledge_rejects_a_stale_or_non_tail_cursor() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        list_group_feed_states(&env.dbx, login.id).await.unwrap();
        let first = add_message(&env.dbx, &group.master_key, at(9)).await;
        add_message(&env.dbx, &group.master_key, at(10)).await;

        let result = acknowledge_current_group_feed_tail(
            &env.dbx,
            login.id,
            &group.master_key,
            GroupFeedCursor {
                created_at: first.created_at,
                message_id: first.id,
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(crate::error::AppError::ConflictJson { .. })
        ));
    }

    #[tokio::test]
    async fn acknowledge_returns_the_committed_count() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        list_group_feed_states(&env.dbx, login.id).await.unwrap();
        add_message(&env.dbx, &group.master_key, at(11)).await;
        let latest = add_message(&env.dbx, &group.master_key, at(12)).await;

        let state = acknowledge_current_group_feed_tail(
            &env.dbx,
            login.id,
            &group.master_key,
            GroupFeedCursor {
                created_at: latest.created_at,
                message_id: latest.id,
            },
        )
        .await
        .unwrap();

        assert_eq!(state.unread_count, 0);
        assert_eq!(state.last_read_cursor.unwrap().message_id, latest.id);
    }
}

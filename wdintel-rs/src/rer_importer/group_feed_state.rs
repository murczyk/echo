use crate::messenger::group::get_identity_sigint_groups;
use crate::types::*;
use chrono::NaiveDateTime;
use sea_orm::*;
use uuid::Uuid;

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

    initialize_missing_states(&txn, login, &group_master_keys).await?;
    let rows = load_states(&txn, login, &group_master_keys).await?;
    txn.commit().await.c(h!())?;

    Ok(rows
        .into_iter()
        .map(GroupFeedStateRow::into_record)
        .collect())
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
    let group_master_keys =
        get_identity_sigint_groups(&txn, &login).await.c(h!())?;
    if !group_master_keys
        .iter()
        .any(|master_key| master_key == group_master_key)
    {
        anyhow::bail!("group is not accessible");
    }

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
    txn.commit().await.c(h!())?;

    list_group_feed_states(dbx, login)
        .await?
        .into_iter()
        .find(|state| state.group_master_key == group_master_key)
        .c(h!())
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
}

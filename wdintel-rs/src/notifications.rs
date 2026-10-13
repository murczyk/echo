use crate::config::{
    NOTIFICATION_READ_BOUNDARY_MAX_PER_RECIPIENT,
    NOTIFICATION_READ_BOUNDARY_TTL_MINUTES,
};
use crate::error::AppError;
use crate::types::*;
use crate::users::{ensure_base_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{get, post, web::Json};
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, FromQueryResult, Statement,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const PAGE_SIZE: u64 = 20;
const MAX_RECONCILED_RECEIPTS: usize = 100;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationListReq {
    pub cursor: Option<Uuid>,
    pub boundary_id: Option<Uuid>,
    pub panel_id: Uuid,
    #[serde(default)]
    pub known_receipt_ids: Vec<Uuid>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationQuote {
    pub message_id: i64,
    pub message_uuid: Option<String>,
    pub message_uid: Option<String>,
    pub text: String,
    pub attachments_count: i64,
    pub media_file_names: Vec<String>,
    pub coords: Option<String>,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationItem {
    pub receipt_id: Uuid,
    pub event_id: Uuid,
    pub actor_id: Uuid,
    pub actor_login: Option<String>,
    pub group_name: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub quote: NotificationQuote,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationListRsp {
    pub items: Vec<NotificationItem>,
    pub unread_count: i64,
    pub next_cursor: Option<Uuid>,
    pub mark_all_boundary: Option<Uuid>,
    pub removed_receipt_ids: Vec<Uuid>,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationUnreadCountRsp {
    pub unread_count: i64,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationReadAllRsp {
    pub outcome: NotificationReadAllOutcome,
    pub unread_count: i64,
    pub receipt_ids: Vec<Uuid>,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum NotificationReadAllOutcome {
    NotificationReadAllApplied,
    NotificationReadAllAlreadyCompleted,
    NotificationReadAllBoundaryExpired,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationReadReq {
    pub receipt_id: Uuid,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NotificationReadAllReq {
    pub boundary_receipt_id: Uuid,
}

#[derive(FromQueryResult)]
struct NotificationRow {
    receipt_id: Uuid,
    event_id: Uuid,
    message_id: i64,
    actor_id: Uuid,
    actor_login: Option<String>,
    group_name: Option<String>,
    created_at: NaiveDateTime,
    read_at: Option<NaiveDateTime>,
    message_uuid: Option<Uuid>,
    message_uid: Option<String>,
    body: Option<String>,
    attachments_count: i64,
    media_file_names: Vec<String>,
    coords: Option<String>,
    group_master_key: String,
}

async fn allowed_groups<'a, 'async_trait, C>(
    dbx: &'a C,
    login: Uuid,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(
        crate::messenger::group::get_identity_sigint_groups(dbx, &login)
            .await
            .c(h!())?,
    )
}

async fn visible_rows<C>(
    dbx: &C,
    login: Uuid,
    groups: &[String],
    cursor: Option<Uuid>,
) -> Result<Vec<NotificationRow>, AppError>
where
    C: ConnectionTrait,
{
    if groups.is_empty() {
        return Ok(vec![]);
    }
    let groups_param = if cursor.is_some() { "$3" } else { "$2" };
    let cursor_sql = if cursor.is_some() {
        "and (nr.created_at, ne.id) < ((select nr2.created_at from notification_receipt nr2 where nr2.event_id = $2 and nr2.recipient_login_id = $1), $2)"
    } else {
        ""
    };
    let sql = format!("select nr.id receipt_id, ne.id event_id, ne.signal_message_id message_id, ne.actor_login_id actor_id, coalesce(l.login, ne.actor_login_snapshot) actor_login, coalesce(sg.name, ne.group_name_snapshot, ne.group_master_key) group_name, ne.created_at, nr.read_at, sm.id_uuid message_uuid, sm.message_uid, sm.body, coalesce(media.attachments_count, 0) attachments_count, coalesce(media.file_names, '{{}}') media_file_names, sii.coords, ne.group_master_key from notification_receipt nr join notification_event ne on ne.id = nr.event_id join signal_message sm on sm.id = ne.signal_message_id left join login l on l.id = ne.actor_login_id left join signal_group sg on sg.master_key = ne.group_master_key left join sigint_inbox_item sii on sii.id = sm.id left join lateral (select count(*)::bigint attachments_count, array_agg(smm.file_name) filter (where smm.file_name is not null and smm.file_name <> '') file_names from signal_message_media smm where smm.signal_message_id = sm.id) media on true where nr.recipient_login_id = $1 and sm.deleted = false and ne.group_master_key = any({groups_param}) and exists (select 1 from signal_message_group smg where smg.signal_message_id = ne.signal_message_id and smg.group_master_key = ne.group_master_key) {cursor_sql} order by nr.created_at desc, ne.id desc limit {}", PAGE_SIZE + 1);
    let mut values = vec![login.into()];
    if let Some(cursor) = cursor {
        values.push(cursor.into());
    }
    values.push(groups.to_vec().into());
    Ok(
        NotificationRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .all(dbx)
        .await
        .c(h!())?,
    )
}

async fn unread_count<C>(
    dbx: &C,
    login: Uuid,
    groups: &[String],
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    if groups.is_empty() {
        return Ok(0);
    }
    #[derive(FromQueryResult)]
    struct Count {
        count: i64,
    }
    let row = Count::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres, "select count(*)::bigint count from notification_receipt nr join notification_event ne on ne.id = nr.event_id join signal_message sm on sm.id = ne.signal_message_id where nr.recipient_login_id = $1 and nr.read_at is null and sm.deleted = false and ne.group_master_key = any($2) and exists (select 1 from signal_message_group smg where smg.signal_message_id = ne.signal_message_id and smg.group_master_key = ne.group_master_key)", vec![login.into(), groups.to_vec().into()])).one(dbx).await.c(h!())?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

async fn removed_receipt_ids<C>(
    dbx: &C,
    login: Uuid,
    groups: &[String],
    known_receipt_ids: &[Uuid],
) -> Result<Vec<Uuid>, AppError>
where
    C: ConnectionTrait,
{
    if known_receipt_ids.is_empty() {
        return Ok(vec![]);
    }
    if groups.is_empty() {
        return Ok(known_receipt_ids.to_vec());
    }
    #[derive(FromQueryResult)]
    struct ReceiptId {
        id: Uuid,
    }
    let visible = ReceiptId::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select nr.id from notification_receipt nr join notification_event ne on ne.id = nr.event_id join signal_message sm on sm.id = ne.signal_message_id where nr.id = any($1) and nr.recipient_login_id = $2 and sm.deleted = false and ne.group_master_key = any($3) and exists (select 1 from signal_message_group smg where smg.signal_message_id = ne.signal_message_id and smg.group_master_key = ne.group_master_key)",
        vec![known_receipt_ids.to_vec().into(), login.into(), groups.to_vec().into()],
    )).all(dbx).await.c(h!())?.into_iter().map(|receipt| receipt.id).collect::<HashSet<_>>();
    Ok(known_receipt_ids
        .iter()
        .filter(|receipt_id| !visible.contains(receipt_id))
        .copied()
        .collect())
}

async fn create_read_boundary<C>(
    dbx: &C,
    recipient: Uuid,
    panel_id: Uuid,
    groups: &[String],
) -> Result<Option<Uuid>, AppError>
where
    C: ConnectionTrait,
{
    if groups.is_empty() {
        return Ok(None);
    }
    let boundary = Uuid::now_v7();
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtext($1))",
        vec![recipient.to_string().into()],
    ))
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from notification_read_boundary where recipient_login_id = $1 and panel_id = $2",
        vec![recipient.into(), panel_id.into()],
    ))
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from notification_read_boundary where id in (select id from notification_read_boundary where recipient_login_id = $1 order by created_at desc offset $2)",
        vec![recipient.into(), (NOTIFICATION_READ_BOUNDARY_MAX_PER_RECIPIENT - 1).into()],
    ))
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "insert into notification_read_boundary (id, recipient_login_id, panel_id) values ($1, $2, $3)",
        vec![boundary.into(), recipient.into(), panel_id.into()],
    ))
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "insert into notification_read_boundary_receipt (boundary_id, receipt_id) select $1, nr.id from notification_receipt nr join notification_event ne on ne.id = nr.event_id join signal_message sm on sm.id = ne.signal_message_id where nr.recipient_login_id = $2 and nr.read_at is null and sm.deleted = false and ne.group_master_key = any($3) and exists (select 1 from signal_message_group smg where smg.signal_message_id = ne.signal_message_id and smg.group_master_key = ne.group_master_key)",
        vec![boundary.into(), recipient.into(), groups.to_vec().into()],
    ))
    .await
    .c(h!())?;
    Ok(Some(boundary))
}

async fn reusable_boundary<C>(
    dbx: &C,
    recipient: Uuid,
    boundary: Uuid,
) -> Result<Option<Uuid>, AppError>
where
    C: ConnectionTrait,
{
    #[derive(FromQueryResult)]
    struct Boundary {
        id: Uuid,
    }
    Ok(Boundary::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select id from notification_read_boundary where id = $1 and recipient_login_id = $2",
        vec![boundary.into(), recipient.into()],
    )).one(dbx).await.c(h!())?.map(|boundary| boundary.id))
}

#[derive(FromQueryResult)]
struct CompletedBoundary {
    unread_count: i64,
    receipt_ids: Vec<Uuid>,
}

#[derive(FromQueryResult)]
struct ReceiptId {
    id: Uuid,
}

async fn mark_boundary_as_read<C>(
    dbx: &C,
    login: Uuid,
    boundary_receipt_id: Uuid,
    groups: &[String],
) -> Result<NotificationReadAllRsp, AppError>
where
    C: ConnectionTrait,
{
    cleanup_expired_boundaries(dbx).await?;
    if reusable_boundary(dbx, login, boundary_receipt_id)
        .await?
        .is_none()
    {
        if let Some(completed) = CompletedBoundary::find_by_statement(
            Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select unread_count, receipt_ids from notification_read_boundary_completed where boundary_id = $1 and recipient_login_id = $2",
                vec![boundary_receipt_id.into(), login.into()],
            ),
        )
        .one(dbx)
        .await
        .c(h!())?
        {
            return Ok(NotificationReadAllRsp {
                outcome: NotificationReadAllOutcome::NotificationReadAllAlreadyCompleted,
                unread_count: completed.unread_count,
                receipt_ids: completed.receipt_ids,
            });
        }
        return Ok(NotificationReadAllRsp {
            outcome:
                NotificationReadAllOutcome::NotificationReadAllBoundaryExpired,
            unread_count: unread_count(dbx, login, groups).await?,
            receipt_ids: vec![],
        });
    }
    let receipt_ids = if groups.is_empty() {
        vec![]
    } else {
        ReceiptId::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres, "update notification_receipt nr set read_at = coalesce(nr.read_at, now()) from notification_read_boundary_receipt br, notification_read_boundary b, notification_event ne where nr.id = br.receipt_id and b.id = br.boundary_id and ne.id = nr.event_id and br.boundary_id = $2 and b.recipient_login_id = $1 and ne.group_master_key = any($3) and exists (select 1 from signal_message sm join signal_message_group smg on smg.signal_message_id = sm.id and smg.group_master_key = ne.group_master_key where sm.id = ne.signal_message_id and sm.deleted = false) returning nr.id", vec![login.into(), boundary_receipt_id.into(), groups.to_vec().into()])).all(dbx).await.c(h!())?.into_iter().map(|receipt| receipt.id).collect()
    };
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from notification_read_boundary where id = $1 and recipient_login_id = $2",
        vec![boundary_receipt_id.into(), login.into()],
    ))
    .await
    .c(h!())?;
    let unread_count = unread_count(dbx, login, groups).await?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "insert into notification_read_boundary_completed (boundary_id, recipient_login_id, unread_count, receipt_ids) values ($1, $2, $3, $4) on conflict (boundary_id) do nothing",
        vec![boundary_receipt_id.into(), login.into(), unread_count.into(), receipt_ids.clone().into()],
    ))
    .await
    .c(h!())?;
    Ok(NotificationReadAllRsp {
        outcome: NotificationReadAllOutcome::NotificationReadAllApplied,
        unread_count,
        receipt_ids,
    })
}

async fn cleanup_expired_boundaries<C>(dbx: &C) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from notification_read_boundary where created_at < now() - $1 * interval '1 minute'",
        vec![NOTIFICATION_READ_BOUNDARY_TTL_MINUTES.into()],
    ))
    .await
    .c(h!())?;
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from notification_read_boundary_completed where created_at < now() - $1 * interval '1 minute'",
        vec![NOTIFICATION_READ_BOUNDARY_TTL_MINUTES.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

#[post("/api/notifications/list")]
pub async fn notification_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NotificationListReq>,
) -> Result<Json<NotificationListRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let txn = env.dbx.begin().await.c(h!())?;
    txn.execute_raw(Statement::from_string(
        DatabaseBackend::Postgres,
        "set transaction isolation level repeatable read".to_owned(),
    ))
    .await
    .c(h!())?;
    cleanup_expired_boundaries(&txn).await?;
    let groups = allowed_groups(&txn, login).await?;
    let removed_receipt_ids = if req.cursor.is_none() {
        removed_receipt_ids(
            &txn,
            login,
            &groups,
            &req.known_receipt_ids
                [..req.known_receipt_ids.len().min(MAX_RECONCILED_RECEIPTS)],
        )
        .await?
    } else {
        vec![]
    };
    let mark_all_boundary = if req.cursor.is_none() {
        if let Some(boundary) = req.boundary_id {
            reusable_boundary(&txn, login, boundary).await?
        } else {
            create_read_boundary(&txn, login, req.panel_id, &groups).await?
        }
    } else {
        None
    };
    let mut rows = visible_rows(&txn, login, &groups, req.cursor).await?;
    let has_more = rows.len() as u64 > PAGE_SIZE;
    rows.truncate(PAGE_SIZE as usize);
    let next_cursor = has_more
        .then(|| rows.last().map(|row| row.event_id))
        .flatten();
    let items = rows
        .into_iter()
        .map(|row| NotificationItem {
            receipt_id: row.receipt_id,
            event_id: row.event_id,
            actor_id: row.actor_id,
            actor_login: row.actor_login,
            group_name: row.group_name.unwrap_or(row.group_master_key),
            created_at: row.created_at.and_utc().timestamp_millis(),
            read_at: row.read_at.map(|ts| ts.and_utc().timestamp_millis()),
            quote: NotificationQuote {
                message_id: row.message_id,
                message_uuid: row.message_uuid.map(|id| id.to_string()),
                message_uid: row.message_uid,
                text: row.body.unwrap_or_default(),
                attachments_count: row.attachments_count,
                media_file_names: row.media_file_names,
                coords: row.coords,
            },
        })
        .collect();
    let unread_count = unread_count(&txn, login, &groups).await?;
    txn.commit().await.c(h!())?;
    Ok(Json(NotificationListRsp {
        items,
        unread_count,
        next_cursor,
        mark_all_boundary,
        removed_receipt_ids,
    }))
}

#[get("/api/notifications/unread-count")]
pub async fn notification_unread_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<NotificationUnreadCountRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let groups = allowed_groups(&env.dbx, login).await?;
    Ok(Json(NotificationUnreadCountRsp {
        unread_count: unread_count(&env.dbx, login, &groups).await?,
    }))
}

#[post("/api/notifications/read")]
pub async fn notification_read(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NotificationReadReq>,
) -> Result<Json<NotificationUnreadCountRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let groups = allowed_groups(&env.dbx, login).await?;
    env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres, "update notification_receipt nr set read_at = coalesce(nr.read_at, now()) from notification_event ne where nr.event_id = ne.id and nr.id = $1 and nr.recipient_login_id = $2 and ne.group_master_key = any($3) and exists (select 1 from signal_message sm join signal_message_group smg on smg.signal_message_id = sm.id and smg.group_master_key = ne.group_master_key where sm.id = ne.signal_message_id and sm.deleted = false)", vec![req.receipt_id.into(), login.into(), groups.clone().into()])).await.c(h!())?;
    Ok(Json(NotificationUnreadCountRsp {
        unread_count: unread_count(&env.dbx, login, &groups).await?,
    }))
}

#[post("/api/notifications/read-all")]
pub async fn notification_read_all(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NotificationReadAllReq>,
) -> Result<Json<NotificationReadAllRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let txn = env.dbx.begin().await.c(h!())?;
    let groups = allowed_groups(&txn, login).await?;
    let response =
        mark_boundary_as_read(&txn, login, req.boundary_receipt_id, &groups)
            .await?;
    txn.commit().await.c(h!())?;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{sigint_important, signal_message_group};
    use crate::functest::tests::{
        cleanup_locked, find_test_login, find_test_signal_group, mk_login,
        mk_sigint_important, mk_signal_message, mk_signal_message_group,
    };
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    async fn create_unread_receipt<C>(
        dbx: &C,
        recipient: Uuid,
        actor: Uuid,
        group: &str,
    ) -> Uuid
    where
        C: ConnectionTrait,
    {
        let message = mk_signal_message(dbx, Default::default()).await.unwrap();
        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let important = mk_sigint_important(
            dbx,
            sigint_important::ActiveModel {
                signal_message_id: Set(message.id),
                login_id: Set(Some(actor)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let event = Uuid::now_v7();
        let receipt = Uuid::now_v7();
        dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into notification_event (id, operation_id, actor_login_id, signal_message_id, sigint_important_id, group_master_key) values ($1, $2, $3, $4, $5, $6)",
                vec![event.into(), Uuid::now_v7().into(), actor.into(), message.id.into(), important.id.into(), group.into()],
            ))
            .await
            .unwrap();
        dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into notification_receipt (id, event_id, recipient_login_id) values ($1, $2, $3)",
                vec![receipt.into(), event.into(), recipient.into()],
            ))
            .await
            .unwrap();
        receipt
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_keeps_boundaries_for_independent_panels() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let first = Uuid::now_v7();
        let second = Uuid::now_v7();
        let first_panel = Uuid::now_v7();
        let second_panel = Uuid::now_v7();

        for (boundary, panel) in [(first, first_panel), (second, second_panel)]
        {
            env.dbx
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "insert into notification_read_boundary (id, recipient_login_id, panel_id) values ($1, $2, $3)",
                    vec![boundary.into(), login.id.into(), panel.into()],
                ))
                .await
                .unwrap();
        }

        assert_eq!(
            reusable_boundary(&env.dbx, login.id, first).await.unwrap(),
            Some(first)
        );
        assert_eq!(
            reusable_boundary(&env.dbx, login.id, second).await.unwrap(),
            Some(second)
        );
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_replaces_and_trims_read_boundaries() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let groups = vec![group.master_key];
        let panel = Uuid::now_v7();

        let first = create_read_boundary(&env.dbx, login.id, panel, &groups)
            .await
            .unwrap()
            .unwrap();
        let replacement =
            create_read_boundary(&env.dbx, login.id, panel, &groups)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            reusable_boundary(&env.dbx, login.id, first).await.unwrap(),
            None
        );
        assert_eq!(
            reusable_boundary(&env.dbx, login.id, replacement)
                .await
                .unwrap(),
            Some(replacement)
        );

        for _ in 0..NOTIFICATION_READ_BOUNDARY_MAX_PER_RECIPIENT {
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap();
        }
        #[derive(FromQueryResult)]
        struct Count {
            count: i64,
        }
        let count = Count::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*)::bigint count from notification_read_boundary where recipient_login_id = $1",
            vec![login.id.into()],
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .count;
        assert_eq!(count, NOTIFICATION_READ_BOUNDARY_MAX_PER_RECIPIENT);
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_reports_expired_boundaries_and_replays_completed_ones() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let groups = vec![group.master_key];
        let boundary =
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap()
                .unwrap();

        let other = mk_login(&env.dbx, Default::default()).await.unwrap();
        let live_cross_user =
            mark_boundary_as_read(&env.dbx, other.id, boundary, &[])
                .await
                .unwrap();
        assert_eq!(
            live_cross_user.outcome,
            NotificationReadAllOutcome::NotificationReadAllBoundaryExpired
        );
        assert!(live_cross_user.receipt_ids.is_empty());

        let applied =
            mark_boundary_as_read(&env.dbx, login.id, boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            applied.outcome,
            NotificationReadAllOutcome::NotificationReadAllApplied
        );

        let replay =
            mark_boundary_as_read(&env.dbx, login.id, boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            replay.outcome,
            NotificationReadAllOutcome::NotificationReadAllAlreadyCompleted
        );
        assert_eq!(replay.receipt_ids, applied.receipt_ids);
        assert_eq!(replay.unread_count, applied.unread_count);

        let expired = mark_boundary_as_read(&env.dbx, other.id, boundary, &[])
            .await
            .unwrap();
        assert_eq!(
            expired.outcome,
            NotificationReadAllOutcome::NotificationReadAllBoundaryExpired
        );
        assert!(expired.receipt_ids.is_empty());
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_expires_aged_boundaries_and_keeps_empty_snapshots_replayable(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let groups = vec![group.master_key];
        let empty_boundary =
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap()
                .unwrap();
        let empty =
            mark_boundary_as_read(&env.dbx, login.id, empty_boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            empty.outcome,
            NotificationReadAllOutcome::NotificationReadAllApplied
        );
        assert!(empty.receipt_ids.is_empty());
        assert_eq!(empty.unread_count, 0);
        assert_eq!(
            mark_boundary_as_read(&env.dbx, login.id, empty_boundary, &groups)
                .await
                .unwrap(),
            NotificationReadAllRsp {
                outcome: NotificationReadAllOutcome::NotificationReadAllAlreadyCompleted,
                unread_count: 0,
                receipt_ids: vec![],
            }
        );
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "update notification_read_boundary_completed set created_at = now() - ($2 + 1) * interval '1 minute' where boundary_id = $1",
                vec![
                    empty_boundary.into(),
                    NOTIFICATION_READ_BOUNDARY_TTL_MINUTES.into(),
                ],
            ))
            .await
            .unwrap();
        let expired_completion =
            mark_boundary_as_read(&env.dbx, login.id, empty_boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            expired_completion.outcome,
            NotificationReadAllOutcome::NotificationReadAllBoundaryExpired
        );

        let expired =
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap()
                .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "update notification_read_boundary set created_at = now() - ($2 + 1) * interval '1 minute' where id = $1",
                vec![expired.into(), NOTIFICATION_READ_BOUNDARY_TTL_MINUTES.into()],
            ))
            .await
            .unwrap();
        let response =
            mark_boundary_as_read(&env.dbx, login.id, expired, &groups)
                .await
                .unwrap();
        assert_eq!(
            response.outcome,
            NotificationReadAllOutcome::NotificationReadAllBoundaryExpired
        );
        assert!(response.receipt_ids.is_empty());
        assert_eq!(response.unread_count, 0);
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_boundary_marks_unloaded_snapshot_receipts_but_not_later_arrivals(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let groups = vec![group.master_key.clone()];
        let mut covered = Vec::new();
        for _ in 0..PAGE_SIZE + 1 {
            covered.push(
                create_unread_receipt(
                    &env.dbx,
                    login.id,
                    login.id,
                    &group.master_key,
                )
                .await,
            );
        }
        let boundary =
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap()
                .unwrap();
        let later = create_unread_receipt(
            &env.dbx,
            login.id,
            login.id,
            &group.master_key,
        )
        .await;
        let response =
            mark_boundary_as_read(&env.dbx, login.id, boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            response.outcome,
            NotificationReadAllOutcome::NotificationReadAllApplied
        );
        assert_eq!(response.receipt_ids.len(), covered.len());
        assert!(response.receipt_ids.iter().all(|id| covered.contains(id)));
        assert!(!response.receipt_ids.contains(&later));
        assert_eq!(response.unread_count, 1);

        #[derive(FromQueryResult)]
        struct ReceiptState {
            id: Uuid,
            read_at: Option<NaiveDateTime>,
        }
        let receipts = ReceiptState::find_by_statement(
            Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select id, read_at from notification_receipt where id = any($1)",
                vec![covered.clone().into()],
            ),
        )
        .all(&env.dbx)
        .await
        .unwrap();
        assert_eq!(receipts.len(), covered.len());
        assert!(receipts.iter().all(|receipt| receipt.read_at.is_some()));

        let later_receipt =
            ReceiptState::find_by_statement(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select id, read_at from notification_receipt where id = $1",
                vec![later.into()],
            ))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(later_receipt.id, later);
        assert!(later_receipt.read_at.is_none());
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_does_not_mark_a_snapshot_receipt_after_its_source_is_deleted(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let groups = vec![group.master_key.clone()];
        let receipt = create_unread_receipt(
            &env.dbx,
            login.id,
            login.id,
            &group.master_key,
        )
        .await;
        let boundary =
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap()
                .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "update signal_message sm set deleted = true from notification_receipt nr join notification_event ne on ne.id = nr.event_id where sm.id = ne.signal_message_id and nr.id = $1",
                vec![receipt.into()],
            ))
            .await
            .unwrap();

        let response =
            mark_boundary_as_read(&env.dbx, login.id, boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            response.outcome,
            NotificationReadAllOutcome::NotificationReadAllApplied
        );
        assert!(response.receipt_ids.is_empty());
        assert_eq!(response.unread_count, 0);

        #[derive(FromQueryResult)]
        struct ReadState {
            read_at: Option<NaiveDateTime>,
        }
        let state =
            ReadState::find_by_statement(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select read_at from notification_receipt where id = $1",
                vec![receipt.into()],
            ))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(state.read_at.is_none());
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_snapshot_excludes_receipts_committed_after_capture() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let groups = vec![group.master_key.clone()];
        let pending = env.dbx.begin().await.unwrap();
        let later = create_unread_receipt(
            &pending,
            login.id,
            login.id,
            &group.master_key,
        )
        .await;
        let boundary =
            create_read_boundary(&env.dbx, login.id, Uuid::now_v7(), &groups)
                .await
                .unwrap()
                .unwrap();
        pending.commit().await.unwrap();

        let response =
            mark_boundary_as_read(&env.dbx, login.id, boundary, &groups)
                .await
                .unwrap();
        assert_eq!(
            response.outcome,
            NotificationReadAllOutcome::NotificationReadAllApplied
        );
        assert!(response.receipt_ids.is_empty());
        assert_eq!(response.unread_count, 1);

        #[derive(FromQueryResult)]
        struct ReadState {
            read_at: Option<NaiveDateTime>,
        }
        let state =
            ReadState::find_by_statement(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select read_at from notification_receipt where id = $1",
                vec![later.into()],
            ))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(state.read_at.is_none());
    }
}

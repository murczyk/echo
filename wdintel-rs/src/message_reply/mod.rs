mod ingestion;
mod query;
mod reconciliation;
mod relink;
pub mod types;
pub mod worker;

use crate::types::*;
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};

pub use ingestion::{record_source, stage_source};
pub use reconciliation::{record_processed_source, record_promoted_sources};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_api;

#[post("/api/rer-importer/message-replies")]
pub async fn message_replies(
    user: Identity,
    env: Data<Env>,
    req: Json<types::MessageRepliesReq>,
) -> Result<Json<types::MessageRepliesRsp>, crate::error::AppError> {
    crate::users::ensure_base_role(&env.dbx, &user)
        .await
        .c(h!())?;
    let login = crate::users::login_id_from_identity(&user).c(h!())?;
    if req.signal_message_ids.len() > crate::config::MESSAGE_REPLY_MAX_ANCHORS {
        return Err(crate::error::AppError::BL {
            msg: "Забагато повідомлень у запиті відповідей.".into(),
        });
    }
    Ok(Json(query::load(&env.dbx, &login, &req).await.c(h!())?))
}

pub async fn insert<C: ConnectionTrait>(
    db: &C,
    original: Option<i64>,
    reply: i64,
    original_deleted: bool,
    reply_deleted: bool,
) -> anyhow::Result<i64> {
    let row = query::IdRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"insert into message_reply (engaged_message_id, reply_signal_message_id, original_deleted, reply_deleted, deleted)
            values ($1, $2, $3, $4, $3 or $4)
            on conflict (reply_signal_message_id)
            do update set engaged_message_id = excluded.engaged_message_id,
                original_deleted = excluded.original_deleted,
                reply_deleted = message_reply.reply_deleted or excluded.reply_deleted,
                deleted = excluded.original_deleted or message_reply.reply_deleted or excluded.reply_deleted returning id"#,
        vec![original.into(), reply.into(), original_deleted.into(), reply_deleted.into()],
    )).one(db).await.c(h!())?.c(h!())?;
    Ok(row.id)
}

pub async fn prepare_submission(
    db: &sea_orm::DatabaseTransaction,
    login: &Uuid,
    engaged_message_id: i64,
    preferred_group: Option<&str>,
) -> anyhow::Result<crate::entities::signal_group::Model> {
    let ids = &[engaged_message_id];
    lock_threads(db).await.c(h!())?;
    // Lock before checking access so deletion cannot race with relationship creation.
    db.query_all_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "select id from signal_message where id = any($1) order by id for share", vec![ids.to_vec().into()]))
        .await.c(h!())?;
    let scope = query::AccessScope::load(db, login).await.c(h!())?;
    let visible = scope.visible_ids(db, ids).await.c(h!())?;
    anyhow::ensure!(
        visible.len() == 1,
        "Повідомлення недоступне для відповіді."
    );
    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(db, login)
            .await
            .c(h!())?;
    #[derive(FromQueryResult)]
    struct GroupRow {
        master_key: String,
    }
    let groups = GroupRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"with source_groups as (
            select signal_message_id, group_master_key from signal_message_group where signal_message_id = any($1)
            union
            select sm.id, dg.group_master_key from signal_message sm join datasource_group dg on dg.id = sm.datasource_group_id where sm.id = any($1)
        ) select g.group_master_key as master_key from source_groups g
            join signal_group sg on sg.master_key = g.group_master_key and not sg.deleted
            where g.group_master_key is not null
            group by g.group_master_key
            order by (g.group_master_key = $2) desc nulls last, g.group_master_key"#,
        vec![visible.into(), preferred_group.map(str::to_string).into()]))
        .all(db).await.c(h!())?;
    for group in groups {
        if !allowed_groups.contains(&group.master_key) {
            error!("reply group rejected: login={login} sources={ids:?} group={} reason=forbidden", group.master_key);
            continue;
        }
        match crate::sigint::direct_submit::query::find_available_signal_group(
            db,
            login,
            &group.master_key,
        )
        .await
        {
            Ok(group) => return Ok(group),
            Err(crate::error::AppError::Forbidden(reason)) => {
                error!("reply group rejected: login={login} sources={ids:?} group={} reason={reason}", group.master_key);
            }
            Err(crate::error::AppError::NotFound) => {
                error!("reply group rejected: login={login} sources={ids:?} group={} reason=unavailable", group.master_key);
            }
            Err(error) => return Err(error).c(h!()),
        }
    }
    error!("reply destination exhausted: login={login} sources={ids:?}");
    anyhow::bail!("Немає доступної групи для відповіді.")
}

pub(super) async fn lock_threads<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<()> {
    db.execute_unprepared("select message_reply_lock_threads()")
        .await
        .c(h!())?;
    Ok(())
}

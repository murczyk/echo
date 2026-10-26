use crate::config::RER_IMPORTER_IMPORTANT_LIST_LIMIT;
use crate::error::AppError;
use crate::types::*;
use crate::users::ensure_base_role;
use crate::users::login_id_from_identity;
use crate::{entities::*, utils::*};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use chrono::prelude::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{prelude::Expr, sea_query::OnConflict, *};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportantAddReq {
    pub message_id: i64,
    #[serde(default)]
    pub group_master_key: Option<String>,
    #[serde(default)]
    pub notify_group: bool,
    #[serde(default)]
    pub operation_id: Option<Uuid>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportantMutationRsp {
    pub important: bool,
}

async fn important_state<C>(
    dbx: &C,
    message_ids: &[i64],
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    if message_ids.is_empty() {
        return Ok(false);
    }
    Ok(sigint_important::Entity::find()
        .filter(
            sigint_important::Column::SignalMessageId
                .is_in(message_ids.to_vec()),
        )
        .filter(sigint_important::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_important::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .context(h!())?
        .is_some())
}

async fn add_missing_importants(
    txn: &DatabaseTransaction,
    login: Uuid,
    affected_ids: &[i64],
) -> anyhow::Result<Vec<sigint_important::Model>> {
    let existing_ids = sigint_important::Entity::find()
        .select_only()
        .column(sigint_important::Column::SignalMessageId)
        .filter(sigint_important::Column::LoginId.eq(Some(login)))
        .filter(
            sigint_important::Column::SignalMessageId
                .is_in(affected_ids.to_vec()),
        )
        .filter(sigint_important::Column::Deleted.eq(false))
        .into_tuple::<i64>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let missing_ids = affected_ids
        .iter()
        .filter(|id| !existing_ids.contains(id))
        .copied()
        .collect::<Vec<_>>();
    if missing_ids.is_empty() {
        return Ok(vec![]);
    }

    let message_uuids = signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::IdUuid)
        .filter(signal_message::Column::Id.is_in(missing_ids.clone()))
        .into_tuple::<(i64, Option<Uuid>)>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
    let importants = missing_ids
        .into_iter()
        .map(|id| sigint_important::ActiveModel {
            id: NotSet,
            login_id: Set(Some(login)),
            signal_message_id: Set(id),
            signal_message_uuid: Set(message_uuids.get(&id).copied().flatten()),
            deleted: Set(false),
            created_at: NotSet,
        })
        .collect::<Vec<_>>();
    let result = sigint_important::Entity::insert_many(importants)
        .on_conflict(
            OnConflict::columns([
                sigint_important::Column::LoginId,
                sigint_important::Column::SignalMessageId,
            ])
            .target_and_where(
                Expr::col(sigint_important::Column::Deleted).eq(false).and(
                    Expr::col(sigint_important::Column::LoginId).is_not_null(),
                ),
            )
            .do_nothing()
            .to_owned(),
        )
        .exec_with_returning(txn)
        .await
        .context(h!())?;
    Ok(result)
}

async fn validate_notification_context(
    env: &Env,
    login: Uuid,
    message_id: i64,
    group_master_key: &str,
) -> Result<(), AppError> {
    let available =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    if !available.iter().any(|key| key == group_master_key) {
        return Err(AppError::BL {
            msg: "Немає доступу до вибраної групи".into(),
        });
    }
    let associated = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message_id))
        .filter(
            signal_message_group::Column::GroupMasterKey.eq(group_master_key),
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .is_some();
    if !associated {
        return Err(AppError::BL {
            msg: "Група не пов’язана з повідомленням".into(),
        });
    }
    Ok(())
}

async fn claim_importance_operation(
    txn: &DatabaseTransaction,
    actor: Uuid,
    message_id: i64,
    notify_group: bool,
    group_master_key: Option<&str>,
    operation_id: Uuid,
) -> anyhow::Result<bool> {
    #[derive(FromQueryResult)]
    struct ExistingOperation {
        actor_login_id: Uuid,
        signal_message_id: i64,
        notify_group: bool,
        group_master_key: Option<String>,
        result_important: Option<bool>,
    }
    let inserted = txn
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into importance_operation (operation_id, actor_login_id, signal_message_id, notify_group, group_master_key) values ($1, $2, $3, $4, $5) on conflict (operation_id) do nothing",
            vec![
                operation_id.into(),
                actor.into(),
                message_id.into(),
                notify_group.into(),
                group_master_key.map(str::to_owned).into(),
            ],
        ))
        .await
        .context(h!())?
        .rows_affected()
        > 0;
    let existing = ExistingOperation::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select actor_login_id, signal_message_id, notify_group, group_master_key, result_important from importance_operation where operation_id = $1 for update",
            vec![operation_id.into()],
        ),
    )
    .one(txn)
    .await
    .context(h!())?
    .context(h!())?;
    anyhow::ensure!(
        existing.actor_login_id == actor
            && existing.signal_message_id == message_id
            && existing.notify_group == notify_group
            && existing.group_master_key.as_deref() == group_master_key,
        "importance operation identifier was reused with another payload"
    );
    Ok(!inserted && existing.result_important.is_some())
}

async fn create_notification_event(
    txn: &DatabaseTransaction,
    actor: Uuid,
    message_id: i64,
    importance_id: i64,
    group_master_key: &str,
    operation_id: Uuid,
    public_host: &str,
) -> anyhow::Result<()> {
    #[derive(FromQueryResult)]
    struct ExistingOperation {
        actor_login_id: Uuid,
        signal_message_id: i64,
        group_master_key: String,
    }
    if let Some(existing) = ExistingOperation::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select actor_login_id, signal_message_id, group_master_key from notification_event where operation_id = $1",
            vec![operation_id.into()],
        ),
    )
    .one(txn)
    .await
    .context(h!())?
    {
        anyhow::ensure!(
            existing.actor_login_id == actor
                && existing.signal_message_id == message_id
                && existing.group_master_key == group_master_key,
            "notification operation identifier was reused with another payload"
        );
        return Ok(());
    }
    let event_id = Uuid::now_v7();
    let actor_login = login::Entity::find_by_id(actor)
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;
    let group_name = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(group_master_key))
        .select_only()
        .column(signal_group::Column::Name)
        .into_tuple::<Option<String>>()
        .one(txn)
        .await
        .context(h!())?
        .flatten();
    let message_uuid = signal_message::Entity::find_by_id(message_id)
        .select_only()
        .column(signal_message::Column::IdUuid)
        .into_tuple::<Option<Uuid>>()
        .one(txn)
        .await
        .context(h!())?
        .flatten();
    let insert = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "insert into notification_event (id, operation_id, actor_login_id, signal_message_id, sigint_important_id, signal_message_uuid, group_master_key, actor_login_snapshot, group_name_snapshot) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (operation_id) do nothing",
        vec![
            event_id.into(),
            operation_id.into(),
            actor.into(),
            message_id.into(),
            importance_id.into(),
            message_uuid.into(),
            group_master_key.into(),
            actor_login.login.into(),
            group_name.into(),
        ],
    );
    if txn.execute_raw(insert).await.context(h!())?.rows_affected() == 0 {
        return Ok(());
    }
    #[derive(FromQueryResult)]
    struct CandidateRecipient {
        id: Uuid,
        roles: serde_json::Value,
    }
    let active_logins = CandidateRecipient::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select l.id, l.roles from login l join organism o on o.id = l.organism_id where l.deleted = false and l.deleted_permanently = false and o.enabled = true and o.deleted_permanently = false",
            vec![],
        ),
    )
    .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|recipient| {
            let roles = serde_json::from_value::<Vec<String>>(recipient.roles)
                .context(h!())?;
            Ok::<_, anyhow::Error>(
                (crate::users::role_matches(&roles, "Rer").context(h!())?
                    || crate::users::role_matches(&roles, "CyberViewer")
                        .context(h!())?)
                .then_some(recipient.id),
            )
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .context(h!())?
        .into_iter()
        .flatten()
        .filter(|recipient| *recipient != actor)
        .collect::<Vec<_>>();
    let recipients =
        recipients_with_group_access(txn, &active_logins, group_master_key)
            .await
            .context(h!())?;
    if !recipients.is_empty() {
        let receipt_ids = (0..recipients.len())
            .map(|_| Uuid::now_v7())
            .collect::<Vec<_>>();
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into notification_receipt (id, event_id, recipient_login_id, created_at) select receipt_id, $1, recipient_id, ne.created_at from unnest($2::uuid[], $3::uuid[]) as receipt(receipt_id, recipient_id) join notification_event ne on ne.id = $1 on conflict (event_id, recipient_login_id) do nothing",
            vec![event_id.into(), receipt_ids.into(), recipients.into()],
        ))
        .await
        .context(h!())?;
    }
    crate::messenger::alerts::enqueue(txn, event_id, public_host)
        .await
        .context(h!())?;
    Ok(())
}

pub(crate) async fn recipients_with_group_access(
    txn: &DatabaseTransaction,
    candidates: &[Uuid],
    group_master_key: &str,
) -> anyhow::Result<Vec<Uuid>> {
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    #[derive(FromQueryResult)]
    struct Recipient {
        id: Uuid,
    }
    Recipient::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "with recursive ancestors(login_id, organism_id, depth) as (select l.id, l.organism_id, 0 from login l where l.id = any($1) union all select a.login_id, o.parent_id, a.depth + 1 from ancestors a join organism o on o.id = a.organism_id where o.parent_id is not null and a.depth < 10) select distinct l.id from login l join organism o on o.id = l.organism_id join signal_group sg on sg.master_key = $2 join sigint_zone_datasource szd on szd.group_master_key = sg.master_key and szd.sigint_zone_id = l.sigint_zone_id join datasource d on d.id = szd.datasource_id and d.deleted = false where l.id = any($1) and l.deleted = false and l.deleted_permanently = false and o.enabled = true and o.deleted_permanently = false and sg.deleted = false and sg.is_archived = false and (not sg.is_secret or exists (select 1 from secret_group_user sgu where sgu.login_id = l.id and sgu.master_key = sg.master_key)) and (exists (select 1 from secret_group_organism sgo where sgo.organism_id = l.organism_id and sgo.master_key = sg.master_key) or (exists (select 1 from organism_aor oa join area_of_responsibility oa_aor on oa_aor.id = oa.aor_id join signal_group_aor sga on sga.master_key = sg.master_key join area_of_responsibility group_aor on group_aor.id = sga.aor_id where oa.organism_id = l.organism_id and not (oa_aor.left_bound > group_aor.right_bound or oa_aor.right_bound < group_aor.left_bound)) and not exists (select 1 from ancestors a where a.login_id = l.id and exists (select 1 from organism_group og where og.organism_id = a.organism_id) and not exists (select 1 from organism_group og where og.organism_id = a.organism_id and og.signal_group_master_key = sg.master_key))))",
        vec![candidates.to_vec().into(), group_master_key.into()],
    )).all(txn).await.context(h!()).map(|rows| rows.into_iter().map(|row| row.id).collect())
}

async fn remove_importants(
    txn: &DatabaseTransaction,
    login: Uuid,
    affected_ids: &[i64],
) -> anyhow::Result<()> {
    sigint_important::Entity::update_many()
        .col_expr(sigint_important::Column::Deleted, Expr::value(true))
        .filter(sigint_important::Column::LoginId.eq(Some(login)))
        .filter(
            sigint_important::Column::SignalMessageId
                .eq_any(affected_ids.to_vec()),
        )
        .filter(sigint_important::Column::Deleted.eq(false))
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
}

async fn suppress_ai_importance_if_allowed(
    env: &Env,
    txn: &DatabaseTransaction,
    login: Uuid,
    message_id: i64,
) -> anyhow::Result<()> {
    // Personal marks remain removable after access is revoked; AI marks require current access.
    match crate::messenger::media::ensure_media_access(
        &env.dbx, &login, message_id,
    )
    .await
    {
        Ok(()) => {
            crate::ai_transcript_analysis::worker::suppress(txn, message_id)
                .await
                .c(h!())?
        }
        Err(AppError::Forbidden(_)) => (),
        Err(error) => return Err(error).c(h!()),
    }
    Ok(())
}

async fn set_importance(
    env: &Env,
    login: Uuid,
    message_id: i64,
    important: bool,
    notification_group: Option<&str>,
    operation_id: Option<Uuid>,
) -> anyhow::Result<bool> {
    let txn = env.dbx.begin().await.context(h!())?;
    let affected_ids =
        crate::rer_importer::inbox::find_all_duplicates(&txn, message_id)
            .await
            .context(h!())?;
    if let Some(operation_id) = operation_id {
        if claim_importance_operation(
            &txn,
            login,
            message_id,
            notification_group.is_some(),
            notification_group,
            operation_id,
        )
        .await
        .context(h!())?
        {
            let important =
                important_state(&txn, &affected_ids).await.context(h!())?;
            txn.commit().await.context(h!())?;
            return Ok(important);
        }
    }
    if important {
        let added_importants =
            add_missing_importants(&txn, login, &affected_ids)
                .await
                .context(h!())?;
        if let Some(important) = added_importants
            .iter()
            .find(|important| important.signal_message_id == message_id)
        {
            if let (Some(group_master_key), Some(operation_id)) =
                (notification_group, operation_id)
            {
                create_notification_event(
                    &txn,
                    login,
                    message_id,
                    important.id,
                    group_master_key,
                    operation_id,
                    &env.config.public_host,
                )
                .await
                .context(h!())?;
            }
        }
    } else {
        if !affected_ids.is_empty() {
            suppress_ai_importance_if_allowed(env, &txn, login, message_id)
                .await
                .c(h!())?;
        }
        remove_importants(&txn, login, &affected_ids)
            .await
            .context(h!())?;
    }
    let important = important_state(&txn, &affected_ids).await.context(h!())?;
    if let Some(operation_id) = operation_id {
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "update importance_operation set result_important = $2 where operation_id = $1",
            vec![operation_id.into(), important.into()],
        ))
        .await
        .context(h!())?;
    }
    txn.commit().await.context(h!())?;

    if let Err(error) =
        crate::inbox::fanout_inbox_changes(&mut env.redis.clone(), affected_ids)
            .await
    {
        log::error!(
            "failed to fanout important changes after commit: {:?}",
            error
        );
    }
    Ok(important)
}

#[post("/api/rer/important/add")]
async fn important_add(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ImportantAddReq>,
) -> Result<Json<ImportantMutationRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).context(h!())?;
    let notification_group = if req.notify_group {
        let group_master_key = req
            .group_master_key
            .as_deref()
            .ok_or_else(|| AppError::BL {
                msg: "Для сповіщення потрібна група".into(),
            })
            .context(h!())?;
        req.operation_id
            .ok_or_else(|| AppError::BL {
                msg: "Для сповіщення потрібен ідентифікатор операції".into(),
            })
            .context(h!())?;
        validate_notification_context(
            &env,
            login,
            req.message_id,
            group_master_key,
        )
        .await
        .context(h!())?;
        Some(group_master_key)
    } else {
        None
    };
    if !req.notify_group && req.group_master_key.is_some() {
        return Err(AppError::BL {
            msg: "Контекст групи можливий лише для сповіщення".into(),
        });
    }
    let important = set_importance(
        &env,
        login,
        req.message_id,
        true,
        notification_group,
        req.operation_id,
    )
    .await
    .c(h!())?;

    println!(
        "Message {} marked as important by {}",
        req.message_id, login
    );

    Ok(Json(ImportantMutationRsp { important }))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportantListReq {
    /// Defaults to 7 days
    since_ts_millis: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Important {
    pub message_id: i64,
}

#[post("/api/rer/importants")]
async fn importants_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ImportantListReq>,
) -> Result<Json<Vec<Important>>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    // let mut q = sigint_important::Entity::find()
    //     .filter(sigint_important::Column::LoginId.eq(login_id_from_identity(&user)?));

    Ok(Json(
        sigint_important::Entity::find()
            .filter(sigint_important::Column::Deleted.eq(false))
            .filter(sigint_important::Column::CreatedAt.gte(
                if let Some(since_ts_millis) = req.since_ts_millis {
                    dt_from_millis(since_ts_millis)?
                } else {
                    (Utc::now() - chrono::Duration::days(7)).naive_utc()
                },
            ))
            .order_by_desc(sigint_important::Column::CreatedAt)
            .limit(RER_IMPORTER_IMPORTANT_LIST_LIMIT)
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|x| Important {
                message_id: x.signal_message_id,
            })
            .collect(),
    ))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportantRmReq {
    pub message_id: i64,
}

#[post("/api/rer/important/delete")]
async fn important_rm(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ImportantRmReq>,
) -> Result<Json<ImportantMutationRsp>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let important =
        set_importance(&env, login, req.message_id, false, None, None)
            .await
            .c(h!())?;

    println!(
        "Remove important sign for message {} by {}",
        req.message_id, login
    );

    Ok(Json(ImportantMutationRsp { important }))
}

pub fn is_important(body: &str) -> bool {
    body.trim().starts_with("⚠️")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::REDIS_SESSIONS_KEY;
    use crate::event_stream::types::{EventMsg, EventType};
    use crate::functest::tests::{
        cleanup_locked, find_test_login, find_test_signal_group, mk_login,
        mk_secret_group_user, mk_sigint_inbox_item, mk_sigint_zone,
    };
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::cookie::{Cookie, Key};
    use actix_web::{
        http::StatusCode, test, web, App, HttpMessage, HttpRequest,
        HttpResponse,
    };
    use redis::{streams::StreamRangeReply, AsyncCommands};
    use serial_test::serial;
    use std::collections::BTreeSet;

    async fn login(
        request: HttpRequest,
        login_id: web::Path<String>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), login_id.into_inner()).unwrap();
        HttpResponse::NoContent().finish()
    }

    async fn event_types(
        redis: &mut redis::aio::ConnectionManager,
        stream_id: &str,
    ) -> Vec<EventType> {
        let reply: StreamRangeReply =
            redis.xrange_all(stream_id).await.unwrap();
        reply
            .ids
            .into_iter()
            .map(|entry| {
                let redis::Value::BulkString(event) =
                    entry.map.get("v").unwrap()
                else {
                    panic!("event stream value is not bytes");
                };
                serde_json::from_slice::<EventMsg>(event)
                    .unwrap()
                    .event_type
            })
            .collect()
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_batched_recipients_match_group_resolution() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let base = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let mut candidates = vec![base.id];
        for role in ["Admin", "Full", "Cyber"] {
            let login = mk_login(
                &env.dbx,
                login::ActiveModel {
                    organism_id: Set(base.organism_id),
                    sigint_zone_id: Set(base.sigint_zone_id),
                    roles: Set(serde_json::json!([role])),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            candidates.push(login.id);
        }
        let inactive = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(base.organism_id),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                deleted: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        candidates.push(inactive.id);
        let other_zone =
            mk_sigint_zone(&env.dbx, Default::default()).await.unwrap();
        let zone_restricted = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(base.organism_id),
                sigint_zone_id: Set(Some(other_zone.id)),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        candidates.push(zone_restricted.id);

        let mut expected = BTreeSet::new();
        for login in &candidates {
            if *login != inactive.id
                && crate::messenger::group::get_identity_sigint_groups(
                    &env.dbx, login,
                )
                .await
                .unwrap()
                .contains(&group.master_key)
            {
                expected.insert(*login);
            }
        }
        let txn = env.dbx.begin().await.unwrap();
        let actual =
            recipients_with_group_access(&txn, &candidates, &group.master_key)
                .await
                .unwrap()
                .into_iter()
                .collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
        assert!(!actual.contains(&inactive.id));
        assert!(!actual.contains(&zone_restricted.id));
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_bulk_receipts_pair_distinct_rust_generated_ids_and_retry_idempotently(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let actor = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into signal_message_group (signal_message_id, group_master_key) values ($1, $2)",
                vec![inbox_item.id.into(), group.master_key.clone().into()],
            ))
            .await
            .unwrap();
        let first = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(format!("echo-3610-first-{}", Uuid::now_v7())),
                organism_id: Set(actor.organism_id),
                sigint_zone_id: Set(actor.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(format!("echo-3610-second-{}", Uuid::now_v7())),
                organism_id: Set(actor.organism_id),
                sigint_zone_id: Set(actor.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let important =
            sigint_important::Entity::insert(sigint_important::ActiveModel {
                login_id: Set(Some(actor.id)),
                signal_message_id: Set(inbox_item.id),
                signal_message_uuid: Set(inbox_item.id_uuid),
                deleted: Set(false),
                ..Default::default()
            })
            .exec(&env.dbx)
            .await
            .unwrap()
            .last_insert_id;
        let operation_id = Uuid::now_v7();
        let txn = env.dbx.begin().await.unwrap();
        create_notification_event(
            &txn,
            actor.id,
            inbox_item.id,
            important,
            &group.master_key,
            operation_id,
            &env.config.public_host,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let receipts = notification_receipt::Entity::find()
            .filter(
                notification_receipt::Column::RecipientLoginId
                    .is_in([first.id, second.id]),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(receipts.len(), 2);
        assert_ne!(receipts[0].id, receipts[1].id);
        assert_eq!(
            receipts
                .iter()
                .map(|receipt| receipt.recipient_login_id)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([first.id, second.id])
        );
        let event = notification_event::Entity::find()
            .filter(notification_event::Column::OperationId.eq(operation_id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(receipts
            .iter()
            .all(|receipt| receipt.created_at == event.created_at));
        assert_eq!(
            notification_receipt::Entity::find()
                .filter(notification_receipt::Column::EventId.eq(event.id))
                .count(&env.dbx)
                .await
                .unwrap(),
            2
        );

        let txn = env.dbx.begin().await.unwrap();
        create_notification_event(
            &txn,
            actor.id,
            inbox_item.id,
            important,
            &group.master_key,
            operation_id,
            &env.config.public_host,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        assert_eq!(
            notification_receipt::Entity::find()
                .filter(
                    notification_receipt::Column::RecipientLoginId
                        .is_in([first.id, second.id])
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            2
        );
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_allows_null_group_name_notification_snapshots() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let actor = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        signal_group::Entity::update_many()
            .col_expr(signal_group::Column::Name, Expr::value(None::<String>))
            .filter(signal_group::Column::MasterKey.eq(&group.master_key))
            .exec(&env.dbx)
            .await
            .unwrap();
        let recipient = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(actor.organism_id),
                sigint_zone_id: Set(actor.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into signal_message_group (signal_message_id, group_master_key) values ($1, $2)",
                vec![inbox_item.id.into(), group.master_key.clone().into()],
            ))
            .await
            .unwrap();
        let operation_id = Uuid::now_v7();

        assert!(set_importance(
            &env,
            actor.id,
            inbox_item.id,
            true,
            Some(&group.master_key),
            Some(operation_id),
        )
        .await
        .unwrap());

        let important = sigint_important::Entity::find()
            .filter(sigint_important::Column::LoginId.eq(Some(actor.id)))
            .filter(sigint_important::Column::SignalMessageId.eq(inbox_item.id))
            .filter(sigint_important::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .unwrap();
        assert!(important.is_some());
        let event = notification_event::Entity::find()
            .filter(notification_event::Column::OperationId.eq(operation_id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.group_name_snapshot, None);
        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .route("/test/login/{login_id}", web::post().to(login))
                .service(crate::notifications::notification_list),
        )
        .await;
        let login_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", recipient.id))
                .to_request(),
        )
        .await;
        let session_cookie = login_response
            .response()
            .cookies()
            .next()
            .unwrap()
            .into_owned();
        let list_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/notifications/list")
                .cookie(session_cookie)
                .set_json(crate::notifications::NotificationListReq {
                    cursor: None,
                    boundary_id: None,
                    panel_id: Uuid::now_v7(),
                    known_receipt_ids: vec![],
                })
                .to_request(),
        )
        .await;
        assert_eq!(list_response.status(), StatusCode::OK);
        let list: crate::notifications::NotificationListRsp =
            test::read_body_json(list_response).await;
        let item = list
            .items
            .iter()
            .find(|item| item.event_id == event.id)
            .unwrap();
        assert_eq!(item.group_name, group.master_key);
        let receipt_count = notification_receipt::Entity::find()
            .filter(notification_receipt::Column::EventId.eq(event.id))
            .count(&env.dbx)
            .await
            .unwrap();
        assert!(notification_receipt::Entity::find()
            .filter(notification_receipt::Column::EventId.eq(event.id))
            .filter(
                notification_receipt::Column::RecipientLoginId.eq(recipient.id)
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());

        assert!(set_importance(
            &env,
            actor.id,
            inbox_item.id,
            true,
            Some(&group.master_key),
            Some(operation_id),
        )
        .await
        .unwrap());
        assert_eq!(
            notification_event::Entity::find()
                .filter(
                    notification_event::Column::OperationId.eq(operation_id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            notification_receipt::Entity::find()
                .filter(notification_receipt::Column::EventId.eq(event.id))
                .count(&env.dbx)
                .await
                .unwrap(),
            receipt_count
        );
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_batched_recipients_honor_ancestor_group_restrictions() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let base = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let grandparent = crate::functest::tests::mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let parent = crate::functest::tests::mk_organism(
            &env.dbx,
            organism::ActiveModel {
                parent_id: Set(Some(grandparent.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let child = crate::functest::tests::mk_organism(
            &env.dbx,
            organism::ActiveModel {
                parent_id: Set(Some(parent.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unrelated = crate::functest::tests::mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into organism_group (organism_id, signal_group_master_key) values ($1, $2), ($3, $4), ($5, $6)",
                vec![
                    grandparent.id.into(),
                    unrelated.master_key.clone().into(),
                    parent.id.into(),
                    unrelated.master_key.into(),
                    child.id.into(),
                    group.master_key.clone().into(),
                ],
            ))
            .await
            .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into organism_aor (organism_id, aor_id) select $1, aor_id from organism_aor where organism_id = $2",
                vec![child.id.into(), base.organism_id.into()],
            ))
            .await
            .unwrap();
        let candidate = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(child.id)),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let expected = crate::messenger::group::get_identity_sigint_groups(
            &env.dbx,
            &candidate.id,
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let actual = recipients_with_group_access(
            &txn,
            &[candidate.id],
            &group.master_key,
        )
        .await
        .unwrap();
        assert!(!expected.contains(&group.master_key));
        assert!(actual.is_empty());
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_batched_recipients_honor_aor_overlap_boundaries() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let base = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let overlapping_organism = crate::functest::tests::mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let non_overlapping_organism = crate::functest::tests::mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into organism_group (organism_id, signal_group_master_key) values ($1, $2), ($3, $4)",
                vec![
                    overlapping_organism.id.into(),
                    group.master_key.clone().into(),
                    non_overlapping_organism.id.into(),
                    group.master_key.clone().into(),
                ],
            ))
            .await
            .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into organism_aor (organism_id, aor_id) select $1, aor_id from organism_aor where organism_id = $2",
                vec![overlapping_organism.id.into(), base.organism_id.into()],
            ))
            .await
            .unwrap();
        let far_aor = crate::functest::tests::mk_aor(
            &env.dbx,
            area_of_responsibility::ActiveModel {
                left_bound: Set(-10_000.0),
                right_bound: Set(-9_000.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "insert into organism_aor (organism_id, aor_id) values ($1, $2)",
                vec![non_overlapping_organism.id.into(), far_aor.id.into()],
            ))
            .await
            .unwrap();
        let overlapping = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(overlapping_organism.id)),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let non_overlapping = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(non_overlapping_organism.id)),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let candidates = [overlapping.id, non_overlapping.id];
        let mut expected = BTreeSet::new();
        for candidate in candidates {
            if crate::messenger::group::get_identity_sigint_groups(
                &env.dbx, &candidate,
            )
            .await
            .unwrap()
            .contains(&group.master_key)
            {
                expected.insert(candidate);
            }
        }
        let txn = env.dbx.begin().await.unwrap();
        let actual =
            recipients_with_group_access(&txn, &candidates, &group.master_key)
                .await
                .unwrap()
                .into_iter()
                .collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
        assert!(actual.contains(&overlapping.id));
        assert!(!actual.contains(&non_overlapping.id));
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_batched_recipients_require_direct_secret_user_grants() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let base = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let granted = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(base.organism_id),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let denied = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(base.organism_id),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_group::Entity::update_many()
            .col_expr(signal_group::Column::IsSecret, Expr::value(true))
            .filter(
                signal_group::Column::MasterKey.eq(group.master_key.clone()),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        mk_secret_group_user(
            &env.dbx,
            secret_group_user::ActiveModel {
                master_key: Set(group.master_key.clone()),
                login_id: Set(granted.id),
                secret_group_organism_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let candidates = [granted.id, denied.id];
        let mut expected = BTreeSet::new();
        for login in candidates {
            if crate::messenger::group::get_identity_sigint_groups(
                &env.dbx, &login,
            )
            .await
            .unwrap()
            .contains(&group.master_key)
            {
                expected.insert(login);
            }
        }
        let txn = env.dbx.begin().await.unwrap();
        let actual =
            recipients_with_group_access(&txn, &candidates, &group.master_key)
                .await
                .unwrap()
                .into_iter()
                .collect::<BTreeSet<_>>();
        assert_eq!(expected, BTreeSet::from([granted.id]));
        assert_eq!(actual, expected);
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_batched_recipients_honor_secret_organism_grants_outside_group_selection(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let base = find_test_login(&env.dbx).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let organism = crate::functest::tests::mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let granted = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(organism.id)),
                sigint_zone_id: Set(base.sigint_zone_id),
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_group::Entity::update_many()
            .col_expr(signal_group::Column::IsSecret, Expr::value(true))
            .filter(
                signal_group::Column::MasterKey.eq(group.master_key.clone()),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        let secret_organism = secret_group_organism::Entity::insert(
            secret_group_organism::ActiveModel {
                master_key: Set(group.master_key.clone()),
                organism_id: Set(organism.id),
                ..Default::default()
            },
        )
        .exec(&env.dbx)
        .await
        .unwrap()
        .last_insert_id;
        mk_secret_group_user(
            &env.dbx,
            secret_group_user::ActiveModel {
                master_key: Set(group.master_key.clone()),
                login_id: Set(granted.id),
                secret_group_organism_id: Set(Some(secret_organism)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let expected = crate::messenger::group::get_identity_sigint_groups(
            &env.dbx,
            &granted.id,
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let actual = recipients_with_group_access(
            &txn,
            &[granted.id],
            &group.master_key,
        )
        .await
        .unwrap();
        assert!(expected.contains(&group.master_key));
        assert_eq!(actual, vec![granted.id]);
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3694_importance_endpoints_fan_out_inbox_changes() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login_row = find_test_login(&env.dbx).await.unwrap();
        let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let session_id = Uuid::now_v7();
        crate::session::add_session(
            &mut env.redis.clone(),
            session_id,
            &login_row.id,
        )
        .await
        .unwrap();
        crate::event_stream::create_redis_stream(
            &mut env.redis.clone(),
            session_id,
        )
        .await
        .unwrap();
        let stream_id = crate::event_stream::session_stream_id(session_id);

        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .route("/test/login/{login_id}", web::post().to(login))
                .service(important_add)
                .service(important_rm),
        )
        .await;
        let login_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", login_row.id))
                .to_request(),
        )
        .await;
        let session_cookie: Cookie<'static> = login_response
            .response()
            .cookies()
            .next()
            .unwrap()
            .into_owned();

        let add_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/important/add")
                .cookie(session_cookie.clone())
                .set_json(ImportantAddReq {
                    message_id: inbox_item.id,
                    group_master_key: None,
                    notify_group: false,
                    operation_id: None,
                })
                .to_request(),
        )
        .await;
        assert_eq!(add_response.status(), StatusCode::OK);
        let add_body: serde_json::Value =
            test::read_body_json(add_response).await;
        assert_eq!(add_body["important"], true);
        let mut redis = env.redis.clone();
        let add_events = event_types(&mut redis, &stream_id).await;

        redis.del::<_, ()>(&stream_id).await.unwrap();
        crate::event_stream::create_redis_stream(&mut redis, session_id)
            .await
            .unwrap();

        let repeated_add_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/important/add")
                .cookie(session_cookie.clone())
                .set_json(ImportantAddReq {
                    message_id: inbox_item.id,
                    group_master_key: None,
                    notify_group: false,
                    operation_id: None,
                })
                .to_request(),
        )
        .await;
        assert_eq!(repeated_add_response.status(), StatusCode::OK);
        let repeated_add_body: serde_json::Value =
            test::read_body_json(repeated_add_response).await;
        assert_eq!(repeated_add_body["important"], true);
        assert_eq!(
            sigint_important::Entity::find()
                .filter(
                    sigint_important::Column::LoginId.eq(Some(login_row.id)),
                )
                .filter(
                    sigint_important::Column::SignalMessageId.eq(inbox_item.id),
                )
                .filter(sigint_important::Column::Deleted.eq(false))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        let repeated_add_events = event_types(&mut redis, &stream_id).await;

        let other_important =
            sigint_important::Entity::insert(sigint_important::ActiveModel {
                login_id: Set(None),
                signal_message_id: Set(inbox_item.id),
                signal_message_uuid: Set(inbox_item.id_uuid),
                deleted: Set(false),
                ..Default::default()
            })
            .exec(&env.dbx)
            .await
            .unwrap()
            .last_insert_id;

        redis.del::<_, ()>(&stream_id).await.unwrap();
        crate::event_stream::create_redis_stream(&mut redis, session_id)
            .await
            .unwrap();
        let remove_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/important/delete")
                .cookie(session_cookie.clone())
                .set_json(ImportantRmReq {
                    message_id: inbox_item.id,
                })
                .to_request(),
        )
        .await;
        assert_eq!(remove_response.status(), StatusCode::OK);
        let remove_body: serde_json::Value =
            test::read_body_json(remove_response).await;
        assert_eq!(remove_body["important"], true);
        let remove_events = event_types(&mut redis, &stream_id).await;

        redis.del::<_, ()>(&stream_id).await.unwrap();
        crate::event_stream::create_redis_stream(&mut redis, session_id)
            .await
            .unwrap();
        let mut other_important =
            sigint_important::Entity::find_by_id(other_important)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        other_important.deleted = Set(true);
        other_important.update(&env.dbx).await.unwrap();
        let empty_remove_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/important/delete")
                .cookie(session_cookie)
                .set_json(ImportantRmReq {
                    message_id: inbox_item.id,
                })
                .to_request(),
        )
        .await;
        assert_eq!(empty_remove_response.status(), StatusCode::OK);
        let empty_remove_body: serde_json::Value =
            test::read_body_json(empty_remove_response).await;
        assert_eq!(empty_remove_body["important"], false);
        let empty_remove_events = event_types(&mut redis, &stream_id).await;

        redis.del::<_, ()>(&stream_id).await.unwrap();
        redis
            .del::<_, ()>(crate::event_stream::get_sess_key(session_id))
            .await
            .unwrap();
        redis
            .srem::<_, _, ()>(REDIS_SESSIONS_KEY, session_id.to_string())
            .await
            .unwrap();

        let expected = vec![EventType::ETInboxChanged(inbox_item.id)];
        assert_eq!(
            (
                add_events,
                repeated_add_events,
                remove_events,
                empty_remove_events
            ),
            (
                expected.clone(),
                expected.clone(),
                expected.clone(),
                expected
            )
        );
    }

    #[actix_web::test]
    #[serial]
    async fn echo_3610_replaying_a_personal_mark_after_unmark_does_not_remark()
    {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login_row = find_test_login(&env.dbx).await.unwrap();
        let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .route("/test/login/{login_id}", web::post().to(login))
                .service(important_add)
                .service(important_rm),
        )
        .await;
        let login_response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", login_row.id))
                .to_request(),
        )
        .await;
        let session_cookie = login_response
            .response()
            .cookies()
            .next()
            .unwrap()
            .into_owned();
        let operation_id = Uuid::now_v7();

        let add = |operation_id| {
            test::TestRequest::post()
                .uri("/api/rer/important/add")
                .cookie(session_cookie.clone())
                .set_json(ImportantAddReq {
                    message_id: inbox_item.id,
                    group_master_key: None,
                    notify_group: false,
                    operation_id: Some(operation_id),
                })
                .to_request()
        };
        let first = test::call_service(&app, add(operation_id)).await;
        assert_eq!(first.status(), StatusCode::OK);
        let remove = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/important/delete")
                .cookie(session_cookie.clone())
                .set_json(ImportantRmReq {
                    message_id: inbox_item.id,
                })
                .to_request(),
        )
        .await;
        assert_eq!(remove.status(), StatusCode::OK);

        let replay = test::call_service(&app, add(operation_id)).await;
        assert_eq!(replay.status(), StatusCode::OK);
        let replay: serde_json::Value = test::read_body_json(replay).await;
        assert_eq!(replay["important"], false);
        assert_eq!(
            sigint_important::Entity::find()
                .filter(
                    sigint_important::Column::LoginId.eq(Some(login_row.id))
                )
                .filter(
                    sigint_important::Column::SignalMessageId.eq(inbox_item.id)
                )
                .filter(sigint_important::Column::Deleted.eq(false))
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
    }
}

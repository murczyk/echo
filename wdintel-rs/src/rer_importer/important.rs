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
use sea_orm::{prelude::Expr, *};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportantAddReq {
    pub message_id: i64,
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
) -> anyhow::Result<()> {
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
        return Ok(());
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
    sigint_important::Entity::insert_many(importants)
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
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

async fn set_importance(
    env: &Env,
    login: Uuid,
    message_id: i64,
    important: bool,
) -> anyhow::Result<bool> {
    let txn = env.dbx.begin().await.context(h!())?;
    let affected_ids =
        crate::rer_importer::inbox::find_all_duplicates(&txn, message_id)
            .await
            .context(h!())?;
    if important {
        add_missing_importants(&txn, login, &affected_ids)
            .await
            .context(h!())?;
    } else {
        remove_importants(&txn, login, &affected_ids)
            .await
            .context(h!())?;
    }
    let important = important_state(&txn, &affected_ids).await.context(h!())?;
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
    let login = login_id_from_identity(&user)?;
    let important = set_importance(&env, login, req.message_id, true)
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
    let important = set_importance(&env, login, req.message_id, false)
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
        cleanup_locked, find_test_login, mk_sigint_inbox_item,
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
}

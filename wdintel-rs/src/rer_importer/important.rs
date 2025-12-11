use crate::config::RER_IMPORTER_IMPORTANT_LIST_LIMIT;
use crate::error::AppError;
use crate::types::*;
use crate::{entities::*, utils::*};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use chrono::prelude::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{prelude::Expr, *};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportantAddReq {
    pub message_id: i64,
}

#[post("/api/rer/important/add")]
async fn important_add(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ImportantAddReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let important_to_insert =
        crate::rer_importer::inbox::find_all_duplicates(&txn, req.message_id)
            .await
            .c(h!())?
            .into_iter()
            .map(|id| sigint_important::ActiveModel {
                id: NotSet,
                user_id: Set(Some(login.to_string())),
                signal_message_id: Set(id),
                deleted: Set(false),
                created_at: NotSet,
            })
            .collect::<Vec<sigint_important::ActiveModel>>();
    if !important_to_insert.is_empty() {
        sigint_important::Entity::insert_many(important_to_insert)
            .exec(&env.dbx)
            .await
            .c(h!())?;
    }

    println!(
        "Message {} marked as important by {}",
        req.message_id, login
    );
    txn.commit().await.c(h!())?;

    Ok(Json(()))
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    // let mut q = sigint_important::Entity::find()
    //     .filter(sigint_important::Column::UserId.eq(user.id().c(h!())?.to_string()));

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
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;

    sigint_important::Entity::update_many()
        .col_expr(sigint_important::Column::Deleted, Expr::value(true))
        .filter(
            sigint_important::Column::UserId.eq(user.id().c(h!())?.to_string()),
        )
        .filter(
            sigint_important::Column::SignalMessageId.is_in(
                crate::rer_importer::inbox::find_all_duplicates(
                    &txn,
                    req.message_id,
                )
                .await
                .c(h!())?,
            ),
        )
        .filter(sigint_important::Column::Deleted.eq(false))
        .exec(&env.dbx)
        .await
        .c(h!())?;

    println!(
        "Remove important sign for message {} by {}",
        req.message_id,
        user.id().c(h!())?
    );
    txn.commit().await.c(h!())?;

    Ok(Json(()))
}

pub fn is_important(body: &str) -> bool {
    body.trim().starts_with("⚠️")
}

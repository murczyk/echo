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
pub struct BookmarkAddReq {
    pub message_id: i64,
}

#[post("/api/rer/bookmark/add")]
async fn bookmark_add(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BookmarkAddReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id()?;
    crate::users::has_role(&env.dbx, &login, "Rer").await?;
    let txn = env.dbx.begin().await?;

    let bookmarks =
        crate::rer_importer::inbox::find_all_duplicates(&txn, req.message_id)
            .await?
            .into_iter()
            .map(|id| sigint_bookmark::ActiveModel {
                id: NotSet,
                user_id: Set(login.to_string()),
                signal_message_id: Set(id),
                deleted: Set(false),
                created_at: NotSet,
            })
            .collect::<Vec<sigint_bookmark::ActiveModel>>();

    if !bookmarks.is_empty() {
        sigint_bookmark::Entity::insert_many(bookmarks)
            .exec(&env.dbx)
            .await?;
    }

    println!(
        "Bookmark added for message_id: {} by {}",
        req.message_id, login
    );
    txn.commit().await?;

    Ok(Json(()))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BookmarkListReq {
    /// Defaults to 7 days
    since_ts_millis: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Bookmark {
    pub message_id: i64,
}

#[post("/api/rer/bookmarks")]
async fn bookmarks_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BookmarkListReq>,
) -> Result<Json<Vec<Bookmark>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    Ok(Json(
        sigint_bookmark::Entity::find()
            .filter(sigint_bookmark::Column::UserId.eq(user.id()?.to_string()))
            .filter(sigint_bookmark::Column::CreatedAt.gte(
                if let Some(since_ts_millis) = req.since_ts_millis {
                    dt_from_millis(since_ts_millis)?
                } else {
                    (Utc::now() - chrono::Duration::days(7)).naive_utc()
                },
            ))
            .filter(sigint_bookmark::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await?
            .into_iter()
            .map(|b| Bookmark {
                message_id: b.signal_message_id,
            })
            .collect(),
    ))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BookmarkRmReq {
    pub message_id: i64,
}

#[post("/api/rer/bookmark/delete")]
async fn bookmark_rm(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BookmarkRmReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let txn = env.dbx.begin().await?;

    sigint_bookmark::Entity::update_many()
        .col_expr(sigint_bookmark::Column::Deleted, Expr::value(true))
        .filter(sigint_bookmark::Column::UserId.eq(user.id()?.to_string()))
        .filter(
            sigint_bookmark::Column::SignalMessageId.is_in(
                crate::rer_importer::inbox::find_all_duplicates(
                    &txn,
                    req.message_id,
                )
                .await?,
            ),
        )
        .filter(sigint_bookmark::Column::Deleted.eq(false))
        .exec(&env.dbx)
        .await?;

    println!(
        "Bookmark removed for message_id: {} by {}",
        req.message_id,
        user.id()?
    );
    txn.commit().await?;

    Ok(Json(()))
}

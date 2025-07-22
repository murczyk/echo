use std::sync::Arc;

use crate::error::ContextAndError;
use crate::h;
use crate::messenger::types::*;
use crate::sigint::unit::types::{ListUnitsReq, ListUnitsRsp};
use crate::types::{AppError, Env, Mode};
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use echo_im::entities::sea_orm_active_enums::EchoMessageSource;
use echo_im::types::MessageSource;
use lazy_static::lazy_static;
use log::*;
use regex::Regex;
use sea_orm::*;
use std::time::*;

pub mod bl;
pub mod types;
pub mod utils;
pub mod worker;

#[post("/api/messenger/qr")]
pub async fn get_qr(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<QrCodeReq>,
) -> Result<Json<QrCodeRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    debug!("get_qr_code_for_bot: {user:?}; req = {req:?}");
    let txn = env.dbx.begin().await.context(h!())?;
    let messenger = parse_messenger(&req.messenger).cae(h!())?;
    let qr_code_base64 =
        bl::get_bot_qr_code(messenger, &txn).await.cae(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(QrCodeRsp { qr_code_base64 }))
}

#[post("/api/messenger/is-linked")]
pub async fn is_linked(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<IsBotLinkedReq>,
) -> Result<Json<IsBotLinkedRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let messenger = parse_messenger(&req.messenger).cae(h!())?;
    let is_linked = bl::is_bot_linked(messenger, &txn).await.context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(IsBotLinkedRsp { is_linked }))
}

#[utoipa::path(
    post,
    path = "/api/messenger/unlink",
    request_body = DeleteBotReq,
    responses((status = 200, body = DeleteBotRsp))
)]
pub async fn delete_bot(
    session: AuthSession,
    State(env): State<Arc<Env>>,
    Json(req): Json<DeleteBotReq>,
) -> Result<Json<DeleteBotRsp>, AppError> {
    let user = auth(session).await.context(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    debug!("delete_bot: {user:?}; req = {req:?}");
    check_is_admin(&env.db, user.id).await.cae(h!())?;
    let bot_id = parse_uuid(&req.bot_id).context(h!())?;
    let bot = messenger_bot::Entity::find_by_id(bot_id)
        .one(&txn)
        .await
        .context(h!())?
        .context(h!())?;
    let source = bot.messenger.clone();
    let bot_name = bot.name.clone();

    let mut bot = bot.into_active_model();
    bot.deleted = Set(true);
    bot.update(&txn).await.context(h!())?;

    bl::deactivete_bot(source, &bot_name).await.context(h!())?;

    txn.commit().await.context(h!())?;

    Ok(Json(DeleteBotRsp {}))
}

#[utoipa::path(
    post,
    path = "/api/messenger/link",
    request_body = CreateBotReq,
    responses((status = 200, body = CreateBotRsp))
)]
pub async fn create_bot(
    session: AuthSession,
    State(env): State<Arc<Env>>,
    Json(req): Json<CreateBotReq>,
) -> std::result::Result<Json<CreateBotRsp>, AppError> {
    let user = auth(session).await.cae(h!())?;
    debug!("create_bot: {user:?}; req = {req:?}");
    check_is_admin(&env.db, user.id).await.cae(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;

    only_alphanumeric_and_hyphen(&req.display_name)?;
    valid_phone_number(&req.phone)?;

    let source = match req.messenger.as_str() {
        "Signal" => EchoMessageSource::Signal,
        _ => EchoMessageSource::Whatsapp,
    };
    let bot = bl::create_bot(
        req.phone.as_str(),
        req.display_name.as_str(),
        source,
        &txn,
    )
    .await
    .cae(h!())?;
    txn.commit().await.cae(h!())?;
    let result = render_bot_f1(&bot).context(h!())?;
    Ok(Json(CreateBotRsp { result }))
}

fn only_alphanumeric_and_hyphen(x: &str) -> Result<(), AppError> {
    lazy_static! {
        static ref RE: Regex = Regex::new(r"^[A-Za-z0-9-]+$").unwrap();
    }
    if !RE.is_match(&x) {
        let msg = format!(
            "Назва може містити тільки латинські літери, цифри та дефіс: {x}",
        );
        return Err(AppError::BL { msg });
    };
    Ok(())
}

fn valid_phone_number(x: &str) -> Result<(), AppError> {
    lazy_static! {
        static ref RE: Regex = Regex::new(r"^\+38\d{10}$").unwrap();
    }
    if !RE.is_match(&x) {
        let msg = format!(
            "Номер телефону має починатись з +38 та містити 12 цифр: {x}"
        );
        return Err(AppError::BL { msg });
    }
    Ok(())
}

fn parse_messenger(messenger: &str) -> Result<EchoMessageSource, AppError> {
    match messenger.to_lowercase().trim() {
        "whatsapp" => Ok(EchoMessageSource::Whatsapp),
        "signal" => Ok(EchoMessageSource::Signal),
        _ => Err(AppError::BL {
            msg: format!("Unexpected messenger: {messenger}"),
        }),
    }
}

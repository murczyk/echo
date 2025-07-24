use crate::error::ContextAndError;
use crate::h;
use crate::messenger::types::*;
use crate::types::{AppError, Env};
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;

pub mod bl;
pub mod types;
pub mod worker;

#[post("/api/messenger/list")]
pub async fn list_linked_accounts(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<AccountsRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let accounts = bl::list_linked_accounts(&txn).await.context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(AccountsRsp { accounts }))
}

#[post("/api/messenger/qr")]
pub async fn get_qr(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<QrCodeReq>,
) -> Result<Json<QrCodeRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let qr_code_base64 =
        bl::get_qr_code(req.account_id, &txn).await.cae(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(QrCodeRsp { qr_code_base64 }))
}

#[post("/api/messenger/is-linked")]
pub async fn is_linked(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<IsAccountLinkedReq>,
) -> Result<Json<IsAccountLinkedRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let is_linked = bl::load_echo_account(req.account_id, &txn)
        .await
        .map(|a| a.is_linked)
        .unwrap_or(false);
    txn.commit().await.context(h!())?;
    Ok(Json(IsAccountLinkedRsp { is_linked }))
}

#[post("/api/messenger/edit")]
pub async fn edit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AccountStatusReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    bl::edit_account(req.account_id, req.is_active, &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(()))
}

#[post("/api/messenger/unlink")]
pub async fn unlink(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteAccountReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    bl::deactivate_account(req.account_id, &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(()))
}

#[post("/api/messenger/link")]
pub async fn link(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<LinkAccountReq>,
) -> Result<Json<LinkAccountRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    only_alphanumeric_and_hyphen(&req.display_name)?;
    valid_phone_number(&req.phone)?;

    let account = bl::link_account(
        req.phone.as_str(),
        req.display_name.as_str(),
        req.messenger.clone(),
        &txn,
    )
    .await
    .cae(h!())?;
    txn.commit().await.cae(h!())?;
    Ok(Json(LinkAccountRsp { account }))
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

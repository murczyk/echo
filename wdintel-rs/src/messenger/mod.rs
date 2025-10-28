use crate::entities::{datasource, group_admin_data, signal_group};
use crate::error::ContextAndError;
use crate::h;
use crate::messenger::bl::load_echo_account;
use crate::messenger::types::*;
use crate::sigint::aor::{load_default_aor, render_aor};
use crate::types::{AppError, Env, ShortContext};
use actix_web::post;
use actix_web::web::Json;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;

pub mod bl;
pub mod group;
pub mod id;
#[cfg(test)]
pub mod tests;
pub mod types;
pub mod worker;
pub mod worker_pool;

#[post("/api/messenger/list")]
pub async fn list_messengers(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<AccountsRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let accounts = bl::list_echo_accounts(None, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(AccountsRsp { accounts }))
}

#[post("/api/messenger/qr")]
pub async fn get_qr(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<QrCodeReq>,
) -> Result<Json<QrCodeRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"])
        .await
        .cae(h!())?;
    let qr_code_base64 = bl::get_qr_code(req.account_id, &env.dbx, &login)
        .await
        .cae(h!())?;
    Ok(Json(QrCodeRsp { qr_code_base64 }))
}

#[post("/api/messenger/is-linked")]
pub async fn is_linked(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<IsAccountLinkedReq>,
) -> Result<Json<IsAccountLinkedRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let is_linked = bl::load_echo_account(req.account_id, &txn)
        .await
        .map(|a| a.is_linked)
        .unwrap_or(false);
    txn.commit().await.c(h!())?;
    Ok(Json(IsAccountLinkedRsp { is_linked }))
}

#[post("/api/messenger/edit")]
pub async fn edit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AccountStatusReq>,
) -> Result<Json<EchoAccountF1>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let id = req.account_id;
    bl::edit_account(
        id,
        req.aor_id,
        req.is_active,
        req.display_name.to_string(),
        req.description.clone(),
        req.api_login.clone(),
        req.api_endpoint.clone(),
        &txn,
        &login,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    let result = bl::load_echo_account(id, &env.dbx).await.c(h!())?;
    Ok(Json(result))
}

#[post("/api/messenger/edit-group")]
pub async fn group_update(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<GroupUpdateReq>,
) -> Result<Json<GroupEntryF1>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    let req = req.into_inner();
    let txn = env.dbx.begin().await.c(h!())?;

    let res = bl::bl_group_update(&req, &txn).await.c(h!())?;

    txn.commit().await.c(h!())?;
    Ok(Json(GroupEntryF1 {
        master_key: res.group.master_key.clone(),
        name: res.group.name.clone().unwrap_or("".to_string()),
        ignore_operativny: res.group.ignore_operativny,
        short_note: res.group_data.short_note.clone(),
        long_note: res.group_data.long_note.clone(),
        group_stats: res.stats.clone(),
        areas_of_responsibility: if res.aors.is_empty() {
            None
        } else {
            Some(res.aors.into_iter().map(render_aor).collect())
        },
    }))
}

#[post("/api/messenger/unlink")]
pub async fn unlink(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteAccountReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    bl::deactivate_account(req.account_id, &txn, &login)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/messenger/link")]
pub async fn link(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<LinkAccountReq>,
) -> Result<Json<LinkAccountRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    only_alphanumeric_and_hyphen(&req.system_service_name)?;
    valid_phone_number(&req.phone)?;

    let account = bl::link_account(
        None,
        req.phone.as_str(),
        req.display_name.as_str(),
        req.system_service_name.as_str(),
        req.messenger.as_str(),
        req.description.clone(),
        req.aor_id,
        &txn,
        &login,
    )
    .await
    .cae(h!())?;
    txn.commit().await.cae(h!())?;
    Ok(Json(LinkAccountRsp { account }))
}

#[post("/api/messenger/link-operator")]
pub async fn link_operator(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<LinkEchoOperatorReq>,
) -> Result<Json<LinkAccountRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let aor_id = load_default_aor(&txn).await.c(h!())?.id;
    let new_datasource_id = datasource::ActiveModel {
        echo_client_lock_id: NotSet,
        id: NotSet,
        status: NotSet,
        created_at: NotSet,
        display_name: Set(req.display_name.to_string()),
        signal_phone: Set(None),
        signal_docker_port: NotSet,
        api_endpoint: Set(Some(req.api_endpoint.clone())),
        api_login: Set(Some(req.api_login.clone())),
        enabled: Set(Some(true)),
        group_master_key: NotSet,
        sender_uuid: NotSet,
        description: Set(req.description.clone()),
        kind: Set("echo_operator".to_string()),
        default_aor_id: Set(Some(aor_id)),
        updated_by: Set(Some(login.to_string())),
        deleted: NotSet,
        last_sync_at: NotSet,
    }
    .insert(&txn)
    .await
    .c(h!())?
    .id;
    let account = load_echo_account(new_datasource_id, &txn).await.c(h!())?;
    txn.commit().await.cae(h!())?;
    Ok(Json(LinkAccountRsp { account }))
}

fn only_alphanumeric_and_hyphen(x: &str) -> Result<(), AppError> {
    lazy_static! {
        static ref RE: Regex = Regex::new(r"^[A-Za-z0-9-]+$").unwrap();
    }
    if !RE.is_match(x) {
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
    if !RE.is_match(x) {
        let msg = format!(
            "Номер телефону має починатись з +38 та містити 12 цифр: {x}"
        );
        return Err(AppError::BL { msg });
    }
    Ok(())
}

use crate::entities::{group_admin_data, signal_group};
use crate::error::ContextAndError;
use crate::h;
use crate::messenger::types::*;
use crate::rer_importer::collect_group_stats;
use crate::sigint::area_of_responsibility::render_aor;
use crate::types::{AppError, Env};
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;

pub mod bl;
pub mod group;
pub mod types;
pub mod worker;

#[post("/api/messenger/list")]
pub async fn list_messengers(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<AccountsRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
        .await
        .cae(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let accounts = bl::list_accounts(&txn).await.context(h!())?;
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
) -> Result<Json<EchoAccountF1>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Admin"])
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
        &txn,
    )
    .await
    .context(h!())?;
    txn.commit().await.context(h!())?;
    let result = bl::load_echo_account(id, &env.dbx).await.context(h!())?;
    Ok(Json(result))
}

#[post("/api/messenger/edit-group")]
pub async fn group_update(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<GroupUpdateReq>,
) -> Result<Json<GroupEntryF1>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let txn = env.dbx.begin().await?;
    let req = req.into_inner();
    let m_group = group_admin_data::Entity::find()
        .filter(
            group_admin_data::Column::GroupMasterKey
                .eq(&req.master_key.clone()),
        )
        .one(&txn)
        .await
        .context(h!())?;
    let mut group_data = match m_group {
        Some(group) => group,
        None => group_admin_data::ActiveModel {
            group_master_key: Set(Some(req.master_key.clone())),
            short_note: Set(req.short_note.clone()),
            long_note: Set(req.long_note.clone()),
            id: NotSet,
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .context(h!())?,
    }
    .into_active_model();

    let aor = bl::upsert_group_area_of_responsibility(
        &txn,
        &req.master_key,
        req.area_of_responsibility_id.clone(),
    )
    .await
    .context(h!())?;

    group_data.short_note = Set(req.short_note);
    group_data.long_note = Set(req.long_note);
    let group_data = group_data.update(&txn).await.context(h!())?;

    let group = signal_group::Entity::find_by_id(req.master_key.clone())
        .one(&txn)
        .await
        .context(h!())?
        .context(h!())?;

    let stats = collect_group_stats(vec![group.master_key.clone()], &env.dbx)
        .await
        .context(h!())?
        .get(&group.master_key)
        .cloned()
        .unwrap_or_default();

    txn.commit().await?;

    Ok(Json(GroupEntryF1 {
        master_key: group.master_key,
        name: group.name.unwrap_or("".to_string()),
        ignore_operativny: group.ignore_operativny,
        short_note: group_data.short_note,
        long_note: group_data.long_note,
        group_stats: stats,
        area_of_responsibility: aor.map(render_aor),
    }))
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
    only_alphanumeric_and_hyphen(&req.system_service_name)?;
    valid_phone_number(&req.phone)?;

    let account = bl::link_account(
        req.phone.as_str(),
        req.display_name.as_str(),
        req.system_service_name.as_str(),
        req.messenger.as_str(),
        req.description.clone(),
        req.aor_id,
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

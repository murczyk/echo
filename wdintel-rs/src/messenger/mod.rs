use crate::entities::{
    datasource, datasource_group, group_admin_data, signal_group,
};
use crate::error::ContextAndError;
use crate::h;
use crate::messenger::bl::load_echo_account;
use crate::messenger::group::types::SignalGroupStatsTimelinePoint;
use crate::messenger::types::*;
use crate::sigint::aor::{load_default_aor, render_aor};
use crate::types::{AppError, Env, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use actix_web::post;
use actix_web::web::Json;
use chrono::{Duration, Utc};
use echo_im::entities::sea_orm_active_enums::SignalCliMode;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;
use std::collections::{BTreeMap, HashMap, HashSet};

pub mod bl;
pub mod dedupe;
pub mod group;
pub mod id;
pub mod media;
pub mod media_wave;
pub(crate) mod oneoff;
pub mod ops;
#[cfg(test)]
pub mod tests;
pub mod types;
pub mod worker;

#[post("/api/messenger/list")]
pub async fn list_messengers(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<AccountsRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Admin"])
        .await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let accounts = bl::list_echo_accounts(None, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(AccountsRsp { accounts }))
}

#[post("/api/messenger/accounts-stats-timeline")]
pub async fn accounts_stats_timeline(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AccountStatsTimelineReq>,
) -> Result<Json<AccountStatsTimelineRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Admin"])
        .await?;
    let req = req.into_inner();
    let mut seen = HashSet::new();
    let datasource_ids = req
        .datasource_ids
        .into_iter()
        .filter(|datasource_id| seen.insert(*datasource_id))
        .collect::<Vec<_>>();
    let period_hours = req.period_hours.unwrap_or(24 * 90).clamp(1, 24 * 90);
    let dt_till = Utc::now().naive_utc();
    let dt_since = dt_till - Duration::hours(period_hours);

    let datasource_groups = if datasource_ids.is_empty() {
        vec![]
    } else {
        datasource_group::Entity::find()
            .filter(
                datasource_group::Column::DatasourceId
                    .eq_any(datasource_ids.clone()),
            )
            .filter(datasource_group::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .c(h!())?
    };
    let mut keys_by_datasource = datasource_ids
        .iter()
        .map(|datasource_id| (*datasource_id, HashSet::new()))
        .collect::<HashMap<_, _>>();
    for datasource_group in datasource_groups {
        keys_by_datasource
            .entry(datasource_group.datasource_id)
            .or_default()
            .insert(datasource_group.group_master_key);
    }
    let master_keys = keys_by_datasource
        .values()
        .flat_map(|keys| keys.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let timelines = crate::stats::read_group_stats_timeline_cached(
        &env.dbx,
        master_keys,
        dt_since,
        dt_till,
    )
    .await
    .c(h!())?;
    let timeline_by_key = timelines
        .into_iter()
        .map(|timeline| (timeline.master_key, timeline.points))
        .collect::<HashMap<_, _>>();
    let data = datasource_ids
        .into_iter()
        .map(|datasource_id| {
            let mut counts_by_timestamp = BTreeMap::<i64, i64>::new();
            for master_key in keys_by_datasource
                .get(&datasource_id)
                .into_iter()
                .flat_map(|keys| keys.iter())
            {
                for point in
                    timeline_by_key.get(master_key).into_iter().flatten()
                {
                    *counts_by_timestamp.entry(point.timestamp).or_insert(0) +=
                        point.count;
                }
            }
            let points = counts_by_timestamp
                .into_iter()
                .map(|(timestamp, count)| SignalGroupStatsTimelinePoint {
                    timestamp,
                    count,
                })
                .collect();
            AccountStatsTimelineEntry {
                datasource_id,
                points,
            }
        })
        .collect();

    Ok(Json(AccountStatsTimelineRsp { data }))
}

#[post("/api/messenger/qr")]
pub async fn get_qr(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<QrCodeReq>,
) -> Result<Json<QrCodeRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"]).await?;
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
        .await?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let is_account_linked = bl::is_account_linked(req.account_id, &txn).await;
    txn.commit().await.c(h!())?;
    if is_account_linked.is_linked {
        let client_name = is_account_linked.client_name.c(h!())?;
        tokio::spawn(bl::sync_signal_once(client_name, env.config.clone()));
    }
    Ok(Json(IsAccountLinkedRsp {
        is_linked: is_account_linked.is_linked,
    }))
}

#[post("/api/messenger/edit")]
pub async fn edit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AccountStatusReq>,
) -> Result<Json<EchoAccountF1>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"]).await?;
    let id = req.account_id;
    bl::edit_account(
        id,
        req.aor_id,
        req.is_active,
        req.display_name.to_string(),
        req.description.clone(),
        req.api_login.clone(),
        req.api_endpoint.clone(),
        &env.dbx,
        &login,
    )
    .await
    .c(h!())?;
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
    crate::sigint::network::etalon_calc::invalidate_network_inbox_for_group(
        &env.dbx,
        &res.group,
        format!(
            "updated group from web UI: {}",
            res.group.master_key.clone()
        ),
    )
    .await
    .c(h!())?;
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
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"]).await?;
    let txn = env.dbx.begin().await.cae(h!())?;
    bl::deactivate_account(req.account_id, &txn, Some(login.clone()), true)
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
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"]).await?;
    let txn = env.dbx.begin().await.cae(h!())?;
    only_alphanumeric_and_hyphen(&req.system_service_name)?;
    valid_phone_number(&req.phone)?;
    let signal_cli_mode = if req.messenger.eq_ignore_ascii_case("signal") {
        parse_signal_cli_mode(req.signal_cli_mode.as_deref())?
    } else {
        SignalCliMode::Native
    };

    let account = bl::link_account(
        None,
        req.phone.as_str(),
        req.display_name.as_str(),
        req.system_service_name.as_str(),
        req.messenger.as_str(),
        signal_cli_mode,
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
    crate::users::has_any_role(&env.dbx, &login, vec!["Admin"]).await?;
    let txn = env.dbx.begin().await.cae(h!())?;
    let aor_id = load_default_aor(&txn).await.c(h!())?.id;
    let new_datasource_id = datasource::ActiveModel {
        echo_client_lock_id: NotSet,
        id: NotSet,
        status: NotSet,
        created_at: NotSet,
        display_name: Set(req.display_name.to_string()),
        signal_phone: Set(None),
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

fn parse_signal_cli_mode(
    signal_cli_mode: Option<&str>,
) -> Result<SignalCliMode, AppError> {
    match signal_cli_mode.map(str::trim).filter(|x| !x.is_empty()) {
        None => Ok(SignalCliMode::Normal),
        Some("Normal") | Some("normal") => Ok(SignalCliMode::Normal),
        Some("Native") | Some("native") => Ok(SignalCliMode::Native),
        Some(value) => Err(AppError::BL {
            msg: format!("Невідомий режим Signal CLI: {value}"),
        }),
    }
}

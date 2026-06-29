use self::types::*;
use crate::config::{
    UNIT_MACHINE_DUPLICATE_ACTIVE_MACHINE_ID_ERR_CODE,
    UNIT_MACHINE_QUEUE_WORKER_BATCH_SIZE, UNIT_MACHINE_QUEUE_WORKER_SLEEP_SECS,
    UNIT_MACHINE_RECALC_HISTORY_DAYS,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{error, Mode, ShortContext};
use crate::utils::worker_watch;
use actix_web::web::Json;
use actix_web::{post, HttpResponse};
use chrono::{Duration, Utc};
use sea_orm::prelude::Expr;
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use serde_json::json;
use std::collections::HashSet;

pub mod types;

const MATCH_SOURCE_MACHINE_ID: &str = "machine_id";
const MATCH_SOURCE_MACHINE_TAG: &str = "machine_tag";

#[post("/api/unit-machines/list")]
pub async fn unit_machines_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<crate::types::Env>,
    req: Json<UnitMachineListReq>,
) -> Result<Json<UnitMachineListRsp>, AppError> {
    ensure_unit_machine_access(&env.dbx, &user).await.c(h!())?;
    let mut query = unit_machine::Entity::find();
    if !req.include_archived.unwrap_or(false) {
        query = query.filter(unit_machine::Column::Deleted.eq(false));
    }
    if let Some(sigint_network_id) = req.sigint_network_id {
        query = query.filter(
            unit_machine::Column::SigintNetworkId.eq(sigint_network_id),
        );
    }
    if let Some(search) = req
        .query
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        let search = format!("%{}%", search.to_lowercase());
        query = query.filter(
            Expr::cust_with_values(
                "(lower(coalesce(machine_id, '')) like $1 or lower(machine_tags::text) like $1)",
                [search],
            ),
        );
    }
    let unit_machines = query
        .order_by_asc(unit_machine::Column::Deleted)
        .order_by_desc(unit_machine::Column::UpdatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let items = map_unit_machine_items(&env.dbx, unit_machines)
        .await
        .c(h!())?;
    Ok(Json(UnitMachineListRsp { items }))
}

#[post("/api/unit-machines/create")]
pub async fn unit_machine_create(
    user: actix_identity::Identity,
    env: actix_web::web::Data<crate::types::Env>,
    req: Json<UnitMachineCreateReq>,
) -> Result<HttpResponse, AppError> {
    ensure_unit_machine_access(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let machine_id = normalize_machine_id(req.machine_id);
    let machine_tags = normalize_machine_tags(req.machine_tags).c(h!())?;
    if has_active_machine_id_duplicate(&env.dbx, None, machine_id.as_deref())
        .await
        .c(h!())?
    {
        return Ok(duplicate_machine_id_response());
    }
    let warning =
        archived_duplicate_warning(&env.dbx, None, machine_id.as_deref())
            .await
            .c(h!())?;
    let unit_machine = unit_machine::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(req.sigint_network_id),
        machine_id: Set(machine_id),
        machine_tags: Set(serde_json::to_value(machine_tags).c(h!())?),
        deleted: Set(false),
        created_at: NotSet,
        updated_at: NotSet,
        updated_by: Set(Some(user.id().c(h!())?)),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    enqueue_recent_non_rer_unit_machine_recalculation(&env.dbx)
        .await
        .c(h!())?;
    let item = map_unit_machine_item(&env.dbx, unit_machine)
        .await
        .c(h!())?;
    Ok(HttpResponse::Ok().json(UnitMachineMutationRsp { item, warning }))
}

#[post("/api/unit-machines/update")]
pub async fn unit_machine_update(
    user: actix_identity::Identity,
    env: actix_web::web::Data<crate::types::Env>,
    req: Json<UnitMachineUpdateReq>,
) -> Result<HttpResponse, AppError> {
    ensure_unit_machine_access(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let unit_machine = unit_machine::Entity::find_by_id(req.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let machine_id = normalize_machine_id(req.machine_id);
    let machine_tags = normalize_machine_tags(req.machine_tags).c(h!())?;
    if has_active_machine_id_duplicate(
        &env.dbx,
        Some(unit_machine.id),
        machine_id.as_deref(),
    )
    .await
    .c(h!())?
    {
        return Ok(duplicate_machine_id_response());
    }
    let warning = archived_duplicate_warning(
        &env.dbx,
        Some(unit_machine.id),
        machine_id.as_deref(),
    )
    .await
    .c(h!())?;
    let mut unit_machine = unit_machine.into_active_model();
    unit_machine.sigint_network_id = Set(req.sigint_network_id);
    unit_machine.machine_id = Set(machine_id);
    unit_machine.machine_tags =
        Set(serde_json::to_value(machine_tags).c(h!())?);
    unit_machine.updated_at = Set(Utc::now().naive_utc());
    unit_machine.updated_by = Set(Some(user.id().c(h!())?));
    let unit_machine = unit_machine.update(&env.dbx).await.c(h!())?;
    enqueue_recent_non_rer_unit_machine_recalculation(&env.dbx)
        .await
        .c(h!())?;
    let item = map_unit_machine_item(&env.dbx, unit_machine)
        .await
        .c(h!())?;
    Ok(HttpResponse::Ok().json(UnitMachineMutationRsp { item, warning }))
}

#[post("/api/unit-machines/archive")]
pub async fn unit_machine_archive(
    user: actix_identity::Identity,
    env: actix_web::web::Data<crate::types::Env>,
    req: Json<UnitMachineArchiveReq>,
) -> Result<HttpResponse, AppError> {
    mutate_unit_machine_deleted(user, env, req.id, true).await
}

#[post("/api/unit-machines/restore")]
pub async fn unit_machine_restore(
    user: actix_identity::Identity,
    env: actix_web::web::Data<crate::types::Env>,
    req: Json<UnitMachineArchiveReq>,
) -> Result<HttpResponse, AppError> {
    mutate_unit_machine_deleted(user, env, req.id, false).await
}

async fn mutate_unit_machine_deleted(
    user: actix_identity::Identity,
    env: actix_web::web::Data<crate::types::Env>,
    id: i64,
    deleted: bool,
) -> Result<HttpResponse, AppError> {
    ensure_unit_machine_access(&env.dbx, &user).await.c(h!())?;
    let unit_machine = unit_machine::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if !deleted
        && has_active_machine_id_duplicate(
            &env.dbx,
            Some(unit_machine.id),
            unit_machine.machine_id.as_deref(),
        )
        .await
        .c(h!())?
    {
        return Ok(duplicate_machine_id_response());
    }
    let mut unit_machine = unit_machine.into_active_model();
    unit_machine.deleted = Set(deleted);
    unit_machine.updated_at = Set(Utc::now().naive_utc());
    unit_machine.updated_by = Set(Some(user.id().c(h!())?));
    let unit_machine = unit_machine.update(&env.dbx).await.c(h!())?;
    enqueue_recent_non_rer_unit_machine_recalculation(&env.dbx)
        .await
        .c(h!())?;
    let item = map_unit_machine_item(&env.dbx, unit_machine)
        .await
        .c(h!())?;
    Ok(HttpResponse::Ok().json(UnitMachineMutationRsp {
        item,
        warning: None,
    }))
}

pub async fn enqueue_unit_machine_recalculation_for_inbox_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_unit_machine_queue::Entity::insert(
        sigint_inbox_item_unit_machine_queue::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(sigint_inbox_item_id),
            created_at: NotSet,
        },
    )
    .on_conflict(
        OnConflict::column(
            sigint_inbox_item_unit_machine_queue::Column::SigintInboxItemId,
        )
        .do_nothing()
        .to_owned(),
    )
    .do_nothing()
    .exec(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn enqueue_recent_non_rer_unit_machine_recalculation<C>(
    db: &C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let since = Utc::now().naive_utc()
        - Duration::days(UNIT_MACHINE_RECALC_HISTORY_DAYS);
    let item_ids = sigint_inbox_item::Entity::find()
        .distinct()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(signal_group::Column::IsRer.eq(false))
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    for item_id in item_ids {
        enqueue_unit_machine_recalculation_for_inbox_item(db, item_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn enqueue_recent_unit_machine_recalculation_for_group<C>(
    db: &C,
    master_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let since = Utc::now().naive_utc()
        - Duration::days(UNIT_MACHINE_RECALC_HISTORY_DAYS);
    let item_ids = sigint_inbox_item::Entity::find()
        .distinct()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(signal_message_group::Column::GroupMasterKey.eq(master_key))
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    for item_id in item_ids {
        enqueue_unit_machine_recalculation_for_inbox_item(db, item_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn run_unit_machine_queue_worker_nofail(mode: Mode) {
    let (_config, _settlements, _rq, _redis, dbx) =
        crate::utils::setup_worker(mode).await.unwrap();
    loop {
        let _loop_guard = worker_watch::loop_guard("unit_machine_queue_worker");
        match run_unit_machine_queue_worker_once(&dbx).await {
            Ok(has_work) => {
                if !has_work {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        UNIT_MACHINE_QUEUE_WORKER_SLEEP_SECS,
                    ))
                    .await;
                }
            }
            Err(err) => {
                error!("unit_machine_queue_worker failed: {err:#?}");
                tokio::time::sleep(std::time::Duration::from_secs(
                    UNIT_MACHINE_QUEUE_WORKER_SLEEP_SECS,
                ))
                .await;
            }
        }
    }
}

async fn run_unit_machine_queue_worker_once(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    if !crate::system_settings::support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(false);
    }
    let queue_items = sigint_inbox_item_unit_machine_queue::Entity::find()
        .order_by_asc(sigint_inbox_item_unit_machine_queue::Column::CreatedAt)
        .order_by_asc(sigint_inbox_item_unit_machine_queue::Column::Id)
        .limit(UNIT_MACHINE_QUEUE_WORKER_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())?;
    if queue_items.is_empty() {
        return Ok(false);
    }
    for queue_item in queue_items {
        recalculate_inbox_item_unit_machines(
            dbx,
            queue_item.sigint_inbox_item_id,
        )
        .await
        .c(h!())?;
        sigint_inbox_item_unit_machine_queue::Entity::delete_by_id(
            queue_item.id,
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(true)
}

pub async fn recalculate_inbox_item_unit_machines<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    if !inbox_item_is_non_rer(db, sigint_inbox_item_id)
        .await
        .c(h!())?
    {
        delete_unit_machine_links_for_item(db, sigint_inbox_item_id)
            .await
            .c(h!())?;
        recalculate_regular_networks_for_item(db, sigint_inbox_item_id)
            .await
            .c(h!())?;
        return Ok(());
    }
    let Some(message) =
        signal_message::Entity::find_by_id(sigint_inbox_item_id)
            .one(db)
            .await
            .c(h!())?
    else {
        delete_unit_machine_links_for_item(db, sigint_inbox_item_id)
            .await
            .c(h!())?;
        return Ok(());
    };
    let body = message.body.unwrap_or_default();
    let header = parse_unit_machine_header(&body);
    let match_text = unit_machine_match_text(&body, &header);
    let active_unit_machines = unit_machine::Entity::find()
        .filter(unit_machine::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    let mut matches = active_unit_machines
        .iter()
        .filter_map(|unit_machine| {
            unit_machine.machine_id.as_ref().and_then(|machine_id| {
                if contains_word_case_insensitive(&match_text, machine_id) {
                    Some((unit_machine.clone(), MATCH_SOURCE_MACHINE_ID))
                } else {
                    None
                }
            })
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        matches = active_unit_machines
            .into_iter()
            .filter_map(|unit_machine| {
                unit_machine_tags(&unit_machine)
                    .into_iter()
                    .any(|tag| {
                        contains_word_case_insensitive(&match_text, &tag)
                    })
                    .then_some((unit_machine, MATCH_SOURCE_MACHINE_TAG))
            })
            .collect::<Vec<_>>();
    }
    sync_unit_machine_links(db, sigint_inbox_item_id, matches)
        .await
        .c(h!())?;
    Ok(())
}

async fn recalculate_regular_networks_for_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let Some(sigint_inbox_item) =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .one(db)
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![sigint_inbox_item],
        db,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn sync_unit_machine_links<C>(
    db: &C,
    sigint_inbox_item_id: i64,
    matches: Vec<(unit_machine::Model, &'static str)>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let desired_machine_ids =
        matches.iter().map(|(m, _)| m.id).collect::<HashSet<_>>();
    let desired_network_ids = matches
        .iter()
        .map(|(m, _)| m.sigint_network_id)
        .collect::<HashSet<_>>();
    let existing_links = sigint_inbox_item_unit_machine::Entity::find()
        .filter(
            sigint_inbox_item_unit_machine::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .all(db)
        .await
        .c(h!())?;
    let stale_link_ids = existing_links
        .iter()
        .filter(|link| !desired_machine_ids.contains(&link.unit_machine_id))
        .map(|link| link.id)
        .collect::<Vec<_>>();
    if !stale_link_ids.is_empty() {
        sigint_inbox_item_unit_machine::Entity::delete_many()
            .filter(
                sigint_inbox_item_unit_machine::Column::Id
                    .is_in(stale_link_ids),
            )
            .exec(db)
            .await
            .c(h!())?;
    }

    let existing_machine_ids = existing_links
        .into_iter()
        .map(|link| link.unit_machine_id)
        .collect::<HashSet<_>>();
    for (unit_machine, match_source) in &matches {
        if !existing_machine_ids.contains(&unit_machine.id) {
            sigint_inbox_item_unit_machine::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(sigint_inbox_item_id),
                unit_machine_id: Set(unit_machine.id),
                match_source: Set((*match_source).to_string()),
                created_at: NotSet,
            }
            .insert(db)
            .await
            .c(h!())?;
        }
    }

    let existing_network_links = sigint_inbox_item_network::Entity::find()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .all(db)
        .await
        .c(h!())?;
    let stale_network_link_ids = collect_stale_network_link_ids(
        &existing_network_links,
        &desired_network_ids,
    );
    if !stale_network_link_ids.is_empty() {
        sigint_inbox_item_network::Entity::delete_many()
            .filter(
                sigint_inbox_item_network::Column::Id
                    .is_in(stale_network_link_ids),
            )
            .exec(db)
            .await
            .c(h!())?;
    }
    let existing_network_ids = existing_network_links
        .into_iter()
        .map(|link| link.sigint_network_id)
        .collect::<HashSet<_>>();
    for network_id in desired_network_ids {
        if !existing_network_ids.contains(&network_id) {
            sigint_inbox_item_network::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(sigint_inbox_item_id),
                sigint_network_id: Set(network_id),
                created_at: NotSet,
            }
            .insert(db)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

fn collect_stale_network_link_ids(
    existing_network_links: &[sigint_inbox_item_network::Model],
    desired_network_ids: &HashSet<i64>,
) -> Vec<i64> {
    existing_network_links
        .iter()
        .filter(|link| !desired_network_ids.contains(&link.sigint_network_id))
        .map(|link| link.id)
        .collect()
}

async fn delete_unit_machine_links_for_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let existing_links = sigint_inbox_item_unit_machine::Entity::find()
        .filter(
            sigint_inbox_item_unit_machine::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .all(db)
        .await
        .c(h!())?;
    let unit_machine_ids = existing_links
        .iter()
        .map(|link| link.unit_machine_id)
        .collect::<Vec<_>>();
    if !unit_machine_ids.is_empty() {
        let network_ids = unit_machine::Entity::find()
            .filter(unit_machine::Column::Id.is_in(unit_machine_ids))
            .select_only()
            .column(unit_machine::Column::SigintNetworkId)
            .into_tuple::<i64>()
            .all(db)
            .await
            .c(h!())?;
        if !network_ids.is_empty() {
            sigint_inbox_item_network::Entity::delete_many()
                .filter(
                    sigint_inbox_item_network::Column::SigintInboxItemId
                        .eq(sigint_inbox_item_id),
                )
                .filter(
                    sigint_inbox_item_network::Column::SigintNetworkId
                        .is_in(network_ids),
                )
                .exec(db)
                .await
                .c(h!())?;
        }
    }
    sigint_inbox_item_unit_machine::Entity::delete_many()
        .filter(
            sigint_inbox_item_unit_machine::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn inbox_item_is_non_rer<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let count = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(
            signal_message_group::Column::SignalMessageId
                .eq(sigint_inbox_item_id),
        )
        .filter(signal_group::Column::IsRer.eq(false))
        .count(db)
        .await
        .c(h!())?;
    Ok(count > 0)
}

fn parse_unit_machine_header(body: &str) -> ParsedUnitMachineHeader {
    let mut lines = body.lines();
    let Some(first_line) = lines.next().map(str::trim) else {
        return ParsedUnitMachineHeader::default();
    };
    let Some((left, _right)) = first_line.split_once('|') else {
        return ParsedUnitMachineHeader::default();
    };
    let left = left.trim();
    let (machine_tag, machine_id) =
        if let Some((tag, rest)) = left.split_once('[') {
            let machine_id = rest
                .split_once(']')
                .map(|(machine_id, _)| machine_id.trim().to_string())
                .filter(|machine_id| !machine_id.is_empty());
            (Some(tag.trim().to_string()), machine_id)
        } else {
            (Some(left.to_string()), None)
        };
    ParsedUnitMachineHeader {
        machine_tag: machine_tag.filter(|v| !v.is_empty()),
        machine_id,
    }
}

#[derive(Default)]
struct ParsedUnitMachineHeader {
    machine_tag: Option<String>,
    machine_id: Option<String>,
}

fn unit_machine_match_text(
    body: &str,
    header: &ParsedUnitMachineHeader,
) -> String {
    let mut parts = vec![body.to_string()];
    if let Some(machine_tag) = &header.machine_tag {
        parts.push(machine_tag.clone());
    }
    if let Some(machine_id) = &header.machine_id {
        parts.push(machine_id.clone());
    }
    parts.join(" ")
}

fn contains_word_case_insensitive(text: &str, needle: &str) -> bool {
    let needle = needle.trim();
    if needle.is_empty() {
        return false;
    }
    let text = text.to_lowercase();
    let needle = needle.to_lowercase();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find(&needle) {
        let start = cursor + offset;
        let end = start + needle.len();
        if is_boundary(&text, start, true) && is_boundary(&text, end, false) {
            return true;
        }
        cursor = end;
    }
    false
}

fn is_boundary(text: &str, byte_idx: usize, before: bool) -> bool {
    if before {
        text[..byte_idx]
            .chars()
            .next_back()
            .map(|ch| !ch.is_alphanumeric())
            .unwrap_or(true)
    } else {
        text[byte_idx..]
            .chars()
            .next()
            .map(|ch| !ch.is_alphanumeric())
            .unwrap_or(true)
    }
}

fn normalize_machine_id(machine_id: Option<String>) -> Option<String> {
    machine_id
        .map(|machine_id| machine_id.trim().to_string())
        .filter(|machine_id| !machine_id.is_empty())
}

fn normalize_machine_tags(
    machine_tags: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for machine_tag in machine_tags {
        let machine_tag = machine_tag.trim().to_string();
        if machine_tag.is_empty() {
            return Err(AppError::BL {
                msg: "machine_tags must not contain empty values".to_string(),
            });
        }
        let key = machine_tag.to_lowercase();
        if seen.insert(key) {
            out.push(machine_tag);
        }
    }
    Ok(out)
}

fn unit_machine_tags(unit_machine: &unit_machine::Model) -> Vec<String> {
    serde_json::from_value(unit_machine.machine_tags.clone())
        .unwrap_or_default()
}

fn duplicate_machine_id_response() -> HttpResponse {
    HttpResponse::BadRequest().json(json!({
        "err_code": UNIT_MACHINE_DUPLICATE_ACTIVE_MACHINE_ID_ERR_CODE
    }))
}

async fn has_active_machine_id_duplicate(
    dbx: &DatabaseConnection,
    current_id: Option<i64>,
    machine_id: Option<&str>,
) -> Result<bool, AppError> {
    has_machine_id_duplicate(dbx, current_id, machine_id, false).await
}

async fn archived_duplicate_warning(
    dbx: &DatabaseConnection,
    current_id: Option<i64>,
    machine_id: Option<&str>,
) -> Result<Option<UnitMachineWarning>, AppError> {
    if has_machine_id_duplicate(dbx, current_id, machine_id, true).await? {
        Ok(Some(UnitMachineWarning {
            code: UnitMachineWarningCode::ArchivedDuplicateMachineId,
            message: "machine_id already exists on an archived machine"
                .to_string(),
        }))
    } else {
        Ok(None)
    }
}

async fn has_machine_id_duplicate(
    dbx: &DatabaseConnection,
    current_id: Option<i64>,
    machine_id: Option<&str>,
    deleted: bool,
) -> Result<bool, AppError> {
    let Some(machine_id) = machine_id else {
        return Ok(false);
    };
    let mut query = unit_machine::Entity::find()
        .filter(unit_machine::Column::Deleted.eq(deleted))
        .filter(Expr::cust_with_values(
            "lower(machine_id) = lower($1)",
            [machine_id.to_string()],
        ));
    if let Some(current_id) = current_id {
        query = query.filter(unit_machine::Column::Id.ne(current_id));
    }
    Ok(query.count(dbx).await.c(h!())? > 0)
}

async fn ensure_unit_machine_access(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    crate::system_settings::ensure_support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?;
    crate::users::has_role(dbx, &user.id().c(h!())?, "NetworkEditor")
        .await
        .c(h!())?;
    Ok(())
}

async fn map_unit_machine_items(
    dbx: &DatabaseConnection,
    unit_machines: Vec<unit_machine::Model>,
) -> Result<Vec<UnitMachineItem>, AppError> {
    let mut items = Vec::new();
    for unit_machine in unit_machines {
        items.push(map_unit_machine_item(dbx, unit_machine).await.c(h!())?);
    }
    Ok(items)
}

async fn map_unit_machine_item(
    dbx: &DatabaseConnection,
    unit_machine: unit_machine::Model,
) -> Result<UnitMachineItem, AppError> {
    let network_display_name =
        network_display_name(dbx, unit_machine.sigint_network_id)
            .await
            .c(h!())?;
    Ok(UnitMachineItem {
        id: unit_machine.id,
        sigint_network_id: unit_machine.sigint_network_id,
        network_display_name,
        machine_id: unit_machine.machine_id.clone(),
        machine_tags: unit_machine_tags(&unit_machine),
        deleted: unit_machine.deleted,
        created_at: unit_machine.created_at.and_utc().timestamp_millis(),
        updated_at: unit_machine.updated_at.and_utc().timestamp_millis(),
        updated_by: unit_machine.updated_by,
    })
}

async fn network_display_name(
    dbx: &DatabaseConnection,
    sigint_network_id: i64,
) -> Result<String, AppError> {
    let sigint_network = sigint_network::Entity::find_by_id(sigint_network_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let unit_names = sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(sigint_network_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit::Column::Name)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?;
    if unit_names.is_empty() {
        Ok(sigint_network.name)
    } else {
        Ok(format!(
            "{} - {}",
            sigint_network.name,
            unit_names.join(", ")
        ))
    }
}

pub async fn non_rer_item_ids_from_items<C>(
    db: &C,
    sigint_inbox_item_ids: Vec<i64>,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait,
{
    if sigint_inbox_item_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let ids = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(
            signal_message_group::Column::SignalMessageId
                .is_in(sigint_inbox_item_ids),
        )
        .filter(signal_group::Column::IsRer.eq(false))
        .select_only()
        .column(signal_message_group::Column::SignalMessageId)
        .distinct()
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_machine_tag_header_without_machine_id() {
        let header = parse_unit_machine_header("50 обрБпС | 2026-06-26\n11-34");

        assert_eq!(header.machine_tag.as_deref(), Some("50 обрБпС"));
        assert_eq!(header.machine_id, None);
    }

    #[test]
    fn parses_machine_tag_header_with_machine_id() {
        let header = parse_unit_machine_header(
            "50 обрБпС [33hhfg50d] | 2026-06-26_08-13-12",
        );

        assert_eq!(header.machine_tag.as_deref(), Some("50 обрБпС"));
        assert_eq!(header.machine_id.as_deref(), Some("33hhfg50d"));
    }

    #[test]
    fn machine_match_requires_word_boundaries() {
        assert!(contains_word_case_insensitive(
            "prefix [33HHFG50D] suffix",
            "33hhfg50d"
        ));
        assert!(!contains_word_case_insensitive(
            "prefix x33hhfg50d suffix",
            "33hhfg50d"
        ));
    }

    #[test]
    fn stale_network_links_include_non_machine_networks() {
        let existing_network_links =
            vec![test_network_link(10, 1), test_network_link(11, 2)];
        let desired_network_ids = HashSet::from([2]);

        assert_eq!(
            collect_stale_network_link_ids(
                &existing_network_links,
                &desired_network_ids
            ),
            vec![10]
        );
    }

    fn test_network_link(
        id: i64,
        sigint_network_id: i64,
    ) -> sigint_inbox_item_network::Model {
        sigint_inbox_item_network::Model {
            id,
            sigint_inbox_item_id: 1,
            sigint_network_id,
            created_at: Utc::now().naive_utc(),
        }
    }
}

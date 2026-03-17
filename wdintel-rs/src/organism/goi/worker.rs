use crate::config::{
    ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS,
    ORGANISM_GOI_KNOWLEDGE_SYNC_INTERVAL_SEC,
    ORGANISM_GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS,
    ORGANISM_GOI_REPORT_PUSH_INTERVAL_SEC,
};
use crate::entities::{goi_association, goi_knowledge, organism};
use crate::error::AppError;
use crate::organism::goi::shared::{
    goi_api_host, goi_api_port, organism_has_goi_api_config,
};
use crate::types::*;
use crate::utils::string::normalize_optional_trimmed;
use goi_echo_worker::api::{
    AssociationApiItem, ImportSignedFrequenciesRsp, KnowledgeApiItem,
    ListAssociationsReq,
};
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use sea_query::Expr;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use url::Url;

const GOI_FREQUENCIES_IMPORT_PATH: &str = "/api/frequencies/signed/import";
const GOI_XLSX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

#[derive(Default)]
struct GoiWorkerState {
    last_knowledge_sync_attempt_at: HashMap<i64, Instant>,
    last_report_push_attempt_at: HashMap<i64, Instant>,
}

pub async fn goi_association_worker_nofail(env: Arc<Env>) {
    let mut state = GoiWorkerState::default();
    loop {
        if let Err(err) = goi_association_worker_step(&env, &mut state).await {
            log::warn!("GOI association worker step failed: {err:#}");
            tokio::time::sleep(goi_worker_sleep_duration()).await;
        }
    }
}

async fn goi_association_worker_step(
    env: &Env,
    state: &mut GoiWorkerState,
) -> Result<(), AppError> {
    let organisms = load_goi_api_organisms(&env.dbx).await.c(h!())?;
    if organisms.is_empty() {
        tokio::time::sleep(goi_worker_sleep_duration()).await;
        return Ok(());
    }

    for organism in organisms {
        if let Err(err) = sync_goi_associations(env, &organism).await {
            let label = organism.name.clone();
            log::warn!("Skipping GOI association sync for {label}: {err:#}");
        }
        if let Err(err) = sync_goi_knowledge_if_due(env, &organism, state).await
        {
            let label = organism.name.clone();
            log::warn!("Skipping GOI knowledge sync for {label}: {err:#}");
        }
        if let Err(err) = push_goi_report_if_due(env, &organism, state).await {
            let label = organism.name.clone();
            log::warn!("Skipping GOI report push for {label}: {err:#}");
        }
        tokio::time::sleep(goi_worker_sleep_duration()).await;
    }
    Ok(())
}

async fn load_goi_api_organisms(
    db: &DatabaseConnection,
) -> Result<Vec<organism::Model>, AppError> {
    let has_api_host = Condition::all()
        .add(organism::Column::GoiApiHost.is_not_null())
        .add(organism::Column::GoiApiHost.ne(""));
    let has_ssh_host = Condition::all()
        .add(organism::Column::GoiSshHost.is_not_null())
        .add(organism::Column::GoiSshHost.ne(""));
    let has_api_login = Condition::all()
        .add(organism::Column::GoiApiLogin.is_not_null())
        .add(organism::Column::GoiApiLogin.ne(""));
    let has_api_password = Condition::all()
        .add(organism::Column::GoiApiPassword.is_not_null())
        .add(organism::Column::GoiApiPassword.ne(""));
    let organisms = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(Condition::any().add(has_api_host).add(has_ssh_host))
        .filter(has_api_login)
        .filter(has_api_password)
        .all(db)
        .await
        .c(h!())?;
    Ok(organisms
        .into_iter()
        .filter(organism_has_goi_api_config)
        .collect())
}

async fn sync_goi_associations(
    env: &Env,
    organism: &organism::Model,
) -> Result<(), AppError> {
    let since_id = last_source_association_id(&env.dbx, organism.id)
        .await
        .c(h!())?;
    let items = fetch_goi_associations(env, organism, since_id)
        .await
        .c(h!())?;
    if items.is_empty() {
        return Ok(());
    }
    insert_goi_associations(&env.dbx, organism.id, items)
        .await
        .c(h!())?;
    Ok(())
}

async fn sync_goi_knowledge_if_due(
    env: &Env,
    organism: &organism::Model,
    state: &mut GoiWorkerState,
) -> Result<(), AppError> {
    if !goi_knowledge_sync_is_due(state, organism.id) {
        return Ok(());
    }

    state
        .last_knowledge_sync_attempt_at
        .insert(organism.id, Instant::now());

    prune_old_deleted_goi_knowledge(&env.dbx, organism.id)
        .await
        .c(h!())?;
    let items = fetch_goi_knowledge(env, organism).await.c(h!())?;
    upsert_goi_knowledge_snapshot(&env.dbx, organism.id, items)
        .await
        .c(h!())?;
    Ok(())
}

async fn last_source_association_id(
    db: &DatabaseConnection,
    organism_id: i64,
) -> Result<Option<i64>, AppError> {
    Ok(goi_association::Entity::find()
        .filter(goi_association::Column::OrganismId.eq(organism_id))
        .order_by_desc(goi_association::Column::SourceAssociationId)
        .one(db)
        .await
        .c(h!())?
        .map(|association| association.source_association_id))
}

async fn fetch_goi_associations(
    env: &Env,
    organism: &organism::Model,
    since_id: Option<i64>,
) -> Result<Vec<AssociationApiItem>, AppError> {
    let url = goi_associations_url(organism)?;
    let (login, password) = goi_api_credentials(organism)?;

    let response = env
        .rq
        .post(url)
        .basic_auth(login, Some(password))
        .json(&ListAssociationsReq {
            since_id_nonincl: since_id,
        })
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;
    Ok(response.json::<Vec<AssociationApiItem>>().await.c(h!())?)
}

async fn fetch_goi_knowledge(
    env: &Env,
    organism: &organism::Model,
) -> Result<Vec<KnowledgeApiItem>, AppError> {
    let url = goi_knowledge_url(organism)?;
    let (login, password) = goi_api_credentials(organism)?;

    let response = env
        .rq
        .post(url)
        .basic_auth(login, Some(password))
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;
    Ok(response.json::<Vec<KnowledgeApiItem>>().await.c(h!())?)
}

async fn push_goi_report_if_due(
    env: &Env,
    organism: &organism::Model,
    state: &mut GoiWorkerState,
) -> Result<(), AppError> {
    if !goi_report_push_is_due(state, organism.id) {
        return Ok(());
    }

    state
        .last_report_push_attempt_at
        .insert(organism.id, Instant::now());

    let report_xlsx =
        crate::sigint::network::goi::report_xlsx_networks_goi_to_buffer(env)
            .await
            .c(h!())?;
    let response = post_goi_report(env, organism, report_xlsx).await.c(h!())?;
    log::info!(
        "Pushed GOI signed frequencies report for {} to {} ({} bytes)",
        organism.name,
        response.path,
        response.bytes_written
    );
    Ok(())
}

fn goi_report_push_is_due(state: &GoiWorkerState, organism_id: i64) -> bool {
    match state.last_report_push_attempt_at.get(&organism_id) {
        None => true,
        Some(last_attempt) => {
            last_attempt.elapsed() >= goi_report_push_interval()
        }
    }
}

fn goi_knowledge_sync_is_due(state: &GoiWorkerState, organism_id: i64) -> bool {
    match state.last_knowledge_sync_attempt_at.get(&organism_id) {
        None => true,
        Some(last_attempt) => {
            last_attempt.elapsed() >= goi_knowledge_sync_interval()
        }
    }
}

async fn post_goi_report(
    env: &Env,
    organism: &organism::Model,
    report_xlsx: Vec<u8>,
) -> Result<ImportSignedFrequenciesRsp, AppError> {
    let url = goi_api_url(organism, GOI_FREQUENCIES_IMPORT_PATH)?;
    let (login, password) = goi_api_credentials(organism)?;
    let response = env
        .rq
        .post(url)
        .basic_auth(login, Some(password))
        .header(reqwest::header::CONTENT_TYPE, GOI_XLSX_CONTENT_TYPE)
        .body(report_xlsx)
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;
    Ok(response
        .json::<ImportSignedFrequenciesRsp>()
        .await
        .c(h!())?)
}

fn goi_associations_url(
    organism: &organism::Model,
) -> Result<String, AppError> {
    goi_api_url(organism, "/api/associations")
}

fn goi_knowledge_url(organism: &organism::Model) -> Result<String, AppError> {
    goi_api_url(organism, "/api/knowledge")
}

fn goi_api_url(
    organism: &organism::Model,
    path: &str,
) -> Result<String, AppError> {
    let host = goi_api_host(organism).ok_or_else(|| AppError::BL {
        msg: format!("GOI API host is missing for organism {}", organism.id),
    })?;
    let port = goi_api_port(organism);
    let mut url = if host.starts_with("http://") || host.starts_with("https://")
    {
        Url::parse(&host).c(h!())?
    } else {
        Url::parse(&format!("http://{host}")).c(h!())?
    };
    if url.port().is_none() {
        url.set_port(Some(port as u16)).map_err(|_| AppError::BL {
            msg: format!("invalid GOI API port: {port}"),
        })?;
    }
    url.set_path(path);
    url.set_query(None);
    Ok(url.to_string())
}

fn goi_api_credentials(
    organism: &organism::Model,
) -> Result<(String, String), AppError> {
    let login = normalize_optional_trimmed(organism.goi_api_login.clone())
        .ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI API login is missing for organism {}",
                organism.id
            ),
        })?;
    let password =
        normalize_optional_trimmed(organism.goi_api_password.clone())
            .ok_or_else(|| AppError::BL {
                msg: format!(
                    "GOI API password is missing for organism {}",
                    organism.id
                ),
            })?;
    Ok((login, password))
}
async fn insert_goi_associations(
    db: &DatabaseConnection,
    organism_id: i64,
    items: Vec<AssociationApiItem>,
) -> Result<(), AppError> {
    let associations = items
        .into_iter()
        .map(|item| goi_association_active_model(organism_id, item))
        .collect::<Result<Vec<_>, _>>()?;
    if associations.is_empty() {
        return Ok(());
    }

    goi_association::Entity::insert_many(associations)
        .on_conflict(
            OnConflict::columns([
                goi_association::Column::OrganismId,
                goi_association::Column::SourceAssociationId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn upsert_goi_knowledge_snapshot(
    db: &DatabaseConnection,
    organism_id: i64,
    items: Vec<KnowledgeApiItem>,
) -> Result<(), AppError> {
    let source_ids = items.iter().map(|item| item.id).collect::<Vec<_>>();
    let tx = db.begin().await.c(h!())?;
    mark_missing_goi_knowledge_deleted(&tx, organism_id, &source_ids)
        .await
        .c(h!())?;

    let knowledge_items = items
        .into_iter()
        .map(|item| goi_knowledge_active_model(organism_id, item))
        .collect::<Result<Vec<_>, _>>()?;
    if knowledge_items.is_empty() {
        tx.commit().await.c(h!())?;
        return Ok(());
    }

    goi_knowledge::Entity::insert_many(knowledge_items)
        .on_conflict(
            OnConflict::columns([
                goi_knowledge::Column::OrganismId,
                goi_knowledge::Column::SourceKnowledgeId,
            ])
            .update_columns([
                goi_knowledge::Column::SourceCreatedAt,
                goi_knowledge::Column::Row,
                goi_knowledge::Column::Deleted,
                goi_knowledge::Column::DeletedAt,
                goi_knowledge::Column::Name,
                goi_knowledge::Column::Key,
                goi_knowledge::Column::KnowledgeType,
                goi_knowledge::Column::Author,
                goi_knowledge::Column::Note,
                goi_knowledge::Column::SourceDateRaw,
                goi_knowledge::Column::SourceDate,
                goi_knowledge::Column::Formation,
            ])
            .to_owned(),
        )
        .exec(&tx)
        .await
        .c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(())
}

async fn mark_missing_goi_knowledge_deleted(
    db: &DatabaseTransaction,
    organism_id: i64,
    source_ids: &[i64],
) -> Result<(), AppError> {
    let mut query = goi_knowledge::Entity::update_many()
        .col_expr(goi_knowledge::Column::Deleted, Expr::value(true))
        .col_expr(
            goi_knowledge::Column::DeletedAt,
            Expr::value(chrono::Utc::now().fixed_offset()),
        )
        .filter(goi_knowledge::Column::OrganismId.eq(organism_id))
        .filter(goi_knowledge::Column::Deleted.eq(false));
    if !source_ids.is_empty() {
        query = query.filter(
            goi_knowledge::Column::SourceKnowledgeId
                .is_not_in(source_ids.iter().copied()),
        );
    }
    query.exec(db).await.c(h!())?;
    Ok(())
}

async fn prune_old_deleted_goi_knowledge(
    db: &DatabaseConnection,
    organism_id: i64,
) -> Result<(), AppError> {
    let cutoff = goi_knowledge_sync_cutoff();
    goi_knowledge::Entity::delete_many()
        .filter(goi_knowledge::Column::OrganismId.eq(organism_id))
        .filter(goi_knowledge::Column::Deleted.eq(true))
        .filter(goi_knowledge::Column::DeletedAt.is_not_null())
        .filter(goi_knowledge::Column::DeletedAt.lt(cutoff))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

fn goi_association_active_model(
    organism_id: i64,
    item: AssociationApiItem,
) -> Result<goi_association::ActiveModel, AppError> {
    let row_json = serde_json::to_value(&item.row).c(h!())?;
    let source_created_at = item.created_at.fixed_offset();
    let source_created_at_ms = item.created_at.timestamp_millis();
    let source_date = item.row.source_date().map(|date| date.fixed_offset());
    let goi_echo_worker::row::AssociationRow {
        sheet_name: _,
        row_num: _,
        cells: _,
        association_type,
        frequency,
        coordinates,
        note,
        category,
        call_signs,
        formation,
        association_count,
        sidc,
        author,
        source_date_raw,
        palettes,
    } = item.row;
    let call_signs = serde_json::to_value(call_signs).c(h!())?;
    Ok(goi_association::ActiveModel {
        id: NotSet,
        organism_id: Set(organism_id),
        source_association_id: Set(item.id),
        source_created_at: Set(source_created_at),
        row: Set(row_json),
        created_at: NotSet,
        deleted: Set(item.deleted),
        association_type: Set(association_type),
        frequency: Set(frequency),
        coordinates: Set(coordinates),
        note: Set(note),
        category: Set(category),
        call_signs: Set(call_signs),
        formation: Set(formation),
        association_count: Set(association_count),
        sidc: Set(sidc),
        author: Set(author),
        source_date_raw: Set(source_date_raw),
        source_date: Set(source_date),
        source_created_at_ms: Set(Some(source_created_at_ms)),
        palettes: Set(palettes),
    })
}

fn goi_knowledge_active_model(
    organism_id: i64,
    item: KnowledgeApiItem,
) -> Result<goi_knowledge::ActiveModel, AppError> {
    let row_json = serde_json::to_value(&item.row).c(h!())?;
    let source_created_at = item.created_at.fixed_offset();
    let source_date = item.row.source_date().map(|date| date.fixed_offset());
    let goi_echo_worker::knowledge::KnowledgeRow {
        sheet_name: _,
        row_num: _,
        cells: _,
        name,
        key,
        knowledge_type,
        author,
        note,
        source_date_raw,
        formation,
    } = item.row;
    Ok(goi_knowledge::ActiveModel {
        id: NotSet,
        organism_id: Set(organism_id),
        source_knowledge_id: Set(item.id),
        source_created_at: Set(source_created_at),
        row: Set(row_json),
        created_at: NotSet,
        deleted: Set(item.deleted),
        deleted_at: Set(item.deleted.then_some(source_created_at)),
        name: Set(name),
        key: Set(key),
        knowledge_type: Set(knowledge_type),
        author: Set(author),
        note: Set(note),
        source_date_raw: Set(source_date_raw),
        source_date: Set(source_date),
        formation: Set(formation),
    })
}

fn goi_worker_sleep_duration() -> Duration {
    Duration::from_millis(ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS)
}

fn goi_report_push_interval() -> Duration {
    Duration::from_secs(ORGANISM_GOI_REPORT_PUSH_INTERVAL_SEC)
}

fn goi_knowledge_sync_interval() -> Duration {
    Duration::from_secs(ORGANISM_GOI_KNOWLEDGE_SYNC_INTERVAL_SEC)
}

fn goi_knowledge_sync_cutoff() -> chrono::DateTime<chrono::FixedOffset> {
    (chrono::Utc::now()
        - chrono::Duration::days(ORGANISM_GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS))
    .fixed_offset()
}

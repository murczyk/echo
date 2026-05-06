use crate::config::{
    ORGANISM_GOI_API_TIMEOUT_SEC, ORGANISM_GOI_ASSOCIATIONS_INSERT_BATCH_SIZE,
    ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS,
    ORGANISM_GOI_INTEGRATION_TYPE_FULL,
    ORGANISM_GOI_KNOWLEDGE_SYNC_INTERVAL_SEC,
    ORGANISM_GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS,
    ORGANISM_GOI_PALITRA_FOLDER_SYNC_INTERVAL_SEC,
    ORGANISM_GOI_REPORT_PUSH_INTERVAL_SEC,
};
use crate::entities::{goi_association, goi_integration, goi_knowledge};
use crate::error::AppError;
use crate::organism::goi::shared::{
    goi_integration_api_host, goi_integration_api_port,
    goi_integration_has_api_config,
};
use crate::types::*;
use crate::utils::string::normalize_optional_trimmed;
use bytes::BytesMut;
use futures_util::StreamExt;
use goi_echo_worker::api::{
    AssociationApiItem, ImportSignedFrequenciesRsp, KnowledgeApiItem,
    ListAssociationsReq,
};
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use sea_query::Expr;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::task::JoinSet;
use url::Url;

const GOI_FREQUENCIES_IMPORT_PATH: &str = "/api/frequencies/signed/import";
const GOI_XLSX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

#[derive(Default)]
struct GoiWorkerState {
    last_knowledge_sync_attempt_at: HashMap<i64, Instant>,
    last_report_push_attempt_at: HashMap<i64, Instant>,
    last_palitra_folder_sync_attempt_at: HashMap<i64, Instant>,
}

struct GoiApiJob {
    integration: goi_integration::Model,
    sync_knowledge: bool,
    push_report: bool,
}

pub async fn goi_association_worker_nofail(env: Arc<Env>) {
    goi_worker_nofail(env, true).await;
}

pub async fn goi_folder_sync_worker_nofail(env: Arc<Env>) {
    goi_worker_nofail(env, false).await;
}

async fn goi_worker_nofail(env: Arc<Env>, with_api_jobs: bool) {
    let mut state = GoiWorkerState::default();
    loop {
        if let Err(err) =
            goi_association_worker_step(&env, &mut state, with_api_jobs).await
        {
            log::warn!("GOI association worker step failed: {err:#?}");
            tokio::time::sleep(goi_worker_sleep_duration()).await;
        }
    }
}

async fn goi_association_worker_step(
    env: &Arc<Env>,
    state: &mut GoiWorkerState,
    with_api_jobs: bool,
) -> Result<(), AppError> {
    let integrations =
        load_goi_worker_integrations(&env.as_ref().dbx, with_api_jobs)
            .await
            .c(h!())?;

    if with_api_jobs {
        run_goi_api_jobs(env, state, integrations).await;
    } else {
        run_goi_folder_sync_jobs(env.as_ref(), state, integrations).await;
    }

    log::debug!("[goi_association_worker] synced integrations successfully");
    tokio::time::sleep(goi_worker_sleep_duration()).await;
    Ok(())
}

async fn run_goi_api_jobs(
    env: &Arc<Env>,
    state: &mut GoiWorkerState,
    integrations: Vec<goi_integration::Model>,
) {
    let mut job_set = JoinSet::new();
    for integration in integrations {
        if !goi_integration_has_api_config(&integration) {
            continue;
        }
        let job = plan_goi_api_job(state, integration);
        let env = env.clone();
        job_set.spawn(async move {
            run_goi_api_job(env, job).await;
        });
        tokio::time::sleep(goi_worker_sleep_duration()).await;
    }
    while let Some(job_result) = job_set.join_next().await {
        if let Err(err) = job_result {
            log::warn!("GOI API job join failed: {err:#?}");
        }
    }
}

async fn run_goi_folder_sync_jobs(
    env: &Env,
    state: &mut GoiWorkerState,
    integrations: Vec<goi_integration::Model>,
) {
    for integration in integrations {
        if let Err(err) =
            sync_goi_palitra_folders_if_due(env, &integration, state).await
        {
            let label = integration.server_label.clone();
            log::warn!(
                "[goi-sync] Skipping GOI palitra folder sync for {label}: {err:#?}"
            );
        }
        tokio::time::sleep(goi_worker_sleep_duration()).await;
    }
}

fn plan_goi_api_job(
    state: &mut GoiWorkerState,
    integration: goi_integration::Model,
) -> GoiApiJob {
    let sync_knowledge = goi_knowledge_sync_is_due(state, integration.id);
    if sync_knowledge {
        state
            .last_knowledge_sync_attempt_at
            .insert(integration.id, Instant::now());
    }

    let push_report = goi_report_push_is_due(state, integration.id);
    if push_report {
        state
            .last_report_push_attempt_at
            .insert(integration.id, Instant::now());
    }

    GoiApiJob {
        integration,
        sync_knowledge,
        push_report,
    }
}

async fn run_goi_api_job(env: Arc<Env>, job: GoiApiJob) {
    if let Err(err) =
        sync_goi_associations(env.as_ref(), &job.integration).await
    {
        let label = job.integration.server_label.clone();
        log::warn!(
            "[goi_association_worker] Skipping GOI association sync for {label}: {err:#?}"
        );
    }
    if job.sync_knowledge {
        if let Err(err) =
            sync_goi_knowledge(env.as_ref(), &job.integration).await
        {
            let label = job.integration.server_label.clone();
            log::warn!("[goi_association_worker] Skipping GOI knowledge sync for {label}: {err:#?}");
        }
    }
    if job.push_report {
        match push_goi_report(env.as_ref(), &job.integration).await {
            Ok(response) => {
                log::info!(
                    "Pushed GOI signed frequencies report for {} to {} ({} bytes)",
                    job.integration.server_label,
                    response.path,
                    response.bytes_written
                );
            }
            Err(err) => {
                let label = job.integration.server_label.clone();
                log::warn!("Skipping GOI report push for {label}: {err:#?}");
            }
        }
    }
}

async fn sync_goi_palitra_folders_if_due(
    env: &Env,
    integration: &goi_integration::Model,
    state: &mut GoiWorkerState,
) -> Result<(), AppError> {
    if !goi_palitra_folder_sync_is_due(state, integration.id) {
        return Ok(());
    }
    state
        .last_palitra_folder_sync_attempt_at
        .insert(integration.id, Instant::now());
    crate::organism::goi::callsigns_sync::sync_goi_callsigns_knowledge(
        env,
        integration,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn load_goi_worker_integrations(
    db: &DatabaseConnection,
    with_api_jobs: bool,
) -> Result<Vec<goi_integration::Model>, AppError> {
    let is_full_integration = Condition::all().add(
        goi_integration::Column::IntegrationType
            .eq(ORGANISM_GOI_INTEGRATION_TYPE_FULL),
    );
    let has_api_host = Condition::all()
        .add(goi_integration::Column::ApiHost.is_not_null())
        .add(goi_integration::Column::ApiHost.ne(""));
    let has_ssh_host = Condition::all()
        .add(goi_integration::Column::SshHost.is_not_null())
        .add(goi_integration::Column::SshHost.ne(""));
    let has_ssh_user = Condition::all()
        .add(goi_integration::Column::SshUser.is_not_null())
        .add(goi_integration::Column::SshUser.ne(""));
    let has_host_for_api =
        Condition::any().add(has_api_host).add(has_ssh_host.clone());
    let has_api_login = Condition::all()
        .add(goi_integration::Column::ApiLogin.is_not_null())
        .add(goi_integration::Column::ApiLogin.ne(""));
    let has_api_password = Condition::all()
        .add(goi_integration::Column::ApiPassword.is_not_null())
        .add(goi_integration::Column::ApiPassword.ne(""));
    let filter = if with_api_jobs {
        Condition::all()
            .add(is_full_integration)
            .add(has_host_for_api)
            .add(has_api_login)
            .add(has_api_password)
    } else {
        Condition::all()
            .add(is_full_integration)
            .add(has_ssh_host)
            .add(has_ssh_user)
    };
    Ok(goi_integration::Entity::find()
        .filter(filter)
        .all(db)
        .await
        .c(h!())?)
}

async fn sync_goi_associations(
    env: &Env,
    integration: &goi_integration::Model,
) -> Result<(), AppError> {
    let since_id = last_source_association_id(&env.dbx, integration.id)
        .await
        .c(h!())?;
    stream_goi_associations_into_db(env, integration, since_id)
        .await
        .c(h!())?;
    Ok(())
}

async fn sync_goi_knowledge(
    env: &Env,
    integration: &goi_integration::Model,
) -> Result<(), AppError> {
    prune_old_deleted_goi_knowledge(&env.dbx, integration.id)
        .await
        .c(h!())?;
    let items = fetch_goi_knowledge(env, integration).await.c(h!())?;
    upsert_goi_knowledge_snapshot(
        &env.dbx,
        integration.id,
        integration.owner_organism_id,
        items,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn last_source_association_id(
    db: &DatabaseConnection,
    integration_id: i64,
) -> Result<Option<i64>, AppError> {
    Ok(goi_association::Entity::find()
        .filter(goi_association::Column::IntegrationId.eq(integration_id))
        .order_by_desc(goi_association::Column::SourceAssociationId)
        .one(db)
        .await
        .c(h!())?
        .map(|association| association.source_association_id))
}

async fn stream_goi_associations_into_db(
    env: &Env,
    integration: &goi_integration::Model,
    since_id: Option<i64>,
) -> Result<(), AppError> {
    let url = goi_associations_url(integration)?;
    let (login, password) = goi_api_credentials(integration)?;

    let response = env
        .rq_goi_associations
        .post(url)
        .header(reqwest::header::ACCEPT, "application/x-ndjson")
        .basic_auth(login, Some(password))
        .json(&ListAssociationsReq {
            since_id_nonincl: since_id,
        })
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;

    if !goi_associations_response_is_ndjson(&response) {
        let items = response.json::<Vec<AssociationApiItem>>().await.c(h!())?;
        if items.is_empty() {
            return Ok(());
        }
        insert_goi_associations(
            &env.dbx,
            integration.id,
            integration.owner_organism_id,
            items,
        )
        .await
        .c(h!())?;
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut line_buf = BytesMut::new();
    let mut items_batch =
        Vec::with_capacity(ORGANISM_GOI_ASSOCIATIONS_INSERT_BATCH_SIZE);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.c(h!())?;
        line_buf.extend_from_slice(&chunk);
        while let Some(newline_pos) = line_buf.iter().position(|&b| b == b'\n')
        {
            let line = line_buf.split_to(newline_pos + 1);
            let line = &line[..line.len() - 1];
            if line.is_empty() {
                continue;
            }
            items_batch.push(serde_json::from_slice(line).c(h!())?);
            if items_batch.len() >= ORGANISM_GOI_ASSOCIATIONS_INSERT_BATCH_SIZE
            {
                insert_goi_associations(
                    &env.dbx,
                    integration.id,
                    integration.owner_organism_id,
                    std::mem::take(&mut items_batch),
                )
                .await
                .c(h!())?;
            }
        }
    }

    if !line_buf.is_empty() {
        items_batch.push(serde_json::from_slice(&line_buf).c(h!())?);
    }
    if items_batch.is_empty() {
        return Ok(());
    }
    insert_goi_associations(
        &env.dbx,
        integration.id,
        integration.owner_organism_id,
        items_batch,
    )
    .await
    .c(h!())?;
    Ok(())
}

fn goi_associations_response_is_ndjson(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("application/x-ndjson"))
        .unwrap_or(false)
}

async fn fetch_goi_knowledge(
    env: &Env,
    integration: &goi_integration::Model,
) -> Result<Vec<KnowledgeApiItem>, AppError> {
    let url = goi_knowledge_url(integration)?;
    let (login, password) = goi_api_credentials(integration)?;

    let response = env
        .rq
        .post(url)
        .timeout(goi_api_timeout())
        .basic_auth(login, Some(password))
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;
    Ok(response.json::<Vec<KnowledgeApiItem>>().await.c(h!())?)
}

async fn push_goi_report(
    env: &Env,
    integration: &goi_integration::Model,
) -> Result<ImportSignedFrequenciesRsp, AppError> {
    let report_xlsx =
        crate::sigint::network::goi::report_xlsx_networks_goi_to_buffer(env)
            .await
            .c(h!())?;
    Ok(post_goi_report(env, integration, report_xlsx)
        .await
        .c(h!())?)
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

fn goi_palitra_folder_sync_is_due(
    state: &GoiWorkerState,
    organism_id: i64,
) -> bool {
    match state.last_palitra_folder_sync_attempt_at.get(&organism_id) {
        None => true,
        Some(last_attempt) => {
            last_attempt.elapsed() >= goi_palitra_folder_sync_interval()
        }
    }
}

async fn post_goi_report(
    env: &Env,
    integration: &goi_integration::Model,
    report_xlsx: Vec<u8>,
) -> Result<ImportSignedFrequenciesRsp, AppError> {
    let url = goi_api_url(integration, GOI_FREQUENCIES_IMPORT_PATH)?;
    let (login, password) = goi_api_credentials(integration)?;
    let response = env
        .rq
        .post(url)
        .timeout(goi_api_timeout())
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
    integration: &goi_integration::Model,
) -> Result<String, AppError> {
    goi_api_url(integration, "/api/associations")
}

fn goi_knowledge_url(
    integration: &goi_integration::Model,
) -> Result<String, AppError> {
    goi_api_url(integration, "/api/knowledge")
}

fn goi_api_url(
    integration: &goi_integration::Model,
    path: &str,
) -> Result<String, AppError> {
    let host =
        goi_integration_api_host(integration).ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI API host is missing for integration {}",
                integration.id
            ),
        })?;
    let port = goi_integration_api_port(integration);
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
    integration: &goi_integration::Model,
) -> Result<(String, String), AppError> {
    let login = normalize_optional_trimmed(integration.api_login.clone())
        .ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI API login is missing for integration {}",
                integration.id
            ),
        })?;
    let password = normalize_optional_trimmed(integration.api_password.clone())
        .ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI API password is missing for integration {}",
                integration.id
            ),
        })?;
    Ok((login, password))
}

fn goi_api_timeout() -> Duration {
    Duration::from_secs(ORGANISM_GOI_API_TIMEOUT_SEC)
}
async fn insert_goi_associations(
    db: &DatabaseConnection,
    integration_id: i64,
    organism_id: i64,
    items: Vec<AssociationApiItem>,
) -> Result<(), AppError> {
    let associations = items
        .into_iter()
        .map(|item| {
            goi_association_active_model(integration_id, organism_id, item)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if associations.is_empty() {
        return Ok(());
    }

    goi_association::Entity::insert_many(associations)
        .on_conflict(
            OnConflict::columns([
                goi_association::Column::IntegrationId,
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
    integration_id: i64,
    organism_id: i64,
    items: Vec<KnowledgeApiItem>,
) -> Result<(), AppError> {
    let source_ids = items.iter().map(|item| item.id).collect::<Vec<_>>();
    let tx = db.begin().await.c(h!())?;
    mark_missing_goi_knowledge_deleted(&tx, integration_id, &source_ids)
        .await
        .c(h!())?;

    let knowledge_items = items
        .into_iter()
        .map(|item| {
            goi_knowledge_active_model(integration_id, organism_id, item)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if knowledge_items.is_empty() {
        tx.commit().await.c(h!())?;
        return Ok(());
    }

    goi_knowledge::Entity::insert_many(knowledge_items)
        .on_conflict(
            OnConflict::columns([
                goi_knowledge::Column::IntegrationId,
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
    integration_id: i64,
    source_ids: &[i64],
) -> Result<(), AppError> {
    let mut query = goi_knowledge::Entity::update_many()
        .col_expr(goi_knowledge::Column::Deleted, Expr::value(true))
        .col_expr(
            goi_knowledge::Column::DeletedAt,
            Expr::value(chrono::Utc::now().fixed_offset()),
        )
        .filter(goi_knowledge::Column::IntegrationId.eq(integration_id))
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
    integration_id: i64,
) -> Result<(), AppError> {
    let cutoff = goi_knowledge_sync_cutoff();
    goi_knowledge::Entity::delete_many()
        .filter(goi_knowledge::Column::IntegrationId.eq(integration_id))
        .filter(goi_knowledge::Column::Deleted.eq(true))
        .filter(goi_knowledge::Column::DeletedAt.is_not_null())
        .filter(goi_knowledge::Column::DeletedAt.lt(cutoff))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

fn goi_association_active_model(
    integration_id: i64,
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
        integration_id: Set(integration_id),
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
    integration_id: i64,
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
        integration_id: Set(integration_id),
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

fn goi_palitra_folder_sync_interval() -> Duration {
    Duration::from_secs(ORGANISM_GOI_PALITRA_FOLDER_SYNC_INTERVAL_SEC)
}

fn goi_knowledge_sync_cutoff() -> chrono::DateTime<chrono::FixedOffset> {
    (chrono::Utc::now()
        - chrono::Duration::days(ORGANISM_GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS))
    .fixed_offset()
}

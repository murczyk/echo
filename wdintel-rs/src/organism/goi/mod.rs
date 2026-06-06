use crate::config::{
    ORGANISM_GOI_API_PORT_DEFAULT,
    ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_DEFAULT,
    ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_MAX, ORGANISM_GOI_FILE_LIST_LIMIT,
    ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_DEFAULT,
    ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_MAX, ORGANISM_GOI_PATH_DEFAULT,
    ORGANISM_GOI_SSH_PORT_DEFAULT, ORGANISM_GOI_SSH_SETUP_TIMEOUT_MS,
    ORGANISM_GOI_SSH_TIMEOUT_MS,
};
use crate::entities::{goi_association, goi_knowledge, login, organism};
use crate::error::AppError;
use crate::organism::goi::shared::{
    goi_integration_type, goi_integration_type_db_value, goi_web_host,
    organism_has_goi_api_config,
};
use crate::organism::goi::types::{
    GoiAssociation, GoiKnowledge, ListGoiAssociationsReq,
    ListGoiAssociationsRsp, ListGoiAssociationsSortBy, ListGoiKnowledgeReq,
    ListGoiKnowledgeRsp, ListGoiKnowledgeSortBy,
};
use crate::organism::types::{
    CheckOrganismGoiConnectionReq, CheckOrganismGoiConnectionRsp,
    GoiIntegrationType, OrganismGoiSettings, SetupOrganismGoiWorkerReq,
    UpdateOrganismGoiSettingsReq,
};
use crate::types::*;
use crate::utils::string::{
    normalize_optional_trimmed, normalize_trimmed_or_default,
};
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;
use sea_query::{extension::postgres::PgExpr, Expr};
use serde::{Deserialize, Serialize};

mod callsigns_sync;
mod goi_ssh;
pub mod integrations;
pub mod shared;
pub mod types;
pub mod worker;

struct GoiSettingsInput {
    integration_type: GoiIntegrationType,
    ssh_host: Option<String>,
    ssh_user: Option<String>,
    ssh_port: i32,
    path: String,
    api_host: Option<String>,
    api_port: i32,
    api_login: Option<String>,
    api_password: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum RestartCurrentUserGoiService {
    Swapp,
    SwappAlt,
    Goi,
    EchoSwapp,
}

#[derive(Debug, Deserialize, PartialEq, Clone)]
pub struct RestartCurrentUserGoiServiceReq {
    pub service: RestartCurrentUserGoiService,
}

#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct CurrentUserGoiControlState {
    pub can_restart: bool,
    pub restart_unavailable_reason: Option<String>,
}

#[post("/api/organism/goi-settings")]
pub async fn organism_goi_settings(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let organism = organism::Entity::find_by_id(req.into_inner())
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    Ok(Json(goi_settings_from_organism(&organism)))
}

#[post("/api/organism/goi-settings/update")]
pub async fn update_organism_goi_settings(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismGoiSettingsReq>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    goi_validate_settings_req(&req)?;

    let organism = goi_find_organism(&env.dbx, req.organism_id).await?;
    let settings = GoiSettingsInput {
        integration_type: req.integration_type,
        ssh_host: normalize_optional_trimmed(req.ssh_host),
        ssh_user: normalize_optional_trimmed(req.ssh_user),
        ssh_port: req.ssh_port,
        path: normalize_trimmed_or_default(req.path, ORGANISM_GOI_PATH_DEFAULT),
        api_host: normalize_optional_trimmed(req.api_host),
        api_port: req.api_port,
        api_login: normalize_optional_trimmed(req.api_login),
        api_password: normalize_optional_trimmed(req.api_password),
    };
    let organism = goi_store_settings(&env.dbx, organism, settings).await?;

    Ok(Json(goi_settings_from_organism(&organism)))
}

#[post("/api/organism/goi-settings/setup-worker")]
pub async fn setup_organism_goi_worker(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SetupOrganismGoiWorkerReq>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    goi_validate_setup_worker_req(&req)?;

    let organism = goi_find_organism(&env.dbx, req.organism_id).await?;
    let pg_password = goi_generate_worker_secret();
    let api_password = goi_generate_worker_secret();
    let ssh_req = CheckOrganismGoiConnectionReq {
        ssh_host: req.ssh_host.clone(),
        ssh_user: req.ssh_user.clone(),
        ssh_port: req.ssh_port,
        path: req.path.clone(),
    };
    let setup_command =
        goi_build_setup_worker_command(&pg_password, &api_password);

    goi_run_setup_worker(ssh_req, setup_command).await?;

    let settings = GoiSettingsInput {
        integration_type: GoiIntegrationType::Full,
        ssh_host: Some(req.ssh_host.trim().to_string()),
        ssh_user: Some(req.ssh_user.trim().to_string()),
        ssh_port: req.ssh_port,
        path: normalize_trimmed_or_default(req.path, ORGANISM_GOI_PATH_DEFAULT),
        api_host: normalize_optional_trimmed(req.api_host),
        api_port: req.api_port,
        api_login: Some("goi".to_string()),
        api_password: Some(api_password),
    };
    let organism = goi_store_settings(&env.dbx, organism, settings).await?;

    Ok(Json(goi_settings_from_organism(&organism)))
}

#[post("/api/organism/goi-settings/check-connection")]
pub async fn check_organism_goi_connection(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CheckOrganismGoiConnectionReq>,
) -> Result<Json<CheckOrganismGoiConnectionRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    let (listed_entries, error) = match goi_validate_connection_req(&req) {
        Ok(()) => {
            match tokio::task::spawn_blocking(move || {
                goi_ssh::goi_check_connection_sync(req)
            })
            .await
            {
                Ok(Ok(listed_entries)) => (listed_entries, None),
                Ok(Err(err)) => {
                    (Vec::new(), Some(format!("GOI SSH check failed: {err}")))
                }
                Err(err) => {
                    (Vec::new(), Some(format!("GOI SSH check failed: {err}")))
                }
            }
        }
        Err(err) => (Vec::new(), Some(format!("GOI SSH check failed: {err}"))),
    };

    Ok(Json(CheckOrganismGoiConnectionRsp {
        ok: error.is_none(),
        listed_entries,
        error,
    }))
}

#[post("/api/organism/goi-associations")]
pub async fn list_current_user_goi_associations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListGoiAssociationsReq>,
) -> Result<Json<ListGoiAssociationsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let login = goi_associations_current_login(&env.dbx, &user_id)
        .await
        .c(h!())?;
    let organism_id = login.organism_id.ok_or_else(|| AppError::BL {
        msg: "Для користувача не налаштовано організм".to_string(),
    })?;
    let organism = goi_find_organism(&env.dbx, organism_id).await.c(h!())?;
    if !organism_has_goi_api_config(&organism) {
        return Err(AppError::BL {
            msg: "Для вашого організму інтеграцію ГОІ ще не налаштовано"
                .to_string(),
        });
    }

    let req = req.into_inner();
    let page_limit = goi_associations_page_limit(req.limit);
    let page_offset = req.offset.unwrap_or(0);
    let associations = goi_associations_query(organism_id, &req)
        .limit(page_limit + 1)
        .offset(page_offset)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let has_more = associations.len() as u64 > page_limit;
    let items = associations
        .into_iter()
        .take(page_limit as usize)
        .map(goi_association_from_model)
        .collect();

    Ok(Json(ListGoiAssociationsRsp { items, has_more }))
}

#[post("/api/organism/goi-knowledge")]
pub async fn list_current_user_goi_knowledge(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListGoiKnowledgeReq>,
) -> Result<Json<ListGoiKnowledgeRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let login = goi_associations_current_login(&env.dbx, &user_id)
        .await
        .c(h!())?;
    let organism_id = login.organism_id.ok_or_else(|| AppError::BL {
        msg: "Для користувача не налаштовано організм".to_string(),
    })?;
    let organism = goi_find_organism(&env.dbx, organism_id).await.c(h!())?;
    if !organism_has_goi_api_config(&organism) {
        return Err(AppError::BL {
            msg: "Для вашого організму інтеграцію ГОІ ще не налаштовано"
                .to_string(),
        });
    }

    let req = req.into_inner();
    let page_limit = goi_knowledge_page_limit(req.limit);
    let page_offset = req.offset.unwrap_or(0);
    let knowledge_items = goi_knowledge_query(organism_id, &req)
        .limit(page_limit + 1)
        .offset(page_offset)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let has_more = knowledge_items.len() as u64 > page_limit;
    let items = knowledge_items
        .into_iter()
        .take(page_limit as usize)
        .map(goi_knowledge_from_model)
        .collect();

    Ok(Json(ListGoiKnowledgeRsp { items, has_more }))
}

#[post("/api/organism/goi-settings/restart-service")]
pub async fn restart_current_user_goi_service(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RestartCurrentUserGoiServiceReq>,
) -> Result<Json<bool>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let login = goi_associations_current_login(&env.dbx, &user_id)
        .await
        .c(h!())?;
    let organism_id = login.organism_id.ok_or_else(|| AppError::BL {
        msg: "Для користувача не налаштовано організм".to_string(),
    })?;
    let organism = goi_find_organism(&env.dbx, organism_id).await.c(h!())?;
    let ssh_req = goi_connection_req_from_organism(&organism)?;
    let req = req.into_inner();

    goi_run_command(
        ssh_req,
        goi_restart_service_command(&req.service).to_string(),
        goi_restart_service_error_context(&req.service),
    )
    .await?;

    Ok(Json(true))
}

#[post("/api/organism/goi-settings/current-user-control-state")]
pub async fn current_user_goi_control_state(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<CurrentUserGoiControlState>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let login = goi_associations_current_login(&env.dbx, &user_id)
        .await
        .c(h!())?;
    let Some(organism_id) = login.organism_id else {
        return Ok(Json(CurrentUserGoiControlState {
            can_restart: false,
            restart_unavailable_reason: Some(
                "Для користувача не налаштовано організм".to_string(),
            ),
        }));
    };

    let organism = goi_find_organism(&env.dbx, organism_id).await.c(h!())?;

    Ok(Json(goi_control_state_from_organism(&organism)))
}

pub async fn goi_upload_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_upload_file_sync(req, remote_file_path, file_data)
    })
    .await
    .c(h!())?
}

pub async fn goi_upload_file_loose(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
    file_data: Vec<u8>,
) {
    let ssh_target = format!("{}:{}", req.ssh_host, req.ssh_port);
    let remote_file_path_for_log = remote_file_path.clone();
    if let Err(err) = goi_upload_file(req, remote_file_path, file_data).await {
        warn!(
            "Skipping GOI file upload for {ssh_target} {remote_file_path_for_log}: {err:#}"
        );
    }
}

pub async fn goi_download_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) -> anyhow::Result<Vec<u8>> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_download_file_sync(req, remote_file_path)
    })
    .await
    .c(h!())?
}

pub async fn goi_delete_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_delete_file_sync(req, remote_file_path)
    })
    .await
    .c(h!())?
}

pub async fn goi_delete_file_loose(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) {
    let ssh_target = format!("{}:{}", req.ssh_host, req.ssh_port);
    let remote_file_path_for_log = remote_file_path.clone();
    if let Err(err) = goi_delete_file(req, remote_file_path).await {
        warn!(
            "Skipping GOI file delete for {ssh_target} {remote_file_path_for_log}: {err:#}"
        );
    }
}

pub async fn goi_list_relative_files(
    req: CheckOrganismGoiConnectionReq,
) -> anyhow::Result<Vec<String>> {
    goi_validate_connection_req(&req)?;
    let command = format!(
        "cd {} && find . -mindepth 1 -type f -print",
        goi_shell_quote_single(req.path.trim())
    );
    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_exec_command_sync_capped_strict(
            req,
            command,
            ORGANISM_GOI_SSH_TIMEOUT_MS,
            ORGANISM_GOI_FILE_LIST_LIMIT,
        )
    })
    .await
    .c(h!())?
}

pub async fn goi_move_file_to_folder(
    req: CheckOrganismGoiConnectionReq,
    source_file_names: Vec<String>,
    target_file_name: String,
    target_folder: Option<String>,
    source_folder_hint: Option<String>,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;
    let mut entries = goi_list_relative_files(req.clone()).await.c(h!())?;
    goi_move_file_to_folder_with_entries(
        req,
        source_file_names,
        target_file_name,
        target_folder,
        source_folder_hint,
        &mut entries,
    )
    .await
}

pub async fn goi_move_file_to_folder_with_entries(
    req: CheckOrganismGoiConnectionReq,
    source_file_names: Vec<String>,
    target_file_name: String,
    target_folder: Option<String>,
    source_folder_hint: Option<String>,
    entries: &mut Vec<String>,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;
    let source_file_names =
        normalize_goi_file_names(source_file_names).c(h!())?;
    let target_file_name = normalize_goi_file_name(target_file_name).c(h!())?;
    let current_rel_path = goi_find_source_relative_path(
        entries.as_slice(),
        source_file_names.as_slice(),
        source_folder_hint.as_deref(),
    )
    .c(h!())?;
    let target_rel_path = goi_build_relative_path_checked(
        target_folder.as_deref(),
        &target_file_name,
    )
    .c(h!())?;
    if current_rel_path == target_rel_path {
        return Ok(());
    }
    if goi_relative_path_exists(entries.as_slice(), &target_rel_path) {
        anyhow::bail!(
            "GOI file move failed: destination file '{target_rel_path}' already exists"
        );
    }

    let target_dir = goi_relative_parent_dir(&target_rel_path);
    let command = format!(
        "cd {} && mkdir -p -- {} && mv -f -- {} {}",
        goi_shell_quote_single(req.path.trim()),
        goi_shell_quote_single(&target_dir),
        goi_shell_quote_single(&current_rel_path),
        goi_shell_quote_single(&target_rel_path),
    );
    goi_run_command(req, command, "GOI file move failed")
        .await
        .c(h!())?;
    goi_replace_cached_relative_path(
        entries,
        &current_rel_path,
        &target_rel_path,
    );
    Ok(())
}

fn goi_replace_cached_relative_path(
    entries: &mut Vec<String>,
    current_rel_path: &str,
    target_rel_path: &str,
) {
    let current_index = entries.iter().position(|entry| {
        goi_parse_relative_file_entry(entry)
            .map(|(folder, file_name)| {
                goi_build_relative_path(folder.as_deref(), &file_name)
            })
            .as_deref()
            == Some(current_rel_path)
    });
    if let Some(index) = current_index {
        entries.remove(index);
    }
    entries.push(format!("./{target_rel_path}"));
}

fn goi_relative_path_exists(entries: &[String], rel_path: &str) -> bool {
    entries.iter().any(|entry| {
        goi_parse_relative_file_entry(entry)
            .map(|(folder, file_name)| {
                goi_build_relative_path(folder.as_deref(), &file_name)
            })
            .as_deref()
            == Some(rel_path)
    })
}

fn goi_find_source_relative_path(
    entries: &[String],
    file_names: &[String],
    source_folder_hint: Option<&str>,
) -> anyhow::Result<String> {
    for file_name in file_names {
        let paths = entries
            .iter()
            .filter_map(|entry| {
                goi_parse_relative_file_entry(entry).and_then(
                    |(entry_folder, entry_file_name)| {
                        (entry_file_name == *file_name).then_some(
                            goi_build_relative_path(
                                entry_folder.as_deref(),
                                &entry_file_name,
                            ),
                        )
                    },
                )
            })
            .collect::<Vec<_>>();
        if let Some(source_folder_hint) = source_folder_hint {
            let source_folder_hint =
                source_folder_hint.trim().trim_matches('/').to_string();
            let source_folder_hint = if source_folder_hint.is_empty() {
                None
            } else {
                Some(source_folder_hint.as_str())
            };
            let hinted_source_rel_path =
                goi_build_relative_path_checked(source_folder_hint, file_name)
                    .c(h!())?;
            if paths.contains(&hinted_source_rel_path) {
                return Ok(hinted_source_rel_path);
            }
        }
        match paths.as_slice() {
            [] => {}
            [single] => return Ok(single.clone()),
            _ => {
                anyhow::bail!(
                    "GOI file move failed: multiple source files named '{file_name}' were found: {:?}",
                    paths
                )
            }
        }
    }
    anyhow::bail!(
        "GOI file move failed: none of the source file names were found: {:?}",
        file_names
    )
}

fn normalize_goi_file_name(file_name: String) -> anyhow::Result<String> {
    let file_name = file_name.trim().trim_start_matches('/').to_string();
    if file_name.is_empty() {
        anyhow::bail!("GOI file move failed: file name is empty");
    }
    Ok(file_name)
}

fn normalize_goi_file_names(
    file_names: Vec<String>,
) -> anyhow::Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(file_names.len());
    for file_name in file_names {
        let file_name = normalize_goi_file_name(file_name).c(h!())?;
        if !normalized.contains(&file_name) {
            normalized.push(file_name);
        }
    }
    if normalized.is_empty() {
        anyhow::bail!("GOI file move failed: source file names are empty");
    }
    Ok(normalized)
}

pub(super) async fn goi_run_command(
    ssh_req: CheckOrganismGoiConnectionReq,
    command: String,
    error_context: &'static str,
) -> Result<(), AppError> {
    match tokio::task::spawn_blocking(move || {
        goi_ssh::goi_exec_command_sync(
            ssh_req,
            command,
            ORGANISM_GOI_SSH_TIMEOUT_MS,
        )
    })
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(err)) => Err(AppError::BL {
            msg: format!("{error_context}: {err:#}"),
        }),
        Err(err) => Err(AppError::BL {
            msg: format!("{error_context}: {err}"),
        }),
    }
}

pub(super) fn goi_parse_relative_file_entry(
    entry: &str,
) -> Option<(Option<String>, String)> {
    let relative = entry.trim().trim_start_matches("./").trim_matches('/');
    if relative.is_empty() {
        return None;
    }
    if let Some((folder, file_name)) = relative.rsplit_once('/') {
        if file_name.trim().is_empty() {
            return None;
        }
        return Some((Some(folder.to_string()), file_name.to_string()));
    }
    Some((None, relative.to_string()))
}

pub(super) fn goi_build_relative_path(
    folder: Option<&str>,
    file_name: &str,
) -> String {
    let file_name = file_name.trim().trim_start_matches('/');
    if let Some(folder) =
        folder.map(str::trim).filter(|folder| !folder.is_empty())
    {
        format!("{folder}/{file_name}")
    } else {
        file_name.to_string()
    }
}

fn goi_build_relative_path_checked(
    folder: Option<&str>,
    file_name: &str,
) -> anyhow::Result<String> {
    if let Some(folder) =
        folder.map(str::trim).filter(|folder| !folder.is_empty())
    {
        goi_validate_relative_folder(folder).c(h!())?;
    }
    Ok(goi_build_relative_path(folder, file_name))
}

fn goi_validate_relative_folder(folder: &str) -> anyhow::Result<()> {
    for segment in folder.split('/') {
        let segment = segment.trim();
        if segment.is_empty() {
            anyhow::bail!("GOI file move failed: folder has empty segments");
        }
        if segment == "." || segment == ".." {
            anyhow::bail!(
                "GOI file move failed: folder may not contain '.' or '..' segments"
            );
        }
    }
    Ok(())
}

fn goi_relative_parent_dir(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .filter(|dir| !dir.trim().is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn goi_shell_quote_single(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}

async fn goi_find_organism(
    dbx: &DatabaseConnection,
    organism_id: i64,
) -> Result<organism::Model, AppError> {
    organism::Entity::find_by_id(organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn goi_associations_current_login(
    dbx: &DatabaseConnection,
    user_id: &str,
) -> Result<login::Model, AppError> {
    login::Entity::find()
        .filter(login::Column::Login.eq(user_id))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)
}

fn goi_associations_page_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_DEFAULT)
        .clamp(1, ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_MAX)
}

fn goi_knowledge_page_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_DEFAULT)
        .clamp(1, ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_MAX)
}

fn goi_associations_query(
    organism_id: i64,
    req: &ListGoiAssociationsReq,
) -> Select<goi_association::Entity> {
    let mut query = goi_association::Entity::find()
        .filter(goi_association::Column::OrganismId.eq(organism_id));

    if let Some(filter_deleted) = req.filter_deleted {
        query =
            query.filter(goi_association::Column::Deleted.eq(filter_deleted));
    }

    if let Some(pattern) =
        goi_associations_filter_pattern(req.filter_text.clone())
    {
        query = query.filter(
            Condition::any()
                .add(
                    Expr::col(goi_association::Column::Frequency)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_association::Column::Coordinates)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_association::Column::Note)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_association::Column::Category)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_association::Column::Formation)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_association::Column::Sidc)
                        .ilike(pattern.clone()),
                )
                .add(Expr::col(goi_association::Column::Author).ilike(pattern)),
        );
    }

    query = goi_associations_filter_optional_text(
        query,
        goi_association::Column::Frequency,
        req.filter_frequency.clone(),
    );
    query = goi_associations_filter_optional_text(
        query,
        goi_association::Column::Coordinates,
        req.filter_coordinates.clone(),
    );
    query = goi_associations_filter_optional_text(
        query,
        goi_association::Column::Note,
        req.filter_note.clone(),
    );
    query = goi_associations_filter_optional_text(
        query,
        goi_association::Column::Category,
        req.filter_category.clone(),
    );
    query = goi_associations_filter_optional_text(
        query,
        goi_association::Column::Author,
        req.filter_author.clone(),
    );

    goi_associations_apply_sort(query, req.sort_by.clone())
}

fn goi_knowledge_query(
    organism_id: i64,
    req: &ListGoiKnowledgeReq,
) -> Select<goi_knowledge::Entity> {
    let mut query = goi_knowledge::Entity::find()
        .filter(goi_knowledge::Column::OrganismId.eq(organism_id));

    if let Some(filter_deleted) = req.filter_deleted {
        query = query.filter(goi_knowledge::Column::Deleted.eq(filter_deleted));
    }

    if let Some(pattern) =
        goi_associations_filter_pattern(req.filter_text.clone())
    {
        query = query.filter(
            Condition::any()
                .add(
                    Expr::col(goi_knowledge::Column::Name)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_knowledge::Column::Key)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_knowledge::Column::KnowledgeType)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_knowledge::Column::Author)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_knowledge::Column::Note)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_knowledge::Column::Formation)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(goi_knowledge::Column::SourceDateRaw)
                        .ilike(pattern),
                ),
        );
    }

    query = goi_knowledge_filter_optional_text(
        query,
        goi_knowledge::Column::Name,
        req.filter_name.clone(),
    );
    query = goi_knowledge_filter_optional_text(
        query,
        goi_knowledge::Column::Key,
        req.filter_key.clone(),
    );
    query = goi_knowledge_filter_optional_text(
        query,
        goi_knowledge::Column::KnowledgeType,
        req.filter_knowledge_type.clone(),
    );
    query = goi_knowledge_filter_optional_text(
        query,
        goi_knowledge::Column::Note,
        req.filter_note.clone(),
    );
    query = goi_knowledge_filter_optional_text(
        query,
        goi_knowledge::Column::Author,
        req.filter_author.clone(),
    );
    query = goi_knowledge_filter_optional_text(
        query,
        goi_knowledge::Column::Formation,
        req.filter_formation.clone(),
    );

    goi_knowledge_apply_sort(query, req.sort_by.clone())
}

fn goi_associations_filter_pattern(raw: Option<String>) -> Option<String> {
    normalize_optional_trimmed(raw).map(|value| format!("%{value}%"))
}

fn goi_associations_filter_optional_text(
    query: Select<goi_association::Entity>,
    column: goi_association::Column,
    value: Option<String>,
) -> Select<goi_association::Entity> {
    if let Some(pattern) = goi_associations_filter_pattern(value) {
        query.filter(Expr::col(column).ilike(pattern))
    } else {
        query
    }
}

fn goi_knowledge_filter_optional_text(
    query: Select<goi_knowledge::Entity>,
    column: goi_knowledge::Column,
    value: Option<String>,
) -> Select<goi_knowledge::Entity> {
    if let Some(pattern) = goi_associations_filter_pattern(value) {
        query.filter(Expr::col(column).ilike(pattern))
    } else {
        query
    }
}

fn goi_associations_apply_sort(
    query: Select<goi_association::Entity>,
    sort_by: Option<ListGoiAssociationsSortBy>,
) -> Select<goi_association::Entity> {
    match sort_by.unwrap_or(
        ListGoiAssociationsSortBy::GoiAssociationSourceAssociationIdDesc,
    ) {
        ListGoiAssociationsSortBy::GoiAssociationSourceAssociationIdDesc => {
            query
                .order_by_desc(goi_association::Column::SourceAssociationId)
                .order_by_desc(goi_association::Column::Id)
        }
        ListGoiAssociationsSortBy::GoiAssociationSourceAssociationIdAsc => {
            query
                .order_by_asc(goi_association::Column::SourceAssociationId)
                .order_by_asc(goi_association::Column::Id)
        }
        ListGoiAssociationsSortBy::GoiAssociationSourceCreatedAtDesc => query
            .order_by_desc(goi_association::Column::SourceCreatedAt)
            .order_by_desc(goi_association::Column::Id),
        ListGoiAssociationsSortBy::GoiAssociationSourceCreatedAtAsc => query
            .order_by_asc(goi_association::Column::SourceCreatedAt)
            .order_by_asc(goi_association::Column::Id),
        ListGoiAssociationsSortBy::GoiAssociationFrequencyAsc => query
            .order_by_asc(goi_association::Column::Frequency)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationFrequencyDesc => query
            .order_by_desc(goi_association::Column::Frequency)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationCoordinatesAsc => query
            .order_by_asc(goi_association::Column::Coordinates)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationCoordinatesDesc => query
            .order_by_desc(goi_association::Column::Coordinates)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationCategoryAsc => query
            .order_by_asc(goi_association::Column::Category)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationCategoryDesc => query
            .order_by_desc(goi_association::Column::Category)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationAuthorAsc => query
            .order_by_asc(goi_association::Column::Author)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationAuthorDesc => query
            .order_by_desc(goi_association::Column::Author)
            .order_by_desc(goi_association::Column::SourceAssociationId),
        ListGoiAssociationsSortBy::GoiAssociationCreatedAtDesc => query
            .order_by_desc(goi_association::Column::CreatedAt)
            .order_by_desc(goi_association::Column::Id),
        ListGoiAssociationsSortBy::GoiAssociationCreatedAtAsc => query
            .order_by_asc(goi_association::Column::CreatedAt)
            .order_by_asc(goi_association::Column::Id),
    }
}

fn goi_knowledge_apply_sort(
    query: Select<goi_knowledge::Entity>,
    sort_by: Option<ListGoiKnowledgeSortBy>,
) -> Select<goi_knowledge::Entity> {
    match sort_by
        .unwrap_or(ListGoiKnowledgeSortBy::GoiKnowledgeSourceKnowledgeIdDesc)
    {
        ListGoiKnowledgeSortBy::GoiKnowledgeSourceKnowledgeIdDesc => query
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId)
            .order_by_desc(goi_knowledge::Column::Id),
        ListGoiKnowledgeSortBy::GoiKnowledgeSourceKnowledgeIdAsc => query
            .order_by_asc(goi_knowledge::Column::SourceKnowledgeId)
            .order_by_asc(goi_knowledge::Column::Id),
        ListGoiKnowledgeSortBy::GoiKnowledgeSourceCreatedAtDesc => query
            .order_by_desc(goi_knowledge::Column::SourceCreatedAt)
            .order_by_desc(goi_knowledge::Column::Id),
        ListGoiKnowledgeSortBy::GoiKnowledgeSourceCreatedAtAsc => query
            .order_by_asc(goi_knowledge::Column::SourceCreatedAt)
            .order_by_asc(goi_knowledge::Column::Id),
        ListGoiKnowledgeSortBy::GoiKnowledgeNameAsc => query
            .order_by_asc(goi_knowledge::Column::Name)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeNameDesc => query
            .order_by_desc(goi_knowledge::Column::Name)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeKeyAsc => query
            .order_by_asc(goi_knowledge::Column::Key)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeKeyDesc => query
            .order_by_desc(goi_knowledge::Column::Key)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeTypeAsc => query
            .order_by_asc(goi_knowledge::Column::KnowledgeType)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeTypeDesc => query
            .order_by_desc(goi_knowledge::Column::KnowledgeType)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeAuthorAsc => query
            .order_by_asc(goi_knowledge::Column::Author)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeAuthorDesc => query
            .order_by_desc(goi_knowledge::Column::Author)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeFormationAsc => query
            .order_by_asc(goi_knowledge::Column::Formation)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeFormationDesc => query
            .order_by_desc(goi_knowledge::Column::Formation)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeNoteAsc => query
            .order_by_asc(goi_knowledge::Column::Note)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeNoteDesc => query
            .order_by_desc(goi_knowledge::Column::Note)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeSourceDateDesc => query
            .order_by_desc(goi_knowledge::Column::SourceDate)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeSourceDateAsc => query
            .order_by_asc(goi_knowledge::Column::SourceDate)
            .order_by_desc(goi_knowledge::Column::SourceKnowledgeId),
        ListGoiKnowledgeSortBy::GoiKnowledgeCreatedAtDesc => query
            .order_by_desc(goi_knowledge::Column::CreatedAt)
            .order_by_desc(goi_knowledge::Column::Id),
        ListGoiKnowledgeSortBy::GoiKnowledgeCreatedAtAsc => query
            .order_by_asc(goi_knowledge::Column::CreatedAt)
            .order_by_asc(goi_knowledge::Column::Id),
    }
}

fn goi_association_from_model(
    association: goi_association::Model,
) -> GoiAssociation {
    GoiAssociation {
        id: association.id,
        integration_id: association.integration_id,
        server_label: String::new(),
        owner_organism_name: String::new(),
        source_association_id: association.source_association_id,
        source_created_at_ms: association.source_created_at.timestamp_millis(),
        created_at_ms: association.created_at.timestamp_millis(),
        deleted: association.deleted,
        association_type: association.association_type,
        frequency: association.frequency,
        coordinates: association.coordinates,
        note: association.note,
        category: association.category,
        call_signs: goi_association_call_signs(association.call_signs),
        formation: association.formation,
        association_count: association.association_count,
        sidc: association.sidc,
        author: association.author,
        source_date_raw: association.source_date_raw,
        source_date_ms: association
            .source_date
            .map(|value| value.timestamp_millis()),
    }
}

fn goi_knowledge_from_model(knowledge: goi_knowledge::Model) -> GoiKnowledge {
    GoiKnowledge {
        id: knowledge.id,
        integration_id: knowledge.integration_id,
        server_label: String::new(),
        owner_organism_name: String::new(),
        source_knowledge_id: knowledge.source_knowledge_id,
        source_created_at_ms: knowledge.source_created_at.timestamp_millis(),
        created_at_ms: knowledge.created_at.timestamp_millis(),
        deleted: knowledge.deleted,
        name: knowledge.name,
        key: knowledge.key,
        knowledge_type: knowledge.knowledge_type,
        author: knowledge.author,
        note: knowledge.note,
        source_date_raw: knowledge.source_date_raw,
        source_date_ms: knowledge
            .source_date
            .map(|value| value.timestamp_millis()),
        formation: knowledge.formation,
    }
}

fn goi_association_call_signs(value: serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(ToOwned::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

pub(super) async fn goi_run_setup_worker(
    ssh_req: CheckOrganismGoiConnectionReq,
    setup_command: String,
) -> Result<(), AppError> {
    match tokio::task::spawn_blocking(move || {
        goi_ssh::goi_exec_command_sync(
            ssh_req,
            setup_command,
            ORGANISM_GOI_SSH_SETUP_TIMEOUT_MS,
        )
    })
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(err)) => Err(AppError::BL {
            msg: format!("GOI worker setup failed: {err:#}"),
        }),
        Err(err) => Err(AppError::BL {
            msg: format!("GOI worker setup failed: {err}"),
        }),
    }
}

async fn goi_store_settings(
    dbx: &DatabaseConnection,
    organism: organism::Model,
    settings: GoiSettingsInput,
) -> Result<organism::Model, AppError> {
    let settings = goi_normalize_settings_input(settings);
    let mut organism: organism::ActiveModel = organism.into();
    organism.goi_integration_type =
        Set(goi_integration_type_db_value(&settings.integration_type)
            .to_string());
    organism.goi_ssh_host = Set(settings.ssh_host);
    organism.goi_ssh_user = Set(settings.ssh_user);
    organism.goi_ssh_port = Set(settings.ssh_port);
    organism.goi_path = Set(settings.path);
    organism.goi_api_host = Set(settings.api_host);
    organism.goi_api_port = Set(settings.api_port);
    organism.goi_api_login = Set(settings.api_login);
    organism.goi_api_password = Set(settings.api_password);
    Ok(organism.update(dbx).await.c(h!())?)
}

fn goi_normalize_settings_input(
    settings: GoiSettingsInput,
) -> GoiSettingsInput {
    if settings.integration_type == GoiIntegrationType::Full {
        return settings;
    }

    GoiSettingsInput {
        integration_type: settings.integration_type,
        ssh_host: None,
        ssh_user: None,
        ssh_port: ORGANISM_GOI_SSH_PORT_DEFAULT,
        path: ORGANISM_GOI_PATH_DEFAULT.to_string(),
        api_host: settings.api_host.or(settings.ssh_host),
        api_port: ORGANISM_GOI_API_PORT_DEFAULT,
        api_login: None,
        api_password: None,
    }
}

pub(super) fn goi_validate_ssh_port(port: i32) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!("invalid SSH port: {port}"),
    })
}

pub(super) fn goi_validate_api_port(port: i32) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!("invalid API port: {port}"),
    })
}

fn goi_settings_from_organism(
    organism: &organism::Model,
) -> OrganismGoiSettings {
    let integration_type = goi_integration_type(organism);
    let is_full_integration = integration_type == GoiIntegrationType::Full;
    let ssh_host = if is_full_integration {
        normalize_optional_trimmed(organism.goi_ssh_host.clone())
    } else {
        None
    };
    let api_host = if is_full_integration {
        normalize_optional_trimmed(organism.goi_api_host.clone())
            .or_else(|| ssh_host.clone())
    } else {
        goi_web_host(organism)
    };
    OrganismGoiSettings {
        organism_id: organism.id,
        integration_type,
        ssh_host,
        ssh_user: if is_full_integration {
            normalize_optional_trimmed(organism.goi_ssh_user.clone())
        } else {
            None
        },
        ssh_port: if !is_full_integration {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        } else if organism.goi_ssh_port > 0 {
            organism.goi_ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        },
        path: if is_full_integration {
            normalize_trimmed_or_default(
                organism.goi_path.clone(),
                ORGANISM_GOI_PATH_DEFAULT,
            )
        } else {
            ORGANISM_GOI_PATH_DEFAULT.to_string()
        },
        api_host,
        api_port: if !is_full_integration {
            ORGANISM_GOI_API_PORT_DEFAULT
        } else if organism.goi_api_port > 0 {
            organism.goi_api_port
        } else {
            ORGANISM_GOI_API_PORT_DEFAULT
        },
        api_login: if is_full_integration {
            normalize_optional_trimmed(organism.goi_api_login.clone())
        } else {
            None
        },
        api_password: if is_full_integration {
            normalize_optional_trimmed(organism.goi_api_password.clone())
        } else {
            None
        },
    }
}

fn goi_connection_req_from_organism(
    organism: &organism::Model,
) -> Result<CheckOrganismGoiConnectionReq, AppError> {
    if goi_integration_type(organism) != GoiIntegrationType::Full {
        return Err(AppError::BL {
            msg: "Для простої інтеграції ГОІ SSH недоступний".to_string(),
        });
    }
    let settings = goi_settings_from_organism(organism);
    let ssh_host = settings.ssh_host.ok_or_else(|| AppError::BL {
        msg: "Для вашого організму не налаштовано GOI SSH host".to_string(),
    })?;
    let ssh_user = settings.ssh_user.ok_or_else(|| AppError::BL {
        msg: "Для вашого організму не налаштовано GOI SSH user".to_string(),
    })?;
    let req = CheckOrganismGoiConnectionReq {
        ssh_host,
        ssh_user,
        ssh_port: settings.ssh_port,
        path: settings.path,
    };
    goi_validate_connection_req(&req)?;
    Ok(req)
}

fn goi_control_state_from_organism(
    organism: &organism::Model,
) -> CurrentUserGoiControlState {
    match goi_connection_req_from_organism(organism) {
        Ok(_) => CurrentUserGoiControlState {
            can_restart: true,
            restart_unavailable_reason: None,
        },
        Err(AppError::BL { msg }) => CurrentUserGoiControlState {
            can_restart: false,
            restart_unavailable_reason: Some(msg),
        },
        Err(_) => CurrentUserGoiControlState {
            can_restart: false,
            restart_unavailable_reason: Some(
                "Не вдалося визначити доступність перезапуску GOI".to_string(),
            ),
        },
    }
}

pub(super) fn goi_restart_service_command(
    service: &RestartCurrentUserGoiService,
) -> &'static str {
    match service {
        RestartCurrentUserGoiService::Swapp => "sudo systemctl restart swapp",
        RestartCurrentUserGoiService::SwappAlt => {
            "sudo systemctl restart swapp-alt"
        }
        RestartCurrentUserGoiService::Goi => "sudo systemctl restart goi",
        RestartCurrentUserGoiService::EchoSwapp => {
            "sudo systemctl restart echo-swapp"
        }
    }
}

pub(super) fn goi_restart_service_error_context(
    service: &RestartCurrentUserGoiService,
) -> &'static str {
    match service {
        RestartCurrentUserGoiService::Swapp => {
            "Не вдалося перезапустити SWAPP на інстансі ГОІ"
        }
        RestartCurrentUserGoiService::SwappAlt => {
            "Не вдалося перезапустити SWAPP 4003 на інстансі ГОІ"
        }
        RestartCurrentUserGoiService::Goi => {
            "Не вдалося перезапустити GOI на інстансі ГОІ"
        }
        RestartCurrentUserGoiService::EchoSwapp => {
            "Не вдалося перезапустити Месенджери на інстансі ГОІ"
        }
    }
}

pub(super) fn goi_unlink_whatsapp_command(
    service: &RestartCurrentUserGoiService,
) -> Result<&'static str, AppError> {
    match service {
        RestartCurrentUserGoiService::Swapp => {
            Ok("(cd /etc/swapp && npm run whatsapp:delete)")
        }
        RestartCurrentUserGoiService::SwappAlt => {
            Ok("(cd /etc/swapp-alt && npm run whatsapp:delete)")
        }
        RestartCurrentUserGoiService::Goi
        | RestartCurrentUserGoiService::EchoSwapp => Err(AppError::BL {
            msg: "Відв'язування доступне лише для SWAPP".to_string(),
        }),
    }
}

pub(super) fn goi_unlink_whatsapp_error_context(
    service: &RestartCurrentUserGoiService,
) -> &'static str {
    match service {
        RestartCurrentUserGoiService::Swapp => {
            "Не вдалося відв'язати SWAPP на інстансі ГОІ"
        }
        RestartCurrentUserGoiService::SwappAlt => {
            "Не вдалося відв'язати SWAPP 4003 на інстансі ГОІ"
        }
        RestartCurrentUserGoiService::Goi => {
            "Не вдалося відв'язати GOI на інстансі ГОІ"
        }
        RestartCurrentUserGoiService::EchoSwapp => {
            "Не вдалося відв'язати Месенджери на інстансі ГОІ"
        }
    }
}

pub(super) fn goi_validate_connection_req(
    req: &CheckOrganismGoiConnectionReq,
) -> Result<(), AppError> {
    if req.ssh_host.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH host is required".to_string(),
        });
    }
    if req.ssh_user.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH user is required".to_string(),
        });
    }
    if req.path.trim().is_empty() {
        return Err(AppError::BL {
            msg: "GOI path is required".to_string(),
        });
    }
    goi_validate_ssh_port(req.ssh_port)
}

pub(super) fn goi_validate_setup_worker_req(
    req: &SetupOrganismGoiWorkerReq,
) -> Result<(), AppError> {
    goi_validate_connection_req(&CheckOrganismGoiConnectionReq {
        ssh_host: req.ssh_host.clone(),
        ssh_user: req.ssh_user.clone(),
        ssh_port: req.ssh_port,
        path: req.path.clone(),
    })?;
    goi_validate_api_port(req.api_port)
}

fn goi_validate_settings_req(
    req: &UpdateOrganismGoiSettingsReq,
) -> Result<(), AppError> {
    goi_validate_ssh_port(req.ssh_port)?;
    goi_validate_api_port(req.api_port)?;

    if req.integration_type == GoiIntegrationType::Full {
        let api_host = normalize_optional_trimmed(req.api_host.clone());
        let ssh_host = normalize_optional_trimmed(req.ssh_host.clone());
        let api_login = normalize_optional_trimmed(req.api_login.clone());
        let api_password = normalize_optional_trimmed(req.api_password.clone());
        let needs_api_auth =
            api_host.is_some() || api_login.is_some() || api_password.is_some();
        if needs_api_auth && api_host.is_none() && ssh_host.is_none() {
            return Err(AppError::BL {
                msg: "GOI API host or SSH host is required".to_string(),
            });
        }
        if needs_api_auth && api_login.is_none() {
            return Err(AppError::BL {
                msg: "GOI API login is required".to_string(),
            });
        }
        if needs_api_auth && api_password.is_none() {
            return Err(AppError::BL {
                msg: "GOI API password is required".to_string(),
            });
        }
    }
    Ok(())
}

pub(super) fn goi_generate_worker_secret() -> String {
    Uuid::new_v4().simple().to_string()
}

pub(super) fn goi_build_setup_worker_command(
    pg_password: &str,
    api_password: &str,
) -> String {
    let worker_config = format!(
        concat!(
            "pg_host = \"127.0.0.1\"\n",
            "pg_port = 5432\n",
            "pg_user = \"goi\"\n",
            "pg_password = \"{}\"\n",
            "pg_dbname = \"goi\"\n",
            "\n",
            "api_login = \"goi\"\n",
            "api_password = \"{}\"\n",
            "\n",
            "associations_xlsx_path = \"/etc/goi/data/xlsx/associations.xlsx\"\n",
            "knowledge_xlsx_path = \"/etc/goi/data/xlsx/knowledge.xlsx\"\n",
            "listen_host = \"0.0.0.0\"\n",
            "listen_port = 8088\n",
            "poll_sleep_ms = 1000\n"
        ),
        pg_password,
        api_password,
    );

    format!(
        r#"bash -se <<'GOI_ECHO_WORKER_SETUP'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo -n true

if ! getent ahostsv4 echo-ci.eagle-atria.ts.net >/dev/null 2>&1; then
  echo "Cannot resolve echo-ci.eagle-atria.ts.net from the GOI instance. Most likely the Tailscale invite has not been accepted yet inside the GOI container. Accept the invite and retry setup." >&2
  exit 1
fi

if ! sudo ping -c1 -W2 echo-ci.eagle-atria.ts.net >/dev/null 2>&1; then
  echo "Cannot reach echo-ci.eagle-atria.ts.net from the GOI instance. Most likely the Tailscale invite has not been accepted yet or Tailscale networking is not ready inside the GOI container. Accept the invite and retry setup." >&2
  exit 1
fi

sudo apt-get update >/dev/null
sudo apt-get install -y ca-certificates curl iputils-ping >/dev/null

sudo curl -fsSL https://echo-ci.eagle-atria.ts.net/keys/echo-ci-archive-keyring.gpg \
  -o /usr/share/keyrings/echo-ci-archive-keyring.gpg
ARCH="$(dpkg --print-architecture)"
echo "deb [arch=${{ARCH}} signed-by=/usr/share/keyrings/echo-ci-archive-keyring.gpg] https://echo-ci.eagle-atria.ts.net/echo jammy main" \
  | sudo tee /etc/apt/sources.list.d/echo.list >/dev/null

sudo apt-get update >/dev/null
sudo apt-get install -y postgresql goi-echo-worker >/dev/null
sudo systemctl enable --now postgresql >/dev/null

sudo -u postgres psql -v ON_ERROR_STOP=1 postgres <<'GOI_SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goi') THEN
    ALTER ROLE goi WITH LOGIN PASSWORD '{pg_password}';
  ELSE
    CREATE ROLE goi WITH LOGIN PASSWORD '{pg_password}';
  END IF;
END $$;
GOI_SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'goi'" | grep -q 1; then
  sudo -u postgres createdb -O goi goi
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 postgres -c "ALTER DATABASE goi OWNER TO goi"

sudo install -d -m 0755 /etc/goi-echo-worker
cat <<'GOI_ECHO_WORKER_CONFIG' | sudo tee /etc/goi-echo-worker/config.toml >/dev/null
{worker_config}GOI_ECHO_WORKER_CONFIG
sudo chmod 600 /etc/goi-echo-worker/config.toml

sudo systemctl daemon-reload
sudo systemctl enable --now goi-echo-worker >/dev/null
sudo systemctl restart goi-echo-worker >/dev/null
sudo systemctl is-active --quiet goi-echo-worker

echo "GOI worker configured successfully"
GOI_ECHO_WORKER_SETUP"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goi_find_source_relative_path_returns_single_match() {
        let entries = vec!["./folder_a/palitra.kmz".to_string()];
        let path = goi_find_source_relative_path(
            entries.as_slice(),
            &["palitra.kmz".to_string()],
            None,
        )
        .unwrap();
        assert_eq!(path, "folder_a/palitra.kmz");
    }

    #[test]
    fn goi_find_source_relative_path_uses_source_folder_hint() {
        let entries = vec![
            "./folder_a/palitra.kmz".to_string(),
            "./folder_b/palitra.kmz".to_string(),
        ];
        let path = goi_find_source_relative_path(
            entries.as_slice(),
            &["palitra.kmz".to_string()],
            Some("folder_b"),
        )
        .unwrap();
        assert_eq!(path, "folder_b/palitra.kmz");
    }

    #[test]
    fn goi_find_source_relative_path_uses_root_source_folder_hint() {
        let entries = vec![
            "./palitra.kmz".to_string(),
            "./folder_a/palitra.kmz".to_string(),
        ];
        let path = goi_find_source_relative_path(
            entries.as_slice(),
            &["palitra.kmz".to_string()],
            Some(""),
        )
        .unwrap();
        assert_eq!(path, "palitra.kmz");
    }

    #[test]
    fn goi_find_source_relative_path_fails_for_duplicates_without_hint() {
        let entries = vec![
            "./folder_a/palitra.kmz".to_string(),
            "./folder_b/palitra.kmz".to_string(),
        ];
        let err = goi_find_source_relative_path(
            entries.as_slice(),
            &["palitra.kmz".to_string()],
            None,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("multiple source files named 'palitra.kmz'"));
    }

    #[test]
    fn goi_parse_relative_file_entry_supports_nested_folders() {
        let parsed =
            goi_parse_relative_file_entry("./North/Sub/palitra.kmz").unwrap();
        assert_eq!(
            parsed,
            (Some("North/Sub".to_string()), "palitra.kmz".to_string())
        );
    }

    #[test]
    fn goi_relative_parent_dir_supports_nested_folders() {
        assert_eq!(
            goi_relative_parent_dir("North/Sub/palitra.kmz"),
            "North/Sub".to_string()
        );
        assert_eq!(goi_relative_parent_dir("palitra.kmz"), ".".to_string());
    }

    #[test]
    fn goi_build_relative_path_checked_rejects_parent_segments() {
        let err =
            goi_build_relative_path_checked(Some(".."), "p.kmz").unwrap_err();
        assert!(format!("{err:#}").contains("may not contain '.' or '..'"));
    }

    #[test]
    fn goi_relative_path_exists_finds_nested_target_path() {
        let entries =
            vec!["./beta/p.kmz".to_string(), "./North/Sub/p.kmz".to_string()];
        assert!(goi_relative_path_exists(
            entries.as_slice(),
            "North/Sub/p.kmz"
        ));
        assert!(!goi_relative_path_exists(
            entries.as_slice(),
            "North/Sub/other.kmz"
        ));
    }
}

use crate::config::{
    ORGANISM_GOI_API_PORT_DEFAULT,
    ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_DEFAULT,
    ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_MAX,
    ORGANISM_GOI_CATEGORIES_FILE_NAME, ORGANISM_GOI_CATEGORIES_JSON_MAX_BYTES,
    ORGANISM_GOI_CATEGORIES_UPLOAD_ZIP_MAX_BYTES,
    ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_DEFAULT,
    ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_MAX, ORGANISM_GOI_PALETTES_DIR_NAME,
    ORGANISM_GOI_PATH_DEFAULT, ORGANISM_GOI_SSH_PORT_DEFAULT,
};
use crate::entities::{
    goi_association, goi_integration, goi_integration_access_login,
    goi_integration_access_organism, goi_knowledge, login, organism,
};
use crate::error::AppError;
use crate::organism::goi::shared::{
    goi_external_url, goi_integration_has_api_config,
    goi_integration_model_type, goi_integration_web_host,
    goi_server_key_and_label, goi_swapp_url,
};
use crate::organism::goi::types::{
    DeleteGoiAdminIntegrationReq, DownloadGoiIntegrationPalettesReq,
    GetGoiAdminIntegrationReq, GoiAdminIntegration, GoiAssociation,
    GoiKnowledge, GoiUserIntegration, ListGoiAdminIntegrationsRsp,
    ListGoiAssociationsReq, ListGoiAssociationsRsp, ListGoiAssociationsSortBy,
    ListGoiKnowledgeReq, ListGoiKnowledgeRsp, ListGoiKnowledgeSortBy,
    RestartGoiIntegrationServiceReq, SetupGoiIntegrationWorkerReq,
    UnlinkGoiIntegrationWhatsappReq, UpsertGoiAdminIntegrationReq,
};
use crate::organism::types::{
    CheckOrganismGoiConnectionReq, CheckOrganismGoiConnectionRsp,
    GoiIntegrationType,
};
use crate::types::*;
use crate::utils::string::{
    normalize_optional_trimmed, normalize_trimmed_or_default,
};
use actix_multipart::{Field, Multipart};
use actix_web::http::header;
use actix_web::post;
use actix_web::web::{Json, Path as ActixPath};
use actix_web::HttpResponse;
use futures_util::StreamExt;
use sea_orm::*;
use sea_query::{extension::postgres::PgExpr, Expr};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

#[derive(Clone)]
struct GoiIntegrationWithOwner {
    integration: goi_integration::Model,
    owner_organism_name: String,
}

#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct ListCurrentUserGoiIntegrationsRsp {
    pub items: Vec<GoiUserIntegration>,
}

enum GoiService {
    Swapp,
    SwappAlt,
    Goi,
    EchoSwapp,
}

struct GoiCategoriesUpload {
    filename: String,
    bytes: Vec<u8>,
}

#[post("/api/admin/goi/integrations")]
pub async fn list_admin_goi_integrations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<ListGoiAdminIntegrationsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let items = load_integrations_with_owners_all(&env.dbx).await.c(h!())?;
    let mut integrations = Vec::with_capacity(items.len());
    for item in items {
        integrations
            .push(load_goi_admin_integration(&env.dbx, item).await.c(h!())?);
    }

    Ok(Json(ListGoiAdminIntegrationsRsp {
        items: integrations,
    }))
}

#[post("/api/admin/goi/integration")]
pub async fn get_admin_goi_integration(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<GetGoiAdminIntegrationReq>,
) -> Result<Json<GoiAdminIntegration>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let item = load_integration_with_owner(&env.dbx, req.id)
        .await
        .c(h!())?;
    Ok(Json(
        load_goi_admin_integration(&env.dbx, item).await.c(h!())?,
    ))
}

#[post("/api/admin/goi/integration/upsert")]
pub async fn upsert_admin_goi_integration(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpsertGoiAdminIntegrationReq>,
) -> Result<Json<GoiAdminIntegration>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    validate_goi_admin_integration_req(&req)?;
    ensure_goi_owner_exists(&env.dbx, req.owner_organism_id)
        .await
        .c(h!())?;
    ensure_goi_access_references_exist(
        &env.dbx,
        req.access_organism_ids.as_slice(),
        req.access_logins.as_slice(),
    )
    .await
    .c(h!())?;

    let (server_key, server_label) = normalized_server_key_and_label(&req)?;
    ensure_goi_server_unique(&env.dbx, req.id, &server_key)
        .await
        .c(h!())?;

    let tx = env.dbx.begin().await.c(h!())?;
    let integration = if let Some(id) = req.id {
        let item = goi_find_integration(&tx, id).await.c(h!())?;
        let previous_owner_organism_id = item.owner_organism_id;
        let mut item: goi_integration::ActiveModel = item.into();
        apply_goi_integration_patch(
            &mut item,
            &req,
            server_key.clone(),
            server_label.clone(),
        );
        let integration = item.update(&tx).await.c(h!())?;
        if previous_owner_organism_id != integration.owner_organism_id {
            sync_goi_row_owner_organism(
                &tx,
                integration.id,
                integration.owner_organism_id,
            )
            .await
            .c(h!())?;
        }
        integration
    } else {
        let values = normalized_goi_integration_values(&req);
        let integration = goi_integration::ActiveModel {
            id: NotSet,
            owner_organism_id: Set(req.owner_organism_id),
            created_at: NotSet,
            integration_type: Set(goi_integration_type_value(
                &req.integration_type,
            )
            .to_string()),
            server_key: Set(server_key.clone()),
            server_label: Set(server_label.clone()),
            ssh_host: Set(values.ssh_host),
            ssh_user: Set(values.ssh_user),
            ssh_port: Set(values.ssh_port),
            path: Set(values.path),
            api_host: Set(values.api_host),
            api_port: Set(values.api_port),
            api_login: Set(values.api_login),
            api_password: Set(values.api_password),
        }
        .insert(&tx)
        .await
        .c(h!())?;
        sync_goi_row_owner_organism(
            &tx,
            integration.id,
            integration.owner_organism_id,
        )
        .await
        .c(h!())?;
        integration
    };

    replace_goi_integration_access(&tx, integration.id, &req)
        .await
        .c(h!())?;
    tx.commit().await.c(h!())?;

    let item = load_integration_with_owner(&env.dbx, integration.id)
        .await
        .c(h!())?;
    Ok(Json(
        load_goi_admin_integration(&env.dbx, item).await.c(h!())?,
    ))
}

#[post("/api/admin/goi/integration/delete")]
pub async fn delete_admin_goi_integration(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteGoiAdminIntegrationReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    goi_integration::Entity::delete_many()
        .filter(goi_integration::Column::Id.eq(req.id))
        .exec(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(()))
}

#[post("/api/admin/goi/check-connection")]
pub async fn check_goi_integration_connection(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CheckOrganismGoiConnectionReq>,
) -> Result<Json<CheckOrganismGoiConnectionRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    let (listed_entries, error) = match super::goi_validate_connection_req(&req)
    {
        Ok(()) => match tokio::task::spawn_blocking(move || {
            super::goi_ssh::goi_check_connection_sync(req)
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
        },
        Err(err) => (Vec::new(), Some(format!("GOI SSH check failed: {err}"))),
    };

    Ok(Json(CheckOrganismGoiConnectionRsp {
        ok: error.is_none(),
        listed_entries,
        error,
    }))
}

#[post("/api/admin/goi/integration/setup-worker")]
pub async fn setup_goi_integration_worker(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SetupGoiIntegrationWorkerReq>,
) -> Result<Json<GoiAdminIntegration>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    let ssh_req = CheckOrganismGoiConnectionReq {
        ssh_host: req.ssh_host.clone(),
        ssh_user: req.ssh_user.clone(),
        ssh_port: req.ssh_port,
        path: req.path.clone(),
    };
    super::goi_validate_setup_worker_req(
        &crate::organism::types::SetupOrganismGoiWorkerReq {
            organism_id: 0,
            ssh_host: req.ssh_host.clone(),
            ssh_user: req.ssh_user.clone(),
            ssh_port: req.ssh_port,
            path: req.path.clone(),
            api_host: req.api_host.clone(),
            api_port: req.api_port,
        },
    )?;

    let integration = goi_find_integration(&env.dbx, req.id).await.c(h!())?;
    let api_host = normalize_optional_trimmed(req.api_host.clone())
        .or_else(|| normalize_optional_trimmed(Some(req.ssh_host.clone())));
    let api_password = super::goi_generate_worker_secret();
    let setup_command = super::goi_build_setup_worker_command(
        &super::goi_generate_worker_secret(),
        &api_password,
    );
    super::goi_run_setup_worker(ssh_req, setup_command).await?;

    let update_req = UpsertGoiAdminIntegrationReq {
        id: Some(integration.id),
        owner_organism_id: integration.owner_organism_id,
        integration_type: GoiIntegrationType::Full,
        ssh_host: Some(req.ssh_host),
        ssh_user: Some(req.ssh_user),
        ssh_port: req.ssh_port,
        path: req.path,
        api_host,
        api_port: req.api_port,
        api_login: Some("goi".to_string()),
        api_password: Some(api_password),
        access_organism_ids: collect_goi_access_organism_ids(
            &env.dbx,
            integration.id,
        )
        .await
        .c(h!())?,
        access_logins: collect_goi_access_logins(&env.dbx, integration.id)
            .await
            .c(h!())?,
    };

    let item = upsert_goi_integration_internal(&env.dbx, update_req)
        .await
        .c(h!())?;
    Ok(Json(item))
}

#[post("/api/goi/current-user-integrations")]
pub async fn list_current_user_goi_integrations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<ListCurrentUserGoiIntegrationsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let items = load_accessible_integrations_for_user(&env.dbx, &user_id)
        .await
        .c(h!())?;
    Ok(Json(ListCurrentUserGoiIntegrationsRsp {
        items: items
            .into_iter()
            .map(|item| user_goi_integration_from_item(&item))
            .collect(),
    }))
}

#[post("/api/goi/associations")]
pub async fn list_current_user_goi_associations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListGoiAssociationsReq>,
) -> Result<Json<ListGoiAssociationsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let req = req.into_inner();
    let integrations =
        load_accessible_integrations_for_user(&env.dbx, &user_id)
            .await
            .c(h!())?;
    let integration_map = integrations_to_map(&integrations);
    let integration_ids = accessible_goi_data_integration_ids(
        &integrations,
        req.filter_server.clone(),
    );
    if integration_ids.is_empty() {
        return Ok(Json(ListGoiAssociationsRsp {
            items: Vec::new(),
            has_more: false,
        }));
    }

    let page_limit = goi_associations_page_limit(req.limit);
    let page_offset = req.offset.unwrap_or(0);
    let associations = goi_associations_query(integration_ids, &req)
        .limit(page_limit + 1)
        .offset(page_offset)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let has_more = associations.len() as u64 > page_limit;
    let items = associations
        .into_iter()
        .take(page_limit as usize)
        .filter_map(|association| {
            integration_map.get(&association.integration_id).map(
                |integration| {
                    goi_association_from_model(association, integration)
                },
            )
        })
        .collect();

    Ok(Json(ListGoiAssociationsRsp { items, has_more }))
}

#[post("/api/goi/knowledge")]
pub async fn list_current_user_goi_knowledge(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListGoiKnowledgeReq>,
) -> Result<Json<ListGoiKnowledgeRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let req = req.into_inner();
    let integrations =
        load_accessible_integrations_for_user(&env.dbx, &user_id)
            .await
            .c(h!())?;
    let integration_map = integrations_to_map(&integrations);
    let integration_ids = accessible_goi_data_integration_ids(
        &integrations,
        req.filter_server.clone(),
    );
    if integration_ids.is_empty() {
        return Ok(Json(ListGoiKnowledgeRsp {
            items: Vec::new(),
            has_more: false,
        }));
    }

    let page_limit = goi_knowledge_page_limit(req.limit);
    let page_offset = req.offset.unwrap_or(0);
    let knowledge_items = goi_knowledge_query(integration_ids, &req)
        .limit(page_limit + 1)
        .offset(page_offset)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let has_more = knowledge_items.len() as u64 > page_limit;
    let items = knowledge_items
        .into_iter()
        .take(page_limit as usize)
        .filter_map(|knowledge| {
            integration_map
                .get(&knowledge.integration_id)
                .map(|integration| {
                    goi_knowledge_from_model(knowledge, integration)
                })
        })
        .collect();

    Ok(Json(ListGoiKnowledgeRsp { items, has_more }))
}

#[post("/api/goi/restart-service")]
pub async fn restart_current_user_goi_service(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RestartGoiIntegrationServiceReq>,
) -> Result<Json<bool>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let integrations =
        load_accessible_integrations_for_user(&env.dbx, &user_id)
            .await
            .c(h!())?;
    let integration = integrations
        .into_iter()
        .find(|item| item.integration.id == req.integration_id)
        .ok_or_else(|| AppError::BL {
            msg: "Інтеграцію ГОІ не знайдено або доступ відсутній".to_string(),
        })?;
    let ssh_req =
        goi_connection_req_from_integration(&integration.integration)?;
    let service = parse_goi_service(&req.service)?;
    let service_kind: super::RestartCurrentUserGoiService = (&service).into();

    super::goi_run_command(
        ssh_req,
        super::goi_restart_service_command(&service_kind).to_string(),
        super::goi_restart_service_error_context(&service_kind),
    )
    .await?;

    Ok(Json(true))
}

#[post("/api/goi/unlink-whatsapp")]
pub async fn unlink_current_user_goi_whatsapp(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UnlinkGoiIntegrationWhatsappReq>,
) -> Result<Json<bool>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let integrations =
        load_accessible_integrations_for_user(&env.dbx, &user_id)
            .await
            .c(h!())?;
    let integration = integrations
        .into_iter()
        .find(|item| item.integration.id == req.integration_id)
        .ok_or_else(|| AppError::BL {
            msg: "Інтеграцію ГОІ не знайдено або доступ відсутній".to_string(),
        })?;
    let ssh_req =
        goi_connection_req_from_integration(&integration.integration)?;
    let service = parse_goi_service(&req.service)?;
    let service_kind: super::RestartCurrentUserGoiService = (&service).into();

    super::goi_run_command(
        ssh_req,
        super::goi_unlink_whatsapp_command(&service_kind)?.to_string(),
        super::goi_unlink_whatsapp_error_context(&service_kind),
    )
    .await?;

    Ok(Json(true))
}

#[post("/api/goi/download-palettes")]
pub async fn download_current_user_goi_palettes(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DownloadGoiIntegrationPalettesReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let req = req.into_inner();
    let integration = load_accessible_integration_for_user(
        &env.dbx,
        &user_id,
        req.integration_id,
    )
    .await
    .c(h!())?;
    let ssh_req =
        goi_connection_req_from_integration(&integration.integration)?;
    let archive = download_goi_palettes_archive(ssh_req).await?;

    Ok(make_goi_zip_response(
        format!("goi-palettes-{}.zip", integration.integration.id),
        archive,
    ))
}

#[post("/api/goi/upload-categories/{integration_id}")]
pub async fn upload_current_user_goi_categories(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    integration_id: ActixPath<i64>,
    mut payload: Multipart,
) -> Result<Json<bool>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer").await?;

    let user_id = user.id().c(h!())?;
    let integration = load_accessible_integration_for_user(
        &env.dbx,
        &user_id,
        integration_id.into_inner(),
    )
    .await
    .c(h!())?;
    let ssh_req =
        goi_connection_req_from_integration(&integration.integration)?;
    let upload = read_goi_categories_upload(&mut payload).await?;
    let categories_json = extract_categories_json_from_zip(upload)?;
    let categories_path = goi_categories_remote_path(&ssh_req.path);

    super::goi_upload_file(ssh_req, categories_path, categories_json)
        .await
        .map_err(|err| AppError::BL {
            msg: format!(
                "Не вдалося завантажити categories.json на ГОІ: {err:#}"
            ),
        })?;

    Ok(Json(true))
}

async fn load_accessible_integrations_for_user(
    dbx: &DatabaseConnection,
    user_id: &str,
) -> Result<Vec<GoiIntegrationWithOwner>, AppError> {
    let login = login::Entity::find()
        .filter(login::Column::Login.eq(user_id))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;

    let integration_ids =
        load_accessible_integration_ids_for_login(dbx, &login)
            .await
            .c(h!())?;
    load_integrations_with_owners_by_ids(dbx, integration_ids.as_slice()).await
}

async fn load_accessible_integration_for_user(
    dbx: &DatabaseConnection,
    user_id: &str,
    integration_id: i64,
) -> Result<GoiIntegrationWithOwner, AppError> {
    load_accessible_integrations_for_user(dbx, user_id)
        .await
        .c(h!())?
        .into_iter()
        .find(|item| item.integration.id == integration_id)
        .ok_or_else(|| AppError::BL {
            msg: "Інтеграцію ГОІ не знайдено або доступ відсутній".to_string(),
        })
}

async fn download_goi_palettes_archive(
    ssh_req: CheckOrganismGoiConnectionReq,
) -> Result<Vec<u8>, AppError> {
    let remote_zip_path =
        format!("/tmp/echo-goi-palettes-{}.zip", Uuid::new_v4());
    let command =
        build_goi_palettes_archive_command(&ssh_req.path, &remote_zip_path);
    let create_result = super::goi_run_command(
        ssh_req.clone(),
        command,
        "Не вдалося створити архів палітр ГОІ",
    )
    .await;
    if let Err(err) = create_result {
        super::goi_delete_file_loose(ssh_req, remote_zip_path).await;
        return Err(err);
    }

    let download_result =
        super::goi_download_file(ssh_req.clone(), remote_zip_path.clone())
            .await;
    super::goi_delete_file_loose(ssh_req, remote_zip_path).await;

    download_result.map_err(|err| AppError::BL {
        msg: format!("Не вдалося завантажити архів палітр ГОІ: {err:#}"),
    })
}

fn build_goi_palettes_archive_command(
    goi_path: &str,
    remote_zip_path: &str,
) -> String {
    let data_dir = goi_remote_data_dir(goi_path);
    format!(
        "\
set -eu; \
data_dir={data_dir}; \
palettes_dir_name={palettes_dir_name}; \
palette_dir=\"$data_dir/$palettes_dir_name\"; \
archive={archive}; \
if [ ! -d \"$palette_dir\" ]; then \
echo \"GOI palettes folder not found: $palette_dir\" >&2; \
exit 1; \
fi; \
rm -f -- \"$archive\"; \
cd \"$data_dir\"; \
zip -qr \"$archive\" \"$palettes_dir_name\"\
",
        data_dir = super::goi_ssh::goi_shell_quote_single(&data_dir),
        palettes_dir_name = super::goi_ssh::goi_shell_quote_single(
            ORGANISM_GOI_PALETTES_DIR_NAME,
        ),
        archive = super::goi_ssh::goi_shell_quote_single(remote_zip_path),
    )
}

fn goi_remote_data_dir(goi_path: &str) -> String {
    let goi_path = normalize_trimmed_or_default(
        goi_path.to_string(),
        ORGANISM_GOI_PATH_DEFAULT,
    );
    let goi_path = goi_path.trim_end_matches('/');
    if goi_path.ends_with(&format!("/{ORGANISM_GOI_PALETTES_DIR_NAME}")) {
        Path::new(goi_path)
            .parent()
            .and_then(|parent| parent.to_str())
            .map(|parent| parent.to_string())
            .unwrap_or_else(|| goi_path.to_string())
    } else {
        goi_path.to_string()
    }
}

fn goi_categories_remote_path(goi_path: &str) -> String {
    goi_join_remote_path(
        &goi_remote_data_dir(goi_path),
        ORGANISM_GOI_CATEGORIES_FILE_NAME,
    )
}

fn goi_join_remote_path(dir: &str, file_name: &str) -> String {
    let dir = dir.trim_end_matches('/');
    let file_name = file_name.trim_start_matches('/');
    if dir.is_empty() {
        format!("/{file_name}")
    } else {
        format!("{dir}/{file_name}")
    }
}

fn make_goi_zip_response(filename: String, archive: Vec<u8>) -> HttpResponse {
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "application/zip"))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        ))
        .insert_header((header::CONTENT_LENGTH, archive.len().to_string()))
        .body(archive)
}

async fn read_goi_categories_upload(
    payload: &mut Multipart,
) -> Result<GoiCategoriesUpload, AppError> {
    let mut upload: Option<GoiCategoriesUpload> = None;
    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|err| AppError::BL {
            msg: format!("Multipart error: {err:?}"),
        })?;
        let is_file_field = field
            .content_disposition()
            .and_then(|cd| cd.get_filename())
            .is_some();
        if !is_file_field {
            read_goi_categories_field_bytes(&mut field, 1024).await?;
            continue;
        }
        if upload.is_some() {
            return Err(AppError::BL {
                msg: "Очікується лише один zip-файл".to_string(),
            });
        }
        let filename = field
            .content_disposition()
            .and_then(|cd| cd.get_filename())
            .unwrap_or("categories.zip")
            .to_string();
        let bytes = read_goi_categories_field_bytes(
            &mut field,
            ORGANISM_GOI_CATEGORIES_UPLOAD_ZIP_MAX_BYTES,
        )
        .await?;
        upload = Some(GoiCategoriesUpload { filename, bytes });
    }

    upload.ok_or_else(|| AppError::BL {
        msg: "Zip-файл з categories.json не вибрано".to_string(),
    })
}

async fn read_goi_categories_field_bytes(
    field: &mut Field,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.next().await {
        let chunk = chunk.map_err(|err| AppError::BL {
            msg: format!("Field read error: {err:?}"),
        })?;
        if bytes.len() + chunk.len() > max_bytes {
            return Err(AppError::BL {
                msg: format!(
                    "Файл завеликий. Максимальний розмір: {} МБ",
                    max_bytes / 1024 / 1024
                ),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn extract_categories_json_from_zip(
    upload: GoiCategoriesUpload,
) -> Result<Vec<u8>, AppError> {
    validate_goi_categories_zip_upload(&upload)?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(upload.bytes)).map_err(|err| {
            AppError::BL {
                msg: format!("Не вдалося прочитати zip-файл: {err}"),
            }
        })?;
    if archive.is_empty() {
        return Err(AppError::BL {
            msg: "Zip-файл порожній".to_string(),
        });
    }

    let categories_json = read_categories_json_from_archive(&mut archive)?;
    validate_categories_json_payload(&categories_json)?;
    Ok(categories_json)
}

fn validate_goi_categories_zip_upload(
    upload: &GoiCategoriesUpload,
) -> Result<(), AppError> {
    if upload.bytes.is_empty() {
        return Err(AppError::BL {
            msg: "Zip-файл порожній".to_string(),
        });
    }
    if !upload.filename.to_lowercase().ends_with(".zip") {
        return Err(AppError::BL {
            msg: "Файл має бути .zip архівом".to_string(),
        });
    }
    if !upload.bytes.starts_with(b"PK") {
        return Err(AppError::BL {
            msg: "Файл не схожий на zip-архів".to_string(),
        });
    }
    Ok(())
}

fn read_categories_json_from_archive<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<Vec<u8>, AppError> {
    let mut categories_json: Option<Vec<u8>> = None;
    let mut file_count = 0;
    for idx in 0..archive.len() {
        let mut file = archive.by_index(idx).map_err(|err| AppError::BL {
            msg: format!("Не вдалося прочитати файл у zip: {err}"),
        })?;
        if file.is_dir() {
            continue;
        }
        file_count += 1;
        let entry_path = file.enclosed_name().ok_or_else(|| AppError::BL {
            msg: "Zip містить небезпечний шлях файлу".to_string(),
        })?;
        if entry_path.as_path() != Path::new("categories.json") {
            return Err(AppError::BL {
                msg: "Zip має містити файл categories.json без вкладених папок"
                    .to_string(),
            });
        }
        if file.size() > ORGANISM_GOI_CATEGORIES_JSON_MAX_BYTES as u64 {
            return Err(AppError::BL {
                msg: format!(
                    "categories.json завеликий. Максимальний розмір: {} МБ",
                    ORGANISM_GOI_CATEGORIES_JSON_MAX_BYTES / 1024 / 1024
                ),
            });
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).c(h!())?;
        categories_json = Some(bytes);
    }

    if file_count != 1 {
        return Err(AppError::BL {
            msg: "Zip має містити рівно один файл categories.json".to_string(),
        });
    }
    categories_json.ok_or_else(|| AppError::BL {
        msg: "categories.json не знайдено в zip-файлі".to_string(),
    })
}

fn validate_categories_json_payload(bytes: &[u8]) -> Result<(), AppError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|err| AppError::BL {
            msg: format!("categories.json не є коректним JSON: {err}"),
        })?;
    if !value.is_array() && !value.is_object() {
        return Err(AppError::BL {
            msg: "categories.json має містити JSON об'єкт або масив"
                .to_string(),
        });
    }
    Ok(())
}

pub async fn load_user_goi_integrations(
    dbx: &DatabaseConnection,
    organism_id: Option<i64>,
    user_id: &str,
) -> Result<Vec<GoiUserIntegration>, AppError> {
    if organism_id.is_none() {
        return Ok(Vec::new());
    }
    Ok(load_accessible_integrations_for_user(dbx, user_id)
        .await
        .c(h!())?
        .into_iter()
        .map(|item| user_goi_integration_from_item(&item))
        .collect())
}

async fn upsert_goi_integration_internal(
    dbx: &DatabaseConnection,
    req: UpsertGoiAdminIntegrationReq,
) -> Result<GoiAdminIntegration, AppError> {
    validate_goi_admin_integration_req(&req)?;
    ensure_goi_owner_exists(dbx, req.owner_organism_id)
        .await
        .c(h!())?;
    ensure_goi_access_references_exist(
        dbx,
        req.access_organism_ids.as_slice(),
        req.access_logins.as_slice(),
    )
    .await
    .c(h!())?;
    let (server_key, server_label) = normalized_server_key_and_label(&req)?;
    ensure_goi_server_unique(dbx, req.id, &server_key)
        .await
        .c(h!())?;

    let tx = dbx.begin().await.c(h!())?;
    let integration = if let Some(id) = req.id {
        let item = goi_find_integration(&tx, id).await.c(h!())?;
        let previous_owner_organism_id = item.owner_organism_id;
        let mut item: goi_integration::ActiveModel = item.into();
        apply_goi_integration_patch(
            &mut item,
            &req,
            server_key.clone(),
            server_label.clone(),
        );
        let integration = item.update(&tx).await.c(h!())?;
        if previous_owner_organism_id != integration.owner_organism_id {
            sync_goi_row_owner_organism(
                &tx,
                integration.id,
                integration.owner_organism_id,
            )
            .await
            .c(h!())?;
        }
        integration
    } else {
        let values = normalized_goi_integration_values(&req);
        let integration = goi_integration::ActiveModel {
            id: NotSet,
            owner_organism_id: Set(req.owner_organism_id),
            created_at: NotSet,
            integration_type: Set(goi_integration_type_value(
                &req.integration_type,
            )
            .to_string()),
            server_key: Set(server_key.clone()),
            server_label: Set(server_label.clone()),
            ssh_host: Set(values.ssh_host),
            ssh_user: Set(values.ssh_user),
            ssh_port: Set(values.ssh_port),
            path: Set(values.path),
            api_host: Set(values.api_host),
            api_port: Set(values.api_port),
            api_login: Set(values.api_login),
            api_password: Set(values.api_password),
        }
        .insert(&tx)
        .await
        .c(h!())?;
        sync_goi_row_owner_organism(
            &tx,
            integration.id,
            integration.owner_organism_id,
        )
        .await
        .c(h!())?;
        integration
    };

    replace_goi_integration_access(&tx, integration.id, &req)
        .await
        .c(h!())?;
    tx.commit().await.c(h!())?;

    let item = load_integration_with_owner(dbx, integration.id)
        .await
        .c(h!())?;
    load_goi_admin_integration(dbx, item).await
}

async fn load_goi_admin_integration(
    dbx: &DatabaseConnection,
    item: GoiIntegrationWithOwner,
) -> Result<GoiAdminIntegration, AppError> {
    let access_organism_ids =
        collect_goi_access_organism_ids(dbx, item.integration.id)
            .await
            .c(h!())?;
    let access_logins = collect_goi_access_logins(dbx, item.integration.id)
        .await
        .c(h!())?;
    let integration_type = goi_integration_model_type(&item.integration);
    let is_full_integration = integration_type == GoiIntegrationType::Full;
    let web_host = goi_integration_web_host(&item.integration);

    Ok(GoiAdminIntegration {
        id: item.integration.id,
        owner_organism_id: item.integration.owner_organism_id,
        owner_organism_name: item.owner_organism_name,
        created_at_ms: item.integration.created_at.timestamp_millis(),
        integration_type,
        server_label: item.integration.server_label,
        ssh_host: if is_full_integration {
            normalize_optional_trimmed(item.integration.ssh_host)
        } else {
            None
        },
        ssh_user: if is_full_integration {
            normalize_optional_trimmed(item.integration.ssh_user)
        } else {
            None
        },
        ssh_port: if !is_full_integration {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        } else if item.integration.ssh_port > 0 {
            item.integration.ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        },
        path: if is_full_integration {
            normalize_trimmed_or_default(
                item.integration.path,
                ORGANISM_GOI_PATH_DEFAULT,
            )
        } else {
            ORGANISM_GOI_PATH_DEFAULT.to_string()
        },
        api_host: if is_full_integration {
            normalize_optional_trimmed(item.integration.api_host)
        } else {
            web_host
        },
        api_port: if !is_full_integration {
            ORGANISM_GOI_API_PORT_DEFAULT
        } else if item.integration.api_port > 0 {
            item.integration.api_port
        } else {
            ORGANISM_GOI_API_PORT_DEFAULT
        },
        api_login: if is_full_integration {
            normalize_optional_trimmed(item.integration.api_login)
        } else {
            None
        },
        api_password: if is_full_integration {
            normalize_optional_trimmed(item.integration.api_password)
        } else {
            None
        },
        access_organism_ids,
        access_logins,
    })
}

async fn load_integrations_with_owners_all(
    dbx: &DatabaseConnection,
) -> Result<Vec<GoiIntegrationWithOwner>, AppError> {
    let items = goi_integration::Entity::find()
        .find_also_related(organism::Entity)
        .order_by_asc(goi_integration::Column::ServerLabel)
        .order_by_asc(goi_integration::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(items
        .into_iter()
        .filter_map(|(integration, owner)| {
            owner.map(|owner| GoiIntegrationWithOwner {
                integration,
                owner_organism_name: owner.name,
            })
        })
        .collect())
}

async fn load_integrations_with_owners_by_ids(
    dbx: &DatabaseConnection,
    integration_ids: &[i64],
) -> Result<Vec<GoiIntegrationWithOwner>, AppError> {
    if integration_ids.is_empty() {
        return Ok(Vec::new());
    }
    let items = goi_integration::Entity::find()
        .filter(goi_integration::Column::Id.is_in(integration_ids.to_vec()))
        .find_also_related(organism::Entity)
        .order_by_asc(goi_integration::Column::ServerLabel)
        .order_by_asc(goi_integration::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(items
        .into_iter()
        .filter_map(|(integration, owner)| {
            owner.map(|owner| GoiIntegrationWithOwner {
                integration,
                owner_organism_name: owner.name,
            })
        })
        .collect())
}

async fn load_integration_with_owner(
    dbx: &DatabaseConnection,
    integration_id: i64,
) -> Result<GoiIntegrationWithOwner, AppError> {
    let (integration, owner) =
        goi_integration::Entity::find_by_id(integration_id)
            .find_also_related(organism::Entity)
            .one(dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    Ok(GoiIntegrationWithOwner {
        integration,
        owner_organism_name: owner.ok_or(AppError::NotFound)?.name,
    })
}

async fn goi_find_integration<C>(
    dbx: &C,
    integration_id: i64,
) -> Result<goi_integration::Model, AppError>
where
    C: ConnectionTrait,
{
    goi_integration::Entity::find_by_id(integration_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn collect_goi_access_organism_ids(
    dbx: &DatabaseConnection,
    integration_id: i64,
) -> Result<Vec<i64>, AppError> {
    Ok(goi_integration_access_organism::Entity::find()
        .filter(
            goi_integration_access_organism::Column::GoiIntegrationId
                .eq(integration_id),
        )
        .select_only()
        .column(goi_integration_access_organism::Column::OrganismId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

async fn collect_goi_access_logins(
    dbx: &DatabaseConnection,
    integration_id: i64,
) -> Result<Vec<String>, AppError> {
    Ok(goi_integration_access_login::Entity::find()
        .filter(
            goi_integration_access_login::Column::GoiIntegrationId
                .eq(integration_id),
        )
        .select_only()
        .column(goi_integration_access_login::Column::Login)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?)
}

async fn load_accessible_integration_ids_for_login(
    dbx: &DatabaseConnection,
    login: &login::Model,
) -> Result<Vec<i64>, AppError> {
    let mut integration_ids = HashSet::new();

    let by_login = goi_integration_access_login::Entity::find()
        .filter(
            goi_integration_access_login::Column::Login.eq(login.login.clone()),
        )
        .select_only()
        .column(goi_integration_access_login::Column::GoiIntegrationId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    integration_ids.extend(by_login);

    if let Some(organism_id) = login.organism_id {
        let by_organism = goi_integration_access_organism::Entity::find()
            .filter(
                goi_integration_access_organism::Column::OrganismId
                    .eq(organism_id),
            )
            .select_only()
            .column(goi_integration_access_organism::Column::GoiIntegrationId)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?;
        integration_ids.extend(by_organism);

        let owned = goi_integration::Entity::find()
            .filter(goi_integration::Column::OwnerOrganismId.eq(organism_id))
            .select_only()
            .column(goi_integration::Column::Id)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?;
        integration_ids.extend(owned);
    }

    let mut integration_ids = integration_ids.into_iter().collect::<Vec<_>>();
    integration_ids.sort_unstable();
    Ok(integration_ids)
}

fn user_goi_integration_from_item(
    item: &GoiIntegrationWithOwner,
) -> GoiUserIntegration {
    let can_restart =
        goi_connection_req_from_integration(&item.integration).is_ok();
    let restart_unavailable_reason =
        goi_connection_req_from_integration(&item.integration)
            .err()
            .and_then(|err| match err {
                AppError::BL { msg } => Some(msg),
                _ => None,
            });
    GoiUserIntegration {
        id: item.integration.id,
        owner_organism_id: item.integration.owner_organism_id,
        owner_organism_name: item.owner_organism_name.clone(),
        integration_type: item.integration.integration_type.clone(),
        server_label: item.integration.server_label.clone(),
        goi_url: goi_external_url(goi_integration_web_host(&item.integration)),
        swapp_url: goi_swapp_url(goi_integration_web_host(&item.integration)),
        has_data_access: goi_integration_has_api_config(&item.integration),
        can_restart,
        restart_unavailable_reason,
    }
}

fn goi_connection_req_from_integration(
    integration: &goi_integration::Model,
) -> Result<CheckOrganismGoiConnectionReq, AppError> {
    if goi_integration_model_type(integration) != GoiIntegrationType::Full {
        return Err(AppError::BL {
            msg: "Для простої інтеграції ГОІ SSH недоступний".to_string(),
        });
    }
    let ssh_host = normalize_optional_trimmed(integration.ssh_host.clone())
        .ok_or_else(|| AppError::BL {
            msg: "Для інтеграції ГОІ не налаштовано SSH host".to_string(),
        })?;
    let ssh_user = normalize_optional_trimmed(integration.ssh_user.clone())
        .ok_or_else(|| AppError::BL {
            msg: "Для інтеграції ГОІ не налаштовано SSH user".to_string(),
        })?;
    let req = CheckOrganismGoiConnectionReq {
        ssh_host,
        ssh_user,
        ssh_port: if integration.ssh_port > 0 {
            integration.ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        },
        path: normalize_trimmed_or_default(
            integration.path.clone(),
            ORGANISM_GOI_PATH_DEFAULT,
        ),
    };
    super::goi_validate_connection_req(&req)?;
    Ok(req)
}

fn parse_goi_service(raw: &str) -> Result<GoiService, AppError> {
    match raw.trim() {
        "swapp" => Ok(GoiService::Swapp),
        "swapp_alt" => Ok(GoiService::SwappAlt),
        "goi" => Ok(GoiService::Goi),
        "echo_swapp" => Ok(GoiService::EchoSwapp),
        other => Err(AppError::BL {
            msg: format!("Невідомий сервіс ГОІ: {other}"),
        }),
    }
}

impl From<&GoiService> for super::RestartCurrentUserGoiService {
    fn from(value: &GoiService) -> Self {
        match value {
            GoiService::Swapp => super::RestartCurrentUserGoiService::Swapp,
            GoiService::SwappAlt => {
                super::RestartCurrentUserGoiService::SwappAlt
            }
            GoiService::Goi => super::RestartCurrentUserGoiService::Goi,
            GoiService::EchoSwapp => {
                super::RestartCurrentUserGoiService::EchoSwapp
            }
        }
    }
}

fn integrations_to_map(
    integrations: &[GoiIntegrationWithOwner],
) -> HashMap<i64, GoiIntegrationWithOwner> {
    integrations
        .iter()
        .cloned()
        .map(|item| (item.integration.id, item))
        .collect()
}

fn accessible_goi_data_integration_ids(
    integrations: &[GoiIntegrationWithOwner],
    filter_server: Option<String>,
) -> Vec<i64> {
    let server_filter = normalize_optional_trimmed(filter_server)
        .map(|value| value.to_lowercase());
    integrations
        .iter()
        .filter(|item| goi_integration_has_api_config(&item.integration))
        .filter(|item| match server_filter.as_ref() {
            None => true,
            Some(pattern) => item
                .integration
                .server_label
                .to_lowercase()
                .contains(pattern),
        })
        .map(|item| item.integration.id)
        .collect()
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

fn goi_associations_query(
    integration_ids: Vec<i64>,
    req: &ListGoiAssociationsReq,
) -> Select<goi_association::Entity> {
    let mut query = goi_association::Entity::find()
        .filter(goi_association::Column::IntegrationId.is_in(integration_ids));

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
    integration_ids: Vec<i64>,
    req: &ListGoiKnowledgeReq,
) -> Select<goi_knowledge::Entity> {
    let mut query = goi_knowledge::Entity::find()
        .filter(goi_knowledge::Column::IntegrationId.is_in(integration_ids));

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
    integration: &GoiIntegrationWithOwner,
) -> GoiAssociation {
    GoiAssociation {
        id: association.id,
        integration_id: association.integration_id,
        server_label: integration.integration.server_label.clone(),
        owner_organism_name: integration.owner_organism_name.clone(),
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

fn goi_knowledge_from_model(
    knowledge: goi_knowledge::Model,
    integration: &GoiIntegrationWithOwner,
) -> GoiKnowledge {
    GoiKnowledge {
        id: knowledge.id,
        integration_id: knowledge.integration_id,
        server_label: integration.integration.server_label.clone(),
        owner_organism_name: integration.owner_organism_name.clone(),
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

fn validate_goi_admin_integration_req(
    req: &UpsertGoiAdminIntegrationReq,
) -> Result<(), AppError> {
    super::goi_validate_ssh_port(req.ssh_port)?;
    super::goi_validate_api_port(req.api_port)?;

    match req.integration_type {
        GoiIntegrationType::Simple => {
            let host = normalize_optional_trimmed(req.api_host.clone())
                .or_else(|| normalize_optional_trimmed(req.ssh_host.clone()));
            if host.is_none() {
                return Err(AppError::BL {
                    msg: "Для простої інтеграції вкажіть GOI URL або host"
                        .to_string(),
                });
            }
        }
        GoiIntegrationType::Full => {
            let api_host = normalize_optional_trimmed(req.api_host.clone());
            let ssh_host = normalize_optional_trimmed(req.ssh_host.clone());
            let api_login = normalize_optional_trimmed(req.api_login.clone());
            let api_password =
                normalize_optional_trimmed(req.api_password.clone());
            let needs_api_auth = api_host.is_some()
                || api_login.is_some()
                || api_password.is_some();
            if needs_api_auth && api_host.is_none() && ssh_host.is_none() {
                return Err(AppError::BL {
                    msg: "GOI API host або SSH host обовʼязкові".to_string(),
                });
            }
            if needs_api_auth && api_login.is_none() {
                return Err(AppError::BL {
                    msg: "GOI API логін обовʼязковий".to_string(),
                });
            }
            if needs_api_auth && api_password.is_none() {
                return Err(AppError::BL {
                    msg: "GOI API пароль обовʼязковий".to_string(),
                });
            }
        }
    }
    Ok(())
}

async fn ensure_goi_owner_exists(
    dbx: &DatabaseConnection,
    organism_id: i64,
) -> Result<(), AppError> {
    organism::Entity::find_by_id(organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .map(|_| ())
}

async fn ensure_goi_access_references_exist(
    dbx: &DatabaseConnection,
    organism_ids: &[i64],
    logins: &[String],
) -> Result<(), AppError> {
    if !organism_ids.is_empty() {
        let count = organism::Entity::find()
            .filter(organism::Column::DeletedPermanently.eq(false))
            .filter(organism::Column::Id.is_in(organism_ids.to_vec()))
            .count(dbx)
            .await
            .c(h!())?;
        if count as usize
            != organism_ids.iter().copied().collect::<HashSet<_>>().len()
        {
            return Err(AppError::BL {
                msg: "Не всі організми для доступу ГОІ існують".to_string(),
            });
        }
    }
    if !logins.is_empty() {
        let count = login::Entity::find()
            .filter(login::Column::DeletedPermanently.eq(false))
            .filter(login::Column::Login.is_in(logins.to_vec()))
            .count(dbx)
            .await
            .c(h!())?;
        if count as usize
            != logins.iter().cloned().collect::<HashSet<_>>().len()
        {
            return Err(AppError::BL {
                msg: "Не всі логіни для доступу ГОІ існують".to_string(),
            });
        }
    }
    Ok(())
}

fn normalized_server_key_and_label(
    req: &UpsertGoiAdminIntegrationReq,
) -> Result<(String, String), AppError> {
    let (server_key, server_label) = goi_server_key_and_label(
        &req.integration_type,
        req.ssh_host.clone(),
        req.api_host.clone(),
        req.api_port,
    );
    if server_key.trim().is_empty() || server_label.trim().is_empty() {
        return Err(AppError::BL {
            msg: "Не вдалося визначити сервер ГОІ".to_string(),
        });
    }
    Ok((server_key, server_label))
}

async fn ensure_goi_server_unique(
    dbx: &DatabaseConnection,
    current_id: Option<i64>,
    server_key: &str,
) -> Result<(), AppError> {
    let mut query = goi_integration::Entity::find()
        .filter(goi_integration::Column::ServerKey.eq(server_key.to_string()));
    if let Some(current_id) = current_id {
        query = query.filter(goi_integration::Column::Id.ne(current_id));
    }
    if query.one(dbx).await.c(h!())?.is_some() {
        return Err(AppError::BL {
            msg: "Інтеграція для цього GOI сервера вже існує".to_string(),
        });
    }
    Ok(())
}

fn apply_goi_integration_patch(
    item: &mut goi_integration::ActiveModel,
    req: &UpsertGoiAdminIntegrationReq,
    server_key: String,
    server_label: String,
) {
    let values = normalized_goi_integration_values(req);
    item.owner_organism_id = Set(req.owner_organism_id);
    item.integration_type =
        Set(goi_integration_type_value(&req.integration_type).to_string());
    item.server_key = Set(server_key);
    item.server_label = Set(server_label);
    item.ssh_host = Set(values.ssh_host);
    item.ssh_user = Set(values.ssh_user);
    item.ssh_port = Set(values.ssh_port);
    item.path = Set(values.path);
    item.api_host = Set(values.api_host);
    item.api_port = Set(values.api_port);
    item.api_login = Set(values.api_login);
    item.api_password = Set(values.api_password);
}

struct GoiIntegrationValues {
    ssh_host: Option<String>,
    ssh_user: Option<String>,
    ssh_port: i32,
    path: String,
    api_host: Option<String>,
    api_port: i32,
    api_login: Option<String>,
    api_password: Option<String>,
}

fn normalized_goi_integration_values(
    req: &UpsertGoiAdminIntegrationReq,
) -> GoiIntegrationValues {
    match req.integration_type {
        GoiIntegrationType::Simple => GoiIntegrationValues {
            ssh_host: None,
            ssh_user: None,
            ssh_port: ORGANISM_GOI_SSH_PORT_DEFAULT,
            path: ORGANISM_GOI_PATH_DEFAULT.to_string(),
            api_host: normalize_optional_trimmed(req.api_host.clone())
                .or_else(|| normalize_optional_trimmed(req.ssh_host.clone())),
            api_port: ORGANISM_GOI_API_PORT_DEFAULT,
            api_login: None,
            api_password: None,
        },
        GoiIntegrationType::Full => GoiIntegrationValues {
            ssh_host: normalize_optional_trimmed(req.ssh_host.clone()),
            ssh_user: normalize_optional_trimmed(req.ssh_user.clone()),
            ssh_port: req.ssh_port,
            path: normalize_trimmed_or_default(
                req.path.clone(),
                ORGANISM_GOI_PATH_DEFAULT,
            ),
            api_host: normalize_optional_trimmed(req.api_host.clone()),
            api_port: req.api_port,
            api_login: normalize_optional_trimmed(req.api_login.clone()),
            api_password: normalize_optional_trimmed(req.api_password.clone()),
        },
    }
}

async fn replace_goi_integration_access(
    tx: &DatabaseTransaction,
    integration_id: i64,
    req: &UpsertGoiAdminIntegrationReq,
) -> Result<(), AppError> {
    goi_integration_access_organism::Entity::delete_many()
        .filter(
            goi_integration_access_organism::Column::GoiIntegrationId
                .eq(integration_id),
        )
        .exec(tx)
        .await
        .c(h!())?;
    goi_integration_access_login::Entity::delete_many()
        .filter(
            goi_integration_access_login::Column::GoiIntegrationId
                .eq(integration_id),
        )
        .exec(tx)
        .await
        .c(h!())?;

    let mut organism_ids = req.access_organism_ids.clone();
    if !organism_ids.contains(&req.owner_organism_id) {
        organism_ids.push(req.owner_organism_id);
    }
    organism_ids.sort_unstable();
    organism_ids.dedup();

    if !organism_ids.is_empty() {
        goi_integration_access_organism::Entity::insert_many(
            organism_ids.into_iter().map(|organism_id| {
                goi_integration_access_organism::ActiveModel {
                    id: NotSet,
                    goi_integration_id: Set(integration_id),
                    organism_id: Set(organism_id),
                    created_at: NotSet,
                }
            }),
        )
        .exec(tx)
        .await
        .c(h!())?;
    }

    let mut access_logins = req
        .access_logins
        .iter()
        .filter_map(|login| normalize_optional_trimmed(Some(login.clone())))
        .collect::<Vec<_>>();
    access_logins.sort();
    access_logins.dedup();
    if !access_logins.is_empty() {
        goi_integration_access_login::Entity::insert_many(
            access_logins.into_iter().map(|login| {
                goi_integration_access_login::ActiveModel {
                    id: NotSet,
                    goi_integration_id: Set(integration_id),
                    login: Set(login),
                    created_at: NotSet,
                }
            }),
        )
        .exec(tx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn sync_goi_row_owner_organism(
    tx: &DatabaseTransaction,
    integration_id: i64,
    organism_id: i64,
) -> Result<(), AppError> {
    goi_association::Entity::update_many()
        .col_expr(
            goi_association::Column::OrganismId,
            Expr::value(organism_id),
        )
        .filter(goi_association::Column::IntegrationId.eq(integration_id))
        .exec(tx)
        .await
        .c(h!())?;
    goi_knowledge::Entity::update_many()
        .col_expr(goi_knowledge::Column::OrganismId, Expr::value(organism_id))
        .filter(goi_knowledge::Column::IntegrationId.eq(integration_id))
        .exec(tx)
        .await
        .c(h!())?;
    Ok(())
}

fn goi_integration_type_value(
    integration_type: &GoiIntegrationType,
) -> &'static str {
    match integration_type {
        GoiIntegrationType::Simple => {
            crate::config::ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE
        }
        GoiIntegrationType::Full => {
            crate::config::ORGANISM_GOI_INTEGRATION_TYPE_FULL
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goi_categories_remote_path_uses_configured_palette_parent() {
        assert_eq!(
            goi_categories_remote_path("/opt/goi/data/palettes"),
            "/opt/goi/data/categories.json"
        );
    }

    #[test]
    fn goi_categories_remote_path_accepts_configured_data_dir() {
        assert_eq!(
            goi_categories_remote_path("/opt/goi/data"),
            "/opt/goi/data/categories.json"
        );
    }

    #[test]
    fn goi_palettes_archive_command_uses_configured_data_dir() {
        let command = build_goi_palettes_archive_command(
            "/opt/goi/data/palettes",
            "/tmp/palettes.zip",
        );

        assert!(command.contains("data_dir='/opt/goi/data'"));
        assert!(command.contains("palettes_dir_name='palettes'"));
        assert!(!command.contains("/etc/goi/data"));
    }
}

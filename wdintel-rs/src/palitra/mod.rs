use crate::config::{ORGANISM_GOI_PATH_DEFAULT, ORGANISM_GOI_SSH_PORT_DEFAULT};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::palitra::bl::{
    palitra_search_cache_key, palitra_suggest_cache_key, read_cached_json,
    write_cached_json,
};
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::multipart;
use crate::utils::string::normalize_trimmed_or_default;
use actix_multipart::Multipart;
use actix_web::post;
use actix_web::web::{Data, Json};
use anyhow::{bail, Context};
use chrono::Utc;
use futures_util::StreamExt;
use itertools::Itertools;
use sea_orm::*;
use std::path::Path;
use tempfile::tempdir;

mod bl;
mod kmz;
pub mod types;

#[derive(Clone)]
struct UserScope {
    organism_ids: Vec<i64>,
    aor_ids: Vec<i64>,
}

#[post("/api/palitra/create-with-kmz")]
pub async fn create_palitra_with_kmz(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;

    // Extract multipart fields
    let mut name: Option<String> = None;
    let mut color_hex: Option<String> = None;
    let mut access_type: Option<String> = None;
    let mut access_values: Option<String> = None;
    let mut kmz_file: Option<(String, Vec<u8>)> = None;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|e| AppError::BL {
            msg: format!("Multipart error: {e:?}"),
        })?;
        let content_disposition = field.content_disposition();
        let field_name = content_disposition
            .and_then(|cd| cd.get_name())
            .map(|s| s.to_string())
            .unwrap_or_default();

        match field_name.as_str() {
            "name" => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.next().await {
                    let chunk = chunk.map_err(|e| AppError::BL {
                        msg: format!("Field read error: {e:?}"),
                    })?;
                    bytes.extend_from_slice(&chunk);
                }
                name = Some(String::from_utf8(bytes).c(h!())?);
            }
            "color_hex" => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.next().await {
                    let chunk = chunk.map_err(|e| AppError::BL {
                        msg: format!("Field read error: {e:?}"),
                    })?;
                    bytes.extend_from_slice(&chunk);
                }
                color_hex = Some(String::from_utf8(bytes).c(h!())?);
            }
            "access_type" => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.next().await {
                    let chunk = chunk.map_err(|e| AppError::BL {
                        msg: format!("Field read error: {e:?}"),
                    })?;
                    bytes.extend_from_slice(&chunk);
                }
                access_type = Some(String::from_utf8(bytes).c(h!())?);
            }
            "access_values" => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.next().await {
                    let chunk = chunk.map_err(|e| AppError::BL {
                        msg: format!("Field read error: {e:?}"),
                    })?;
                    bytes.extend_from_slice(&chunk);
                }
                access_values = Some(String::from_utf8(bytes).c(h!())?);
            }
            "kmz" => {
                let raw_filename = content_disposition
                    .and_then(|cd| cd.get_filename())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "file.kmz".to_string());
                let filename = kmz::sanitize_upload_filename(&raw_filename);
                let mut bytes = Vec::new();
                while let Some(chunk) = field.next().await {
                    let chunk = chunk.map_err(|e| AppError::BL {
                        msg: format!("Field read error: {e:?}"),
                    })?;
                    bytes.extend_from_slice(&chunk);
                }
                kmz_file = Some((filename, bytes));
            }
            _ => {
                // Skip unknown fields but consume their data to avoid blocking multipart parser
                while let Some(chunk) = field.next().await {
                    let _ = chunk.map_err(|e| AppError::BL {
                        msg: format!("Field read error: {e:?}"),
                    })?;
                }
            }
        }
    }

    // Validate required fields
    let name = name.c(h!())?;
    let color_hex = color_hex.c(h!())?;
    let access_type = access_type.c(h!())?;
    let access_values = access_values.unwrap_or_default();
    let (filename, kmz_data) = kmz_file.c(h!())?;

    // Parse access
    let access = parse_access(&access_type, &access_values).c(h!())?;

    // Validate permissions
    ensure_palitra_permissions(&env, &login, &access, &scope)
        .await
        .c(h!())?;

    // Create palitra request
    let req = CreatePalitraReq {
        name: name.clone(),
        color_hex,
        access: access.clone(),
        source_file_name: Some(filename.clone()),
        last_uploaded_at_ts: Some(Utc::now().timestamp_millis()),
    };

    // Create palitra first
    let palitra = bl::create_palitra(login.clone(), req, &env.dbx)
        .await
        .c(h!())?;

    // Upload points from KMZ in a separate transaction
    let txn = env.dbx.begin().await.c(h!())?;
    let remote_filename = kmz_file_name_as_kmz(&filename);
    let points = kmz::load_coordinates_from_file(
        filename.clone(),
        kmz_data.clone(),
        &env,
    )
    .await
    .c(h!())?;

    let palitra_geometry =
        read_latest_palitra_geometry_with_warning(&env.dbx, palitra.id)
            .await
            .c(h!())?;

    bl::rewrite_palitra_points(palitra_geometry.id, points, &txn)
        .await
        .c(h!())?;

    sync_upload_palitra_to_connected_organisms(
        &env.dbx,
        &access,
        &remote_filename,
        kmz_data,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;

    // Reload and return created palitra with all data
    let result = palitra::Entity::find_by_id(palitra.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;

    let palitra_response = Palitra {
        id: result.id,
        name: result.name,
        color_hex: palitra_geometry.hex,
        author: result.author,
        source_file_name: palitra_geometry.source_file_name,
        last_uploaded_at_ts: palitra_geometry
            .last_uploaded_at
            .map(|ts| ts.and_utc().timestamp_millis()),
        geometry: None, // Will be calculated on next request
        access_aor_id: bl::collect_palitra_access_aors(&env.dbx, palitra.id)
            .await
            .c(h!())?,
        access_organism_ids: bl::collect_palitra_access_organisms(
            &env.dbx, palitra.id,
        )
        .await
        .c(h!())?,
        access_logins: bl::collect_palitra_access_logins(&env.dbx, palitra.id)
            .await
            .c(h!())?,
    };

    Ok(Json(palitra_response))
}

#[post("/api/palitra/analyze-kmz")]
pub async fn analyze_kmz(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<AnalyzeKmzResponse>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;

    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let raw_filename = field
        .content_disposition()
        .and_then(|cd| cd.get_filename().map(|s| s.to_string()))
        .unwrap_or_else(|| "file.kmz".to_string());
    let filename = kmz::sanitize_upload_filename(&raw_filename);

    // Save to temporary directory for analysis
    let tmp_dir = tempdir().c(h!())?;
    let tmp_path = tmp_dir.path().join(&filename);
    tokio::fs::write(&tmp_path, val).await.c(h!())?;

    // Extract top colors based on file extension
    let extension = tmp_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("kmz")
        .to_ascii_lowercase();

    let top_colors = match extension.as_str() {
        "kmz" => kmz::extract_top_colors_from_kmz(&tmp_path).await.c(h!())?,
        "kml" => kmz::extract_top_colors_from_kml(&tmp_path).await.c(h!())?,
        _ => {
            return Err(AppError::BL {
                msg: format!("Unsupported file extension: {extension}. Expected .kmz or .kml"),
            });
        }
    };

    // Clean filename (remove extension case-insensitively)
    let name_without_ext = Path::new(&filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&filename)
        .to_string();

    Ok(Json(AnalyzeKmzResponse {
        top_colors,
        filename: name_without_ext,
    }))
}

#[post("/api/palitra/upload-points/{palitra_id}")]
pub async fn upload_palitra_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
    mut payload: Multipart,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let palitra_id = path.into_inner();
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    if !is_admin {
        match &palitra.author {
            Some(author) if author == &login => {}
            _ => {
                return Err(AppError::Forbidden(
                    "Only author or Admin may upload palitra points".into(),
                ));
            }
        }
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &existing_access, &scope)
        .await
        .c(h!())?;

    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let raw_filename = field.name().c(h!())?.to_string();
    let filename = kmz::sanitize_upload_filename(&raw_filename);
    let raw_kmz_data = val;
    let points = kmz::load_coordinates_from_file(
        filename.clone(),
        raw_kmz_data.clone(),
        &env,
    )
    .await
    .c(h!())?;
    let palitra_geometry =
        read_latest_palitra_geometry_with_warning(&env.dbx, palitra.id)
            .await
            .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;

    let palitra_geometry_id = palitra_geometry.id;
    let mut model = palitra_geometry.into_active_model();
    model.source_file_name = Set(Some(filename.clone()));
    model.update(&txn).await.c(h!())?;

    bl::rewrite_palitra_points(palitra_geometry_id, points, &txn)
        .await
        .c(h!())?;

    let remote_filename = kmz_file_name_as_kmz(&filename);
    sync_upload_palitra_to_connected_organisms(
        &env.dbx,
        &existing_access,
        &remote_filename,
        raw_kmz_data,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/palitra/list")]
pub async fn list_all_palitras(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<Palitra>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras(login, &env.dbx).await.context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/list-detailed")] // TODO implement filter
pub async fn list_all_palitras_detailed(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraDetails>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras_detailed(login, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/points")]
pub async fn list_palitra_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraPointsReq>,
) -> Result<Json<Vec<PalitraPoints>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let req = req.into_inner();
    let points =
        bl::list_palitra_points_by_viewport_bounds(login, req, &env.dbx)
            .await
            .context(h!())?;
    Ok(Json(points))
}

#[post("/api/palitra/points/label-suggest")]
pub async fn suggest_palitra_point_labels(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraPointLabelSuggestReq>,
) -> Result<Json<Vec<PalitraPointLabelSuggestRsp>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let req = req.into_inner();
    let cache_key = palitra_suggest_cache_key(&login, &req);
    let mut redis = env.redis.clone();
    if let Some(labels) =
        read_cached_json(&mut redis, &cache_key).await.c(h!())?
    {
        return Ok(Json(labels));
    }
    let labels = bl::suggest_palitra_point_labels(login, req, &env.dbx)
        .await
        .context(h!())?;
    write_cached_json(
        &mut redis,
        &cache_key,
        crate::config::PALITRA_POINT_LABEL_SUGGEST_CACHE_TTL_SEC,
        &labels,
    )
    .await
    .c(h!())?;
    Ok(Json(labels))
}

#[post("/api/palitra/points/search")]
pub async fn search_palitra_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraSearchPointsReq>,
) -> Result<Json<Vec<PalitraPoints>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let req = req.into_inner();
    let cache_key = palitra_search_cache_key(&login, &req);
    let mut redis = env.redis.clone();
    if let Some(points) =
        read_cached_json(&mut redis, &cache_key).await.c(h!())?
    {
        return Ok(Json(points));
    }
    let points = bl::search_palitra_points_by_labels(login, req, &env.dbx)
        .await
        .context(h!())?;
    write_cached_json(
        &mut redis,
        &cache_key,
        crate::config::PALITRA_POINT_SEARCH_CACHE_TTL_SEC,
        &points,
    )
    .await
    .c(h!())?;
    Ok(Json(points))
}

#[post("/api/palitra/create")]
pub async fn create_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let req = req.into_inner();
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &req.access, &scope)
        .await
        .c(h!())?;
    let palitra = bl::create_palitra(login, req, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/update/{palitra_id}")]
pub async fn update_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraDetails>, AppError> {
    let login = user.id().c(h!())?;
    let req = req.into_inner();
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &req.access, &scope)
        .await
        .c(h!())?;
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    if !is_admin {
        match &palitra.author {
            Some(author) if author == &login => {}
            _ => {
                return Err(AppError::Forbidden(
                    "Only author or Admin may update palitra".into(),
                ));
            }
        }
    }

    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &existing_access, &scope)
        .await
        .c(h!())?;
    let result = bl::update_palitra(palitra.id, req, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(result))
}

#[post("/api/palitra/delete/{palitra_id}")]
pub async fn delete_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    if !is_admin {
        match &palitra.author {
            Some(author) if author == &login => {}
            _ => {
                return Err(AppError::Forbidden(
                    "Only author or Admin may delete palitra".into(),
                ));
            }
        }
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    ensure_palitra_permissions(&env, &login, &existing_access, &scope)
        .await
        .c(h!())?;

    bl::delete_palitra(palitra.id, &txn, existing_access, &env)
        .await
        .c(h!())?; //deletes with all geometries, TODO add method for drop one geometry only
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

async fn ensure_palitra_permissions(
    env: &Data<Env>,
    login: &str,
    access: &PalitraAccess,
    scope: &UserScope,
) -> anyhow::Result<()> {
    let is_empty = match access {
        PalitraAccess::ByLogins { logins } => logins.is_empty(),
        PalitraAccess::ByOrganisms { organism_ids } => organism_ids.is_empty(),
        PalitraAccess::ByAor { aor_ids } => aor_ids.is_empty(),
    };
    if is_empty {
        bail!("Palitra access list may not be empty");
    }

    let is_admin = crate::users::has_role(&env.dbx, login, "Admin")
        .await
        .is_ok();
    let is_editor = crate::users::has_any_role(
        &env.dbx,
        login,
        vec!["UnitsEditor", "CallsignsEditor"],
    )
    .await
    .is_ok();

    let is_rer = crate::users::has_role(&env.dbx, login, "Rer").await.is_ok();

    match access {
        PalitraAccess::ByLogins { logins } => {
            if is_admin {
                return Ok(());
            }
            if is_editor {
                // Editor can only manage palitra scoped to own login
                let all_self = logins.iter().all(|l| l == login);
                if !all_self {
                    bail!("Editor may only manage palitra scoped to own login");
                }
                return Ok(());
            }
            if !is_rer {
                bail!("Only Rer may manage login-scoped palitra");
            }
            let all_self = logins.iter().all(|l| l == login);
            if !all_self {
                bail!("Rer may only manage palitra scoped to own login");
            }
        }
        PalitraAccess::ByOrganisms { organism_ids } => {
            if is_admin {
                return Ok(());
            }
            if is_editor {
                // Editor can only manage palitra scoped to own organisms
                let permitted: Vec<_> = scope.organism_ids.to_vec();
                let all_known =
                    organism_ids.iter().all(|id| permitted.contains(id));
                if !all_known {
                    bail!(
                        "Editor may only manage palitra scoped to own organism"
                    );
                }
                return Ok(());
            }
            if !is_rer {
                bail!("Only Rer may manage organism-scoped palitra");
            }
            let permitted: Vec<_> = scope.organism_ids.to_vec();
            let all_known =
                organism_ids.iter().all(|id| permitted.contains(id));
            if !all_known {
                bail!("Rer may only manage palitra scoped to own organism");
            }
        }
        PalitraAccess::ByAor { aor_ids } => {
            if is_admin {
                return Ok(());
            }
            if !is_editor {
                bail!("Only Editor/Admin may manage AOR-scoped palitra");
            }
            let permitted: Vec<_> = scope.aor_ids.to_vec();
            let all_known = aor_ids.iter().all(|id| permitted.contains(id));
            if !all_known {
                bail!("Editor may only manage palitra scoped to own AOR");
            }
        }
    };
    Ok(())
}

async fn read_latest_palitra_geometry_with_warning(
    dbx: &DatabaseConnection,
    palitra_id: i64,
) -> anyhow::Result<palitra_geometry::Model> {
    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .order_by_desc(palitra_geometry::Column::UpdatedAt)
        .all(dbx)
        .await
        .c(h!())?;

    if palitra_geometries.len() > 1 {
        warn!(
            "palitra {palitra_id} has {} active geometries; using the latest one for a single-geometry flow",
            palitra_geometries.len()
        );
    }

    palitra_geometries.into_iter().next().c(h!())
}

async fn load_user_scope(
    dbx: &DatabaseConnection,
    login: &str,
) -> anyhow::Result<UserScope> {
    let organism_aors = organism_aor::Entity::find()
        .join(JoinType::InnerJoin, organism_aor::Relation::Organism.def())
        .join(JoinType::InnerJoin, organism::Relation::Login.def())
        .filter(login::Column::Login.eq(login.to_string()))
        .all(dbx)
        .await
        .c(h!())?;
    let organism_ids =
        organism_aors.iter().map(|o| o.organism_id).collect_vec();
    let aor_ids = organism_aors.iter().map(|o| o.aor_id).collect_vec();
    Ok(UserScope {
        organism_ids,
        aor_ids,
    })
}

async fn read_palitra_access(
    dbx: &DatabaseConnection,
    palitra_id: i64,
) -> anyhow::Result<PalitraAccess> {
    let logins = bl::collect_palitra_access_logins(dbx, palitra_id)
        .await
        .c(h!())?;
    let organism_ids = bl::collect_palitra_access_organisms(dbx, palitra_id)
        .await
        .c(h!())?;
    let aor_ids = bl::collect_palitra_access_aors(dbx, palitra_id)
        .await
        .c(h!())?;
    pick_access(logins, organism_ids, aor_ids)
}

fn pick_access(
    logins: Vec<String>,
    organism_ids: Vec<i64>,
    aor_ids: Vec<i64>,
) -> anyhow::Result<PalitraAccess> {
    if !logins.is_empty() {
        return Ok(PalitraAccess::ByLogins { logins });
    }
    if !organism_ids.is_empty() {
        return Ok(PalitraAccess::ByOrganisms { organism_ids });
    }
    if !aor_ids.is_empty() {
        return Ok(PalitraAccess::ByAor { aor_ids });
    }
    bail!("Palitra must have explicit access scope");
}

fn parse_access(
    access_type: &str,
    access_values: &str,
) -> anyhow::Result<PalitraAccess> {
    match access_type {
        "logins" => {
            let logins: Vec<String> = access_values
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Ok(PalitraAccess::ByLogins { logins })
        }
        "organisms" => {
            let organism_ids: Vec<i64> = access_values
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();
            Ok(PalitraAccess::ByOrganisms { organism_ids })
        }
        "aor" => {
            let aor_ids: Vec<i64> = access_values
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();
            Ok(PalitraAccess::ByAor { aor_ids })
        }
        _ => bail!("Invalid access type: {}", access_type),
    }
}

async fn sync_upload_palitra_to_connected_organisms(
    dbx: &DatabaseConnection,
    access: &PalitraAccess,
    remote_file_name: &str,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    let PalitraAccess::ByOrganisms { organism_ids } = access else {
        return Ok(());
    };

    let goi_targets =
        collect_connected_goi_targets(dbx, organism_ids.as_slice())
            .await
            .c(h!())?;

    for target in goi_targets {
        let remote_file_path =
            compose_goi_palette_remote_path(&target.path, remote_file_name);
        crate::organism::goi::goi_upload_file(
            target,
            remote_file_path,
            file_data.clone(),
        )
        .await
        .c(h!())?;
    }

    Ok(())
}

async fn sync_delete_palitra_from_connected_organisms(
    dbx: &DatabaseConnection,
    access: &PalitraAccess,
    source_file_name: &Option<String>,
) -> anyhow::Result<()> {
    let PalitraAccess::ByOrganisms { organism_ids } = access else {
        return Ok(());
    };

    let Some(source_file_name) = source_file_name else {
        return Ok(());
    };
    let source_file_name = kmz_file_name_as_kmz(source_file_name);
    let goi_targets =
        collect_connected_goi_targets(dbx, organism_ids.as_slice())
            .await
            .c(h!())?;

    for target in goi_targets {
        let remote_file_path =
            compose_goi_palette_remote_path(&target.path, &source_file_name);
        crate::organism::goi::goi_delete_file(target, remote_file_path)
            .await
            .c(h!())?;
    }

    Ok(())
}

async fn collect_connected_goi_targets(
    dbx: &DatabaseConnection,
    organism_ids: &[i64],
) -> anyhow::Result<Vec<CheckOrganismGoiConnectionReq>> {
    if organism_ids.is_empty() {
        return Ok(vec![]);
    }

    let organisms = organism::Entity::find()
        .filter(organism::Column::Id.is_in(organism_ids.to_vec()))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .all(dbx)
        .await
        .c(h!())?;

    let mut goi_targets = Vec::with_capacity(organisms.len());
    for organism in organisms {
        let ssh_host = organism
            .goi_ssh_host
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let ssh_user = organism
            .goi_ssh_user
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let Some(ssh_host) = ssh_host else { continue };
        let Some(ssh_user) = ssh_user else { continue };

        let path = normalize_trimmed_or_default(
            organism.goi_path,
            ORGANISM_GOI_PATH_DEFAULT,
        );
        if path.trim().is_empty() {
            continue;
        }

        let ssh_port = if organism.goi_ssh_port > 0 {
            organism.goi_ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        };

        let req = CheckOrganismGoiConnectionReq {
            ssh_host,
            ssh_user,
            ssh_port,
            path,
        };
        goi_validate_connection_req(&req)?;
        goi_targets.push(req);
    }

    Ok(goi_targets)
}

fn kmz_file_name_as_kmz(source_file_name: &str) -> String {
    let safe_name = kmz::sanitize_upload_filename(source_file_name);
    let path = Path::new(&safe_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "palitra".to_string());
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("kml") => format!("{stem}.kml"),
        Some("kmz") => format!("{stem}.kmz"),
        _ => format!("{stem}.kmz"),
    }
}

fn compose_goi_palette_remote_path(path: &str, file_name: &str) -> String {
    let trimmed_path = path.trim().trim_end_matches('/');
    let trimmed_file = file_name.trim().trim_start_matches('/');
    if trimmed_file.is_empty() {
        return trimmed_path.to_string();
    }
    if trimmed_path.is_empty() {
        format!("/{trimmed_file}")
    } else {
        format!("{trimmed_path}/{trimmed_file}")
    }
}

fn goi_validate_connection_req(
    req: &CheckOrganismGoiConnectionReq,
) -> anyhow::Result<()> {
    if req.ssh_host.trim().is_empty() {
        bail!("SSH host is required");
    }
    if req.ssh_user.trim().is_empty() {
        bail!("SSH user is required");
    }
    if req.path.trim().is_empty() {
        bail!("GOI path is required");
    }
    if !(1..=65535).contains(&req.ssh_port) {
        bail!("invalid SSH port: {}", req.ssh_port);
    }
    Ok(())
}

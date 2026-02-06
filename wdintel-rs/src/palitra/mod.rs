use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::multipart;
use actix_multipart::Multipart;
use actix_web::post;
use actix_web::web::{Data, Json};
use anyhow::{bail, Context};
use chrono::Utc;
use futures_util::StreamExt;
use itertools::Itertools;
use sea_orm::*;
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
        access,
        source_file_name: Some(filename.clone()),
        last_uploaded_at_ts: Some(Utc::now().timestamp_millis()),
    };

    // Create palitra first
    let palitra = bl::create_palitra(login.clone(), req, &env.dbx)
        .await
        .c(h!())?;

    // Upload points from KMZ in a separate transaction
    let txn = env.dbx.begin().await.c(h!())?;
    let points =
        kmz::load_coordinates_from_file(filename.clone(), kmz_data, &env)
            .await
            .c(h!())?;

    bl::rewrite_palitra_points(palitra.id, points, &txn)
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
        color_hex: result.hex,
        author: result.author,
        source_file_name: result.source_file_name,
        last_uploaded_at_ts: result
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

    // Extract top 3 colors based on file extension
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

    // Clean filename (remove extension)
    let name_without_ext = filename
        .strip_suffix(".kmz")
        .or_else(|| filename.strip_suffix(".kml"))
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
    let points = kmz::load_coordinates_from_file(filename.clone(), val, &env)
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;

    let palitra_id = palitra.id;
    let mut model = palitra.into_active_model();
    model.source_file_name = Set(Some(filename));
    model.update(&txn).await.c(h!())?;

    bl::rewrite_palitra_points(palitra_id, points, &txn)
        .await
        .c(h!())?;
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

#[post("/api/palitra/points/search")]
pub async fn search_palitra_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraSearchPointsReq>,
) -> Result<Json<Vec<PalitraPoints>>, AppError> {
    println!("search_palitra_points");
    dbg!("{:?}", &req);
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let req = req.into_inner();
    let points = bl::search_palitra_points_by_labels(login, req, &env.dbx)
        .await
        .context(h!())?;
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
    bl::delete_palitra(palitra.id, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

use crate::config::{ORGANISM_GOI_PATH_DEFAULT, ORGANISM_GOI_SSH_PORT_DEFAULT};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::organism::goi::shared::goi_integration_web_host;
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::palitra::bl::{
    palitra_search_cache_key, palitra_suggest_cache_key, read_cached_json,
    write_cached_json,
};
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::multipart;
use crate::utils::string::normalize_trimmed_or_default;
use actix_multipart::{Field, Multipart};
use actix_web::post;
use actix_web::web::{Data, Json};
use actix_web::HttpResponse;
use anyhow::{bail, Context};
use chrono::{NaiveDateTime, Utc};
use futures_util::StreamExt;
use itertools::Itertools;
use sea_orm::*;
use std::collections::{BTreeMap, HashSet};
use std::io::{BufWriter, Seek, Write};
use std::path::Path;
use tempfile::tempdir;
use tokio_util::io::ReaderStream;
use zip::write::FileOptions;

pub(crate) mod bl;
mod kmz;
pub mod oneoff;
pub mod types;
pub mod worker;

#[derive(Clone)]
struct UserScope {
    organism_ids: Vec<i64>,
    aor_ids: Vec<i64>,
}

struct CreatePalitraMultipartPayload {
    name: String,
    color_hex: Option<String>,
    access_type: String,
    access_values: String,
    filename: String,
    kmz_data: Vec<u8>,
}

#[post("/api/palitra/create-with-kmz")]
pub async fn create_palitra_with_kmz(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let multipart_payload =
        parse_create_palitra_multipart(&mut payload).await.c(h!())?;
    let color_hex = normalize_color_hex_or_fallback(Some(
        multipart_payload.color_hex.c(h!())?,
    ));

    // Parse access
    let access = parse_access(
        &multipart_payload.access_type,
        &multipart_payload.access_values,
    )
    .c(h!())?;

    // Validate permissions
    ensure_palitra_permissions(&env, &login, &access, &scope)
        .await
        .c(h!())?;

    // Create palitra request
    let req = CreatePalitraReq {
        name: multipart_payload.name,
        color_hex,
        access: access.clone(),
        source_file_name: Some(multipart_payload.filename.clone()),
        last_uploaded_at_ts: Some(Utc::now().timestamp_millis()),
    };

    // Create palitra first
    let palitra = bl::create_palitra(login.clone(), req, &env.dbx)
        .await
        .c(h!())?;

    // Upload points from KMZ in a separate transaction
    let txn = env.dbx.begin().await.c(h!())?;
    let remote_filename = kmz_file_name_as_kmz(&multipart_payload.filename);
    let upload = kmz::load_coordinates_from_file(
        multipart_payload.filename.clone(),
        multipart_payload.kmz_data.clone(),
        &env,
    )
    .await
    .c(h!())?;
    let points = upload.points;

    let palitra_geometry =
        read_latest_palitra_geometry_with_warning(&env.dbx, palitra.id)
            .await
            .c(h!())?;

    bl::rewrite_palitra_points(palitra_geometry.id, points, &txn, &env.rq)
        .await
        .c(h!())?;
    bl::rewrite_palitra_line_strings(
        palitra_geometry.id,
        upload.line_strings,
        &txn,
    )
    .await
    .c(h!())?;
    bl::update_palitra_s3_id(&txn, palitra.id, upload.s3_id)
        .await
        .c(h!())?;

    sync_upload_palitra_to_connected_organisms(
        &env.dbx,
        &access,
        &remote_filename,
        multipart_payload.kmz_data,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;
    let palitra_response =
        render_created_palitra_response(&env.dbx, palitra.id)
            .await
            .c(h!())?;
    Ok(Json(palitra_response))
}

#[post("/api/palitra/create-palitra-basic")]
pub async fn create_palitra_basic(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let multipart_payload =
        parse_create_palitra_multipart(&mut payload).await.c(h!())?;
    let access = parse_access(
        &multipart_payload.access_type,
        &multipart_payload.access_values,
    )
    .c(h!())?;
    ensure_palitra_permissions(&env, &login, &access, &scope)
        .await
        .c(h!())?;

    let uploaded_at = Utc::now();
    let upload = kmz::load_coordinates_from_file(
        multipart_payload.filename.clone(),
        multipart_payload.kmz_data.clone(),
        &env,
    )
    .await
    .c(h!())?;
    let mut points_by_color = group_palitra_points_by_color(upload.points);
    let mut line_strings_by_color =
        group_palitra_lines_by_color(upload.line_strings);
    let primary_color_hex =
        pick_primary_color_hex(&points_by_color, &line_strings_by_color);
    let mut geometry_colors = vec![primary_color_hex.clone()];
    geometry_colors.extend(
        points_by_color
            .keys()
            .filter(|color_hex| *color_hex != &primary_color_hex)
            .cloned(),
    );
    geometry_colors.extend(
        line_strings_by_color
            .keys()
            .filter(|color_hex| *color_hex != &primary_color_hex)
            .cloned(),
    );
    let mut seen_colors = HashSet::new();
    geometry_colors.retain(|color_hex| seen_colors.insert(color_hex.clone()));

    let txn = env.dbx.begin().await.c(h!())?;
    let mut created_palitra_ids = Vec::with_capacity(geometry_colors.len());
    for color_hex in geometry_colors {
        let req = CreatePalitraReq {
            name: multipart_payload.name.clone(),
            color_hex: color_hex.clone(),
            access: access.clone(),
            source_file_name: Some(multipart_payload.filename.clone()),
            last_uploaded_at_ts: Some(uploaded_at.timestamp_millis()),
        };
        let palitra =
            bl::create_palitra(login.clone(), req, &txn).await.c(h!())?;
        created_palitra_ids.push(palitra.id);
        let palitra_geometry =
            read_latest_palitra_geometry_with_warning(&txn, palitra.id)
                .await
                .c(h!())?;
        let color_points =
            points_by_color.remove(&color_hex).unwrap_or_default();
        let color_line_strings =
            line_strings_by_color.remove(&color_hex).unwrap_or_default();
        bl::rewrite_palitra_points(
            palitra_geometry.id,
            color_points,
            &txn,
            &env.rq,
        )
        .await
        .c(h!())?;
        bl::rewrite_palitra_line_strings(
            palitra_geometry.id,
            color_line_strings,
            &txn,
        )
        .await
        .c(h!())?;
        bl::update_palitra_s3_id(&txn, palitra.id, upload.s3_id.clone())
            .await
            .c(h!())?;
    }

    let remote_filename = kmz_file_name_as_kmz(&multipart_payload.filename);
    sync_upload_palitra_to_connected_organisms(
        &env.dbx,
        &access,
        &remote_filename,
        multipart_payload.kmz_data,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;

    let first_palitra_id = created_palitra_ids.first().copied().c(h!())?;
    let palitra_response =
        render_created_palitra_response(&env.dbx, first_palitra_id)
            .await
            .c(h!())?;
    Ok(Json(palitra_response))
}

#[post("/api/palitra/v2/create-palitra-basic")]
pub async fn create_palitra_basic_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let scope = load_user_scope(&env.dbx, &login).await.c(h!())?;
    let multipart_payload =
        parse_create_palitra_multipart(&mut payload).await.c(h!())?;
    let access = parse_access(
        &multipart_payload.access_type,
        &multipart_payload.access_values,
    )
    .c(h!())?;
    ensure_palitra_permissions(&env, &login, &access, &scope)
        .await
        .c(h!())?;

    let upload = kmz::load_coordinates_from_file(
        multipart_payload.filename.clone(),
        multipart_payload.kmz_data.clone(),
        &env,
    )
    .await
    .c(h!())?;
    let mut points_by_color = group_palitra_points_by_color(upload.points);
    let mut line_strings_by_color =
        group_palitra_lines_by_color(upload.line_strings);
    let uploaded_at = Utc::now();
    let selected_color_hex = multipart_payload
        .color_hex
        .map(|color_hex| normalize_color_hex_or_fallback(Some(color_hex)));
    if let Some(selected_color_hex) = &selected_color_hex {
        remap_fallback_color(
            &mut points_by_color,
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX,
            selected_color_hex,
        );
        remap_fallback_color(
            &mut line_strings_by_color,
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX,
            selected_color_hex,
        );
    }
    let primary_color_hex =
        pick_primary_color_hex(&points_by_color, &line_strings_by_color);
    let req = CreatePalitraReq {
        name: multipart_payload.name,
        color_hex: primary_color_hex,
        access: access.clone(),
        source_file_name: Some(multipart_payload.filename.clone()),
        last_uploaded_at_ts: Some(uploaded_at.timestamp_millis()),
    };
    let palitra = bl::create_palitra(login, req, &env.dbx).await.c(h!())?;

    let mut geometry_colors = points_by_color.keys().cloned().collect_vec();
    geometry_colors.extend(line_strings_by_color.keys().cloned().collect_vec());
    geometry_colors.sort();
    geometry_colors.dedup();
    if geometry_colors.is_empty() {
        geometry_colors
            .push(crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string());
    }

    let txn = env.dbx.begin().await.c(h!())?;
    for color_hex in geometry_colors {
        let palitra_geometry = upsert_palitra_geometry_by_color(
            &txn,
            palitra.id,
            &color_hex,
            &multipart_payload.filename,
            uploaded_at.naive_utc(),
        )
        .await
        .c(h!())?;
        let color_points =
            points_by_color.remove(&color_hex).unwrap_or_default();
        let color_line_strings =
            line_strings_by_color.remove(&color_hex).unwrap_or_default();
        bl::rewrite_palitra_points(
            palitra_geometry.id,
            color_points,
            &txn,
            &env.rq,
        )
        .await
        .c(h!())?;
        bl::rewrite_palitra_line_strings(
            palitra_geometry.id,
            color_line_strings,
            &txn,
        )
        .await
        .c(h!())?;
    }
    bl::update_palitra_s3_id(&txn, palitra.id, upload.s3_id)
        .await
        .c(h!())?;

    let remote_filename = kmz_file_name_as_kmz(&multipart_payload.filename);
    sync_upload_palitra_to_connected_organisms(
        &env.dbx,
        &access,
        &remote_filename,
        multipart_payload.kmz_data,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;

    let palitra_response =
        render_created_palitra_response(&env.dbx, palitra.id)
            .await
            .c(h!())?;
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
    let palitra_id = path.into_inner();
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_author_or_admin =
        is_palitra_author_or_admin(&env.dbx, &login, &palitra)
            .await
            .c(h!())?;
    if !is_author_or_admin {
        return Err(AppError::Forbidden(
            "Only author or Admin may upload palitra points".into(),
        ));
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let raw_filename = field.name().c(h!())?.to_string();
    let filename = kmz::sanitize_upload_filename(&raw_filename);
    let raw_kmz_data = val;
    let upload = kmz::load_coordinates_from_file(
        filename.clone(),
        raw_kmz_data.clone(),
        &env,
    )
    .await
    .c(h!())?;
    let mut points_by_color = group_palitra_points_by_color(upload.points);
    let mut line_strings_by_color =
        group_palitra_lines_by_color(upload.line_strings);
    let uploaded_at = Utc::now();
    let mut geometry_colors = points_by_color.keys().cloned().collect_vec();
    geometry_colors.extend(line_strings_by_color.keys().cloned().collect_vec());
    let mut seen_colors = HashSet::new();
    geometry_colors.retain(|color_hex| seen_colors.insert(color_hex.clone()));
    if geometry_colors.is_empty() {
        geometry_colors
            .push(crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string());
    }
    let parsed_points_total =
        points_by_color.values().map(Vec::len).sum::<usize>();
    let txn = env.dbx.begin().await.c(h!())?;
    let existing_palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .all(&txn)
        .await
        .c(h!())?;
    let mut retained_geometry_ids: HashSet<i64> = HashSet::new();
    for color_hex in geometry_colors {
        let palitra_geometry = upsert_palitra_geometry_by_color(
            &txn,
            palitra.id,
            &color_hex,
            &filename,
            uploaded_at.naive_utc(),
        )
        .await
        .c(h!())?;
        retained_geometry_ids.insert(palitra_geometry.id);
        let color_points =
            points_by_color.remove(&color_hex).unwrap_or_default();
        let color_line_strings =
            line_strings_by_color.remove(&color_hex).unwrap_or_default();
        bl::rewrite_palitra_points(
            palitra_geometry.id,
            color_points,
            &txn,
            &env.rq,
        )
        .await
        .c(h!())?;
        bl::rewrite_palitra_line_strings(
            palitra_geometry.id,
            color_line_strings,
            &txn,
        )
        .await
        .c(h!())?;
    }
    let stale_geometry_ids = existing_palitra_geometries
        .into_iter()
        .map(|geometry| geometry.id)
        .filter(|id| !retained_geometry_ids.contains(id))
        .collect_vec();
    if !stale_geometry_ids.is_empty() {
        error!(
            "palitra {} upload-points missing {} existing colors; soft-deleting stale geometries: {:?}",
            palitra.id,
            stale_geometry_ids.len(),
            stale_geometry_ids
        );
    }
    for stale_geometry_id in stale_geometry_ids {
        bl::soft_delete_palitra_geometry(stale_geometry_id, &txn)
            .await
            .c(h!())?;
    }
    if parsed_points_total > 0 {
        info!(
            "palitra {} upload-points parsed {} total points and distributed them across {} colors",
            palitra.id,
            parsed_points_total,
            retained_geometry_ids.len()
        );
    }
    bl::update_palitra_s3_id(&txn, palitra.id, upload.s3_id)
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
    env.palitra_worker_context.flush_cache(palitra_id).await;

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

#[post("/api/palitra/v2/list")]
pub async fn list_all_palitras_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraReadV2>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras_v2(login, &env.dbx)
        .await
        .context(h!())?;
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

#[post("/api/palitra/v2/read/{palitra_id}")]
pub async fn read_palitra_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraReadV2>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra_id = path.into_inner();
    let palitra = bl::read_palitra_v2(login, palitra_id, &env.dbx)
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

#[post("/api/palitra/archive/{palitra_id}")]
pub async fn archive_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra_id = path.into_inner();
    let palitra = bl::update_accessible_palitra_archive_flag(
        login, palitra_id, true, &env.dbx, &txn,
    )
    .await
    .c(h!())?
    .ok_or_else(|| {
        AppError::Forbidden(format!(
            "Palitra {palitra_id} is not accessible for archiving"
        ))
    })?;
    txn.commit().await.c(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/unarchive/{palitra_id}")]
pub async fn unarchive_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra_id = path.into_inner();
    let palitra = bl::update_accessible_palitra_archive_flag(
        login, palitra_id, false, &env.dbx, &txn,
    )
    .await
    .c(h!())?
    .ok_or_else(|| {
        AppError::Forbidden(format!(
            "Palitra {palitra_id} is not accessible for unarchiving"
        ))
    })?;
    txn.commit().await.c(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/folder/assign")]
pub async fn assign_palitra_folder(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraFolderAssignReq>,
) -> Result<Json<PalitraBulkActionRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let req = req.into_inner();
    let palitra_ids = bl::assign_folder_to_accessible_palitras(
        login,
        req.palitra_ids,
        req.folder,
        &env.dbx,
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(PalitraBulkActionRsp { palitra_ids }))
}

#[post("/api/palitra/folder/rename")]
pub async fn rename_palitra_folder(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraFolderRenameReq>,
) -> Result<Json<PalitraBulkActionRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let req = req.into_inner();
    let palitra_ids = bl::rename_accessible_palitra_folder(
        login,
        req.from_folder,
        req.to_folder,
        &env.dbx,
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(PalitraBulkActionRsp { palitra_ids }))
}

#[post("/api/palitra/folder/archive")]
pub async fn archive_palitra_folder(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraFolderReq>,
) -> Result<Json<PalitraBulkActionRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra_ids = bl::archive_accessible_palitra_folder(
        login,
        req.into_inner().folder,
        true,
        &env.dbx,
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(PalitraBulkActionRsp { palitra_ids }))
}

#[post("/api/palitra/folder/delete")]
pub async fn delete_palitra_folder(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraFolderReq>,
) -> Result<Json<PalitraBulkActionRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra_ids = bl::collect_accessible_palitra_ids_in_folder(
        login.clone(),
        req.into_inner().folder,
        &txn,
    )
    .await
    .c(h!())?;
    let mut deleted_palitra_ids = Vec::new();
    for palitra_id in &palitra_ids {
        let palitra = palitra::Entity::find_by_id(*palitra_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .c(h!())?;
        let is_author_or_admin =
            is_palitra_author_or_admin(&env.dbx, &login, &palitra)
                .await
                .c(h!())?;
        if !is_author_or_admin {
            continue;
        }
        let existing_access =
            read_palitra_access(&env.dbx, *palitra_id).await.c(h!())?;
        bl::delete_palitra(*palitra_id, &txn, existing_access, &env)
            .await
            .c(h!())?;
        deleted_palitra_ids.push(*palitra_id);
    }
    txn.commit().await.c(h!())?;
    for palitra_id in &deleted_palitra_ids {
        env.palitra_worker_context.flush_cache(*palitra_id).await;
    }
    Ok(Json(PalitraBulkActionRsp {
        palitra_ids: deleted_palitra_ids,
    }))
}

#[post("/api/palitra/download")]
pub async fn download_palitras(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraDownloadReq>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra_ids = req
        .into_inner()
        .palitra_ids
        .into_iter()
        .unique()
        .collect_vec();
    if palitra_ids.len() > crate::config::PALITRA_DOWNLOAD_MAX_FILES {
        return Err(AppError::BL {
            msg: format!(
                "Too many palitras requested: {}, max is {}",
                palitra_ids.len(),
                crate::config::PALITRA_DOWNLOAD_MAX_FILES
            ),
        });
    }
    let palitras =
        bl::collect_downloadable_palitra_files(login, palitra_ids, &env.dbx)
            .await
            .c(h!())?;

    let strongbox_key = env
        .config
        .s3_config
        .as_ref()
        .map(|config| config.strongbox_key.clone())
        .unwrap_or_default();
    let zip_file = tempfile::tempfile().c(h!())?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(zip_file));
    let options: FileOptions<zip::write::ExtendedFileOptions> =
        FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
    let mut used_file_names = HashSet::new();
    let mut total_bytes = 0u64;

    for (palitra, geometry) in palitras {
        let Some(s3_id) = palitra.s3_id.as_deref() else {
            continue;
        };
        let bytes = crate::storage::download_and_decrypt_from_s3_with_operator(
            &env.s3,
            &env.s3_config,
            &strongbox_key,
            s3_id,
        )
        .await
        .c(h!())?;
        if bytes.is_empty() {
            continue;
        }
        let file_bytes = bytes.len() as u64;
        if file_bytes > crate::config::PALITRA_DOWNLOAD_MAX_FILE_BYTES {
            return Err(AppError::BL {
                msg: format!(
                    "Palitra file is too large to download in one request: palitra_id={}, bytes={}, max={}",
                    palitra.id,
                    file_bytes,
                    crate::config::PALITRA_DOWNLOAD_MAX_FILE_BYTES
                ),
            });
        }
        total_bytes = total_bytes.saturating_add(file_bytes);
        if total_bytes > crate::config::PALITRA_DOWNLOAD_MAX_TOTAL_BYTES {
            return Err(AppError::BL {
                msg: format!(
                    "Requested palitra download is too large: bytes={}, max={}",
                    total_bytes,
                    crate::config::PALITRA_DOWNLOAD_MAX_TOTAL_BYTES
                ),
            });
        }
        let file_name = ensure_unique_zip_entry_name(
            &mut used_file_names,
            bl::build_palitra_download_file_name(&palitra, geometry.as_ref()),
        );
        zip.start_file(file_name, options.clone()).c(h!())?;
        zip.write_all(&bytes).c(h!())?;
    }

    let mut zip_file = zip.finish().c(h!())?.into_inner().c(h!())?;
    let zip_size = zip_file.metadata().c(h!())?.len();
    zip_file.rewind().c(h!())?;
    let stream = ReaderStream::new(tokio::fs::File::from_std(zip_file));
    let archive_name =
        format!("palitras_{}.zip", Utc::now().format("%Y%m%dT%H%M%SZ"));
    Ok(HttpResponse::Ok()
        .content_type("application/zip")
        .insert_header((
            "Content-Disposition",
            format!("attachment; filename=\"{archive_name}\""),
        ))
        .insert_header(("Content-Length", zip_size.to_string()))
        .streaming(stream))
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
    let is_author_or_admin =
        is_palitra_author_or_admin(&env.dbx, &login, &palitra)
            .await
            .c(h!())?;
    if !is_author_or_admin {
        return Err(AppError::Forbidden(
            "Only author or Admin may update palitra".into(),
        ));
    }
    let result = bl::update_palitra(palitra.id, req, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(result))
}

#[post("/api/palitra/v2/update/{palitra_id}")]
pub async fn update_palitra_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdatePalitraV2Req>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraReadV2>, AppError> {
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
    let is_author_or_admin =
        is_palitra_author_or_admin(&env.dbx, &login, &palitra)
            .await
            .c(h!())?;
    if !is_author_or_admin {
        return Err(AppError::Forbidden(
            "Only author or Admin may update palitra".into(),
        ));
    }
    let result = bl::update_palitra_v2(palitra.id, req, &txn).await.c(h!())?;
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
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_author_or_admin =
        is_palitra_author_or_admin(&env.dbx, &login, &palitra)
            .await
            .c(h!())?;
    if !is_author_or_admin {
        return Err(AppError::Forbidden(
            "Only author or Admin may delete palitra".into(),
        ));
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;

    bl::delete_palitra(palitra.id, &txn, existing_access, &env)
        .await
        .c(h!())?; //deletes with all geometries, TODO add method for drop one geometry only
    txn.commit().await.c(h!())?;
    env.palitra_worker_context.flush_cache(palitra_id).await;
    Ok(Json(()))
}

async fn parse_create_palitra_multipart(
    payload: &mut Multipart,
) -> Result<CreatePalitraMultipartPayload, AppError> {
    let mut name: Option<String> = None;
    let mut color_hex: Option<String> = None;
    let mut access_type: Option<String> = None;
    let mut access_values: Option<String> = None;
    let mut kmz_file: Option<(String, Vec<u8>)> = None;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|e| AppError::BL {
            msg: format!("Multipart error: {e:?}"),
        })?;
        let field_name = field
            .content_disposition()
            .and_then(|cd| cd.get_name())
            .map(|s| s.to_string())
            .unwrap_or_default();

        match field_name.as_str() {
            "name" => {
                let bytes = read_multipart_field_bytes(&mut field).await?;
                name = Some(String::from_utf8(bytes).c(h!())?);
            }
            "color_hex" => {
                let bytes = read_multipart_field_bytes(&mut field).await?;
                color_hex = Some(String::from_utf8(bytes).c(h!())?);
            }
            "access_type" => {
                let bytes = read_multipart_field_bytes(&mut field).await?;
                access_type = Some(String::from_utf8(bytes).c(h!())?);
            }
            "access_values" => {
                let bytes = read_multipart_field_bytes(&mut field).await?;
                access_values = Some(String::from_utf8(bytes).c(h!())?);
            }
            "kmz" => {
                let raw_filename = field
                    .content_disposition()
                    .and_then(|cd| cd.get_filename())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "file.kmz".to_string());
                let filename = kmz::sanitize_upload_filename(&raw_filename);
                let kmz_data = read_multipart_field_bytes(&mut field).await?;
                kmz_file = Some((filename, kmz_data));
            }
            _ => {
                // Consume unknown fields to keep multipart stream in sync.
                let _ = read_multipart_field_bytes(&mut field).await?;
            }
        }
    }

    let name = name.c(h!())?;
    let access_type = access_type.c(h!())?;
    let access_values = access_values.unwrap_or_default();
    let (filename, kmz_data) = kmz_file.c(h!())?;
    Ok(CreatePalitraMultipartPayload {
        name,
        color_hex,
        access_type,
        access_values,
        filename,
        kmz_data,
    })
}

async fn read_multipart_field_bytes(
    field: &mut Field,
) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.next().await {
        let chunk = chunk.map_err(|e| AppError::BL {
            msg: format!("Field read error: {e:?}"),
        })?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn normalize_color_hex_or_fallback(color_hex: Option<String>) -> String {
    let normalized = color_hex.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized.is_empty() {
        crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string()
    } else {
        normalized
    }
}

fn group_palitra_points_by_color(
    points: Vec<PalitraPoint>,
) -> BTreeMap<String, Vec<PalitraPoint>> {
    let mut grouped: BTreeMap<String, Vec<PalitraPoint>> = BTreeMap::new();
    for mut point in points {
        let color_hex = normalize_color_hex_or_fallback(point.color.take());
        point.color = Some(color_hex.clone());
        grouped.entry(color_hex).or_default().push(point);
    }
    grouped
}

fn remap_fallback_color<T>(
    grouped: &mut BTreeMap<String, Vec<T>>,
    fallback_color_hex: &str,
    replacement_color_hex: &str,
) {
    if fallback_color_hex == replacement_color_hex {
        return;
    }
    let mut values = match grouped.remove(fallback_color_hex) {
        Some(values) => values,
        None => return,
    };
    grouped
        .entry(replacement_color_hex.to_string())
        .or_default()
        .append(&mut values);
}

fn pick_primary_color_hex(
    points_by_color: &BTreeMap<String, Vec<PalitraPoint>>,
    line_strings_by_color: &BTreeMap<String, Vec<kmz::PalitraLineString>>,
) -> String {
    let mut selected_color_hex: Option<String> = None;
    let mut selected_count = 0usize;
    for (color_hex, points) in points_by_color {
        let points_count = points.len();
        if points_count > selected_count {
            selected_count = points_count;
            selected_color_hex = Some(color_hex.clone());
        }
    }
    for (color_hex, line_strings) in line_strings_by_color {
        let line_strings_count = line_strings.len();
        if line_strings_count > selected_count {
            selected_count = line_strings_count;
            selected_color_hex = Some(color_hex.clone());
        }
    }
    selected_color_hex.unwrap_or_else(|| {
        crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string()
    })
}

fn group_palitra_lines_by_color(
    line_strings: Vec<kmz::PalitraLineString>,
) -> BTreeMap<String, Vec<kmz::PalitraLineString>> {
    let mut grouped: BTreeMap<String, Vec<kmz::PalitraLineString>> =
        BTreeMap::new();
    for mut line_string in line_strings {
        let color_hex =
            normalize_color_hex_or_fallback(line_string.color.take());
        line_string.color = Some(color_hex.clone());
        grouped.entry(color_hex).or_default().push(line_string);
    }
    grouped
}

async fn upsert_palitra_geometry_by_color(
    txn: &DatabaseTransaction,
    palitra_id: i64,
    color_hex: &str,
    source_file_name: &str,
    uploaded_at: NaiveDateTime,
) -> anyhow::Result<palitra_geometry::Model> {
    let color_hex =
        normalize_color_hex_or_fallback(Some(color_hex.to_string()));
    let palitra_geometry = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Hex.eq(color_hex.clone()))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .order_by_desc(palitra_geometry::Column::UpdatedAt)
        .order_by_desc(palitra_geometry::Column::Id)
        .one(txn)
        .await
        .c(h!())?;
    if let Some(palitra_geometry) = palitra_geometry {
        let mut palitra_geometry = palitra_geometry.into_active_model();
        palitra_geometry.source_file_name =
            Set(Some(source_file_name.to_string()));
        palitra_geometry.last_uploaded_at = Set(Some(uploaded_at));
        palitra_geometry.updated_at = Set(Utc::now().naive_utc());
        return palitra_geometry.update(txn).await.c(h!());
    }
    palitra_geometry::ActiveModel {
        id: NotSet,
        palitra_id: Set(palitra_id),
        hex: Set(color_hex),
        source_file_name: Set(Some(source_file_name.to_string())),
        deleted: NotSet,
        created_at: NotSet,
        last_uploaded_at: Set(Some(uploaded_at)),
        updated_at: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())
}

async fn render_created_palitra_response(
    dbx: &DatabaseConnection,
    palitra_id: i64,
) -> anyhow::Result<Palitra> {
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let palitra_geometry =
        read_latest_palitra_geometry_with_warning(dbx, palitra_id)
            .await
            .c(h!())?;
    Ok(Palitra {
        id: palitra.id,
        name: palitra.name,
        folder: bl::normalize_palitra_folder_from_db(palitra.folder),
        is_archived: palitra.is_archived,
        color_hex: palitra_geometry.hex,
        author: palitra.author,
        source_file_name: palitra_geometry.source_file_name,
        last_uploaded_at_ts: palitra_geometry
            .last_uploaded_at
            .map(|ts| ts.and_utc().timestamp_millis()),
        geometry: None,
        access_aor_id: bl::collect_palitra_access_aors(dbx, palitra_id)
            .await
            .c(h!())?,
        access_organism_ids: bl::collect_palitra_access_organisms(
            dbx, palitra_id,
        )
        .await
        .c(h!())?,
        access_logins: bl::collect_palitra_access_logins(dbx, palitra_id)
            .await
            .c(h!())?,
    })
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
                let permitted_logins =
                    crate::users::get_organism_logins_by_login(&env.dbx, login)
                        .await
                        .c(h!())?;
                let all_known =
                    logins.iter().all(|value| permitted_logins.contains(value));
                if !all_known {
                    bail!(
                        "Editor may only manage palitra scoped to own organism logins"
                    );
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

async fn read_latest_palitra_geometry_with_warning<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<palitra_geometry::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .order_by_desc(palitra_geometry::Column::UpdatedAt)
        .order_by_desc(palitra_geometry::Column::Id)
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())
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
    let direct_aor_ids = organism_aors.iter().map(|o| o.aor_id).collect_vec();
    let aor_ids = crate::sigint::aor::bl::expand_aor_ids_to_descendants(
        dbx,
        &direct_aor_ids,
    )
    .await
    .c(h!())?
    .into_iter()
    .collect_vec();
    Ok(UserScope {
        organism_ids,
        aor_ids,
    })
}

async fn is_palitra_author_or_admin(
    dbx: &DatabaseConnection,
    login: &str,
    palitra: &palitra::Model,
) -> anyhow::Result<bool> {
    let is_admin = crate::users::has_role(dbx, login, "Admin").await.is_ok();
    Ok(is_admin || palitra.author.as_deref() == Some(login))
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
        crate::organism::goi::goi_upload_file_loose(
            target,
            remote_file_path,
            file_data.clone(),
        )
        .await;
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
        crate::organism::goi::goi_delete_file_loose(target, remote_file_path)
            .await;
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

    let integrations = goi_integration::Entity::find()
        .filter(
            goi_integration::Column::OwnerOrganismId
                .is_in(organism_ids.to_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?;

    let mut goi_targets = Vec::with_capacity(integrations.len());
    for integration in integrations {
        let integration_id = integration.id;
        let ssh_host = integration
            .ssh_host
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let ssh_user = integration
            .ssh_user
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let Some(ssh_host) = ssh_host else { continue };
        let Some(ssh_user) = ssh_user else { continue };

        let path = normalize_trimmed_or_default(
            integration.path.clone(),
            ORGANISM_GOI_PATH_DEFAULT,
        );
        if path.trim().is_empty() {
            continue;
        }

        let ssh_port = if integration.ssh_port > 0 {
            integration.ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        };

        let req = CheckOrganismGoiConnectionReq {
            ssh_host,
            ssh_user,
            ssh_port,
            path,
        };
        match goi_validate_connection_req(&req) {
            Ok(()) => goi_targets.push(req),
            Err(err) => {
                log::warn!(
                    "Skipping GOI sync target for integration {} ({}): {err:#}",
                    integration_id,
                    goi_integration_web_host(&integration).unwrap_or_default()
                );
            }
        }
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

fn ensure_unique_zip_entry_name(
    used_file_names: &mut HashSet<String>,
    file_name: String,
) -> String {
    if used_file_names.insert(file_name.clone()) {
        return file_name;
    }
    let path = Path::new(&file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("palitra");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 1.. {
        let candidate = if extension.is_empty() {
            format!("{stem}_{index}")
        } else {
            format!("{stem}_{index}.{extension}")
        };
        if used_file_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("zip entry deduplication loop must terminate");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_points_by_normalized_color_with_fallback() {
        let points = vec![
            PalitraPoint {
                coords: Coords {
                    lat: 50.0,
                    lng: 30.0,
                },
                label: Some("A".to_string()),
                color: Some(" #AABBCC ".to_string()),
            },
            PalitraPoint {
                coords: Coords {
                    lat: 50.1,
                    lng: 30.1,
                },
                label: Some("B".to_string()),
                color: Some("#aabbcc".to_string()),
            },
            PalitraPoint {
                coords: Coords {
                    lat: 50.2,
                    lng: 30.2,
                },
                label: Some("C".to_string()),
                color: None,
            },
        ];
        let grouped = group_palitra_points_by_color(points);
        assert_eq!(grouped.get("#aabbcc").map(Vec::len), Some(2));
        assert_eq!(
            grouped
                .get(crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn picks_primary_color_by_largest_group() {
        let grouped = BTreeMap::from([
            (
                "#111111".to_string(),
                vec![PalitraPoint {
                    coords: Coords { lat: 1.0, lng: 1.0 },
                    label: None,
                    color: Some("#111111".to_string()),
                }],
            ),
            (
                "#222222".to_string(),
                vec![
                    PalitraPoint {
                        coords: Coords { lat: 2.0, lng: 2.0 },
                        label: None,
                        color: Some("#222222".to_string()),
                    },
                    PalitraPoint {
                        coords: Coords { lat: 2.1, lng: 2.1 },
                        label: None,
                        color: Some("#222222".to_string()),
                    },
                ],
            ),
        ]);
        let line_strings = BTreeMap::new();
        assert_eq!(
            pick_primary_color_hex(&grouped, &line_strings),
            "#222222".to_string()
        );
    }
}

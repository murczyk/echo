use crate::config::{
    ORGANISM_GOI_INTEGRATION_TYPE_FULL, PALITRA_ALLOWED_UPLOAD_EXTENSIONS,
    PALITRA_BLOCKED_UNSTABLE_UPLOAD_EXTENSIONS,
    PALITRA_CONVERSION_JOB_STATUS_PENDING, PALITRA_CONVERSION_STATUS_ERROR,
    PALITRA_CONVERSION_STATUS_PROCESSING, PALITRA_CONVERSION_STATUS_READY,
    PALITRA_DIRECT_PARSE_EXTENSIONS, PALITRA_GOI_REMOTE_STATUS_PRESENT,
    PALITRA_GOI_SYNC_DIRECTION_GOI, PALITRA_GOI_SYNC_JOB_KIND_DELETE,
    PALITRA_GOI_SYNC_JOB_KIND_MOVE, PALITRA_GOI_SYNC_JOB_KIND_UPLOAD,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::organism::goi::goi_api::GoiApiTarget;
use crate::palitra::bl::{
    palitra_search_cache_key, palitra_suggest_cache_key, read_cached_json,
    write_cached_json,
};
use crate::palitra::types::*;
use crate::types::*;
use crate::users::{ensure_rer_role, has_role, login_id_from_identity};
use crate::utils::multipart;
use actix_multipart::{Field, Multipart};
use actix_web::post;
use actix_web::web::{Data, Json};
use actix_web::HttpResponse;
use anyhow::{bail, Context};
use chrono::{NaiveDateTime, Utc};
use futures_util::StreamExt;
use itertools::{Either, Itertools};
use sea_orm::prelude::Expr;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{BufWriter, Seek, Write};
use std::path::Path;
use tempfile::tempdir;
use tokio_util::io::ReaderStream;
use zip::write::FileOptions;

pub(crate) mod bl;
pub mod conversion_worker;
mod download;
pub(crate) mod goi_changelog;
pub mod goi_sync_worker;
mod kmz;
pub mod oneoff;
pub mod types;
pub mod worker;

pub use download::download_palitras_delta_split;

const GOI_OWNED_PALITRA_EDIT_ERROR: &str = "Редагуйте цю палітру в ГОІ";

#[derive(Debug, FromQueryResult)]
struct GoiSourceConversionRetryCandidate {
    id: i64,
    direction: String,
    remote_status: String,
    goi_source_file_sha256: Option<String>,
    changelog: serde_json::Value,
    has_goi_source_file_data: bool,
}

#[derive(Clone)]
struct UserScope {
    organism_ids: Vec<i64>,
}

struct ConnectedGoiTarget {
    integration_id: i64,
    api: GoiApiTarget,
    disable_goi_to_echo_palitra_sync: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct GoiMoveTask {
    palitra_id: i64,
    source_file_names: Vec<String>,
    target_file_name: String,
    target_folder: Option<String>,
    source_folder_hint: Option<String>,
    tracked_source_relative_path: Option<String>,
}

struct CreatePalitraMultipartPayload {
    name: String,
    color_hex: Option<String>,
    access_type: String,
    access_values: String,
    filename: String,
    file_data: Vec<u8>,
    content_type: Option<String>,
    extension: String,
}

#[post("/api/palitra/create-with-kmz")]
pub async fn create_palitra_with_kmz(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<Palitra>, AppError> {
    let login = login_id_from_identity(&user)?;
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
    let palitra = bl::create_palitra(login, req, &env.dbx).await.c(h!())?;
    if !is_direct_palitra_upload_extension(&multipart_payload.extension) {
        schedule_palitra_conversion(
            &env.dbx,
            palitra.id,
            multipart_payload.filename,
            multipart_payload.extension,
            multipart_payload.content_type,
            multipart_payload.file_data,
        )
        .await
        .c(h!())?;
        let palitra_response =
            render_created_palitra_response(&env.dbx, palitra.id)
                .await
                .c(h!())?;
        return Ok(Json(palitra_response));
    }

    // Upload points from KMZ in a separate transaction
    let txn = env.dbx.begin().await.c(h!())?;
    let upload = kmz::load_coordinates_from_file(
        multipart_payload.filename.clone(),
        multipart_payload.file_data.clone(),
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

    txn.commit().await.c(h!())?;
    update_palitra_conversion_status(
        &env.dbx,
        palitra.id,
        PALITRA_CONVERSION_STATUS_READY,
        Some(multipart_payload.extension.clone()),
        None,
        None,
    )
    .await
    .c(h!())?;
    schedule_palitra_goi_upload(
        &env.dbx,
        palitra.id,
        multipart_payload.file_data,
    )
    .await
    .c(h!())?;
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
    let login = login_id_from_identity(&user)?;
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
    if !is_direct_palitra_upload_extension(&multipart_payload.extension) {
        let req = CreatePalitraReq {
            name: multipart_payload.name,
            color_hex: normalize_color_hex_or_fallback(
                multipart_payload.color_hex.clone(),
            ),
            access,
            source_file_name: Some(multipart_payload.filename.clone()),
            last_uploaded_at_ts: Some(uploaded_at.timestamp_millis()),
        };
        let palitra = bl::create_palitra(login, req, &env.dbx).await.c(h!())?;
        schedule_palitra_conversion(
            &env.dbx,
            palitra.id,
            multipart_payload.filename,
            multipart_payload.extension,
            multipart_payload.content_type,
            multipart_payload.file_data,
        )
        .await
        .c(h!())?;
        let palitra_response =
            render_created_palitra_response(&env.dbx, palitra.id)
                .await
                .c(h!())?;
        return Ok(Json(palitra_response));
    }
    let upload = kmz::load_coordinates_from_file(
        multipart_payload.filename.clone(),
        multipart_payload.file_data.clone(),
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
        let palitra = bl::create_palitra(login, req, &txn).await.c(h!())?;
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

    txn.commit().await.c(h!())?;
    for palitra_id in &created_palitra_ids {
        update_palitra_conversion_status(
            &env.dbx,
            *palitra_id,
            PALITRA_CONVERSION_STATUS_READY,
            Some(multipart_payload.extension.clone()),
            None,
            None,
        )
        .await
        .c(h!())?;
        schedule_palitra_goi_upload(
            &env.dbx,
            *palitra_id,
            multipart_payload.file_data.clone(),
        )
        .await
        .c(h!())?;
    }

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
    let login = login_id_from_identity(&user)?;
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
    if !is_direct_palitra_upload_extension(&multipart_payload.extension) {
        let color_hex = normalize_color_hex_or_fallback(
            multipart_payload.color_hex.clone(),
        );
        let req = CreatePalitraReq {
            name: multipart_payload.name,
            color_hex,
            access,
            source_file_name: Some(multipart_payload.filename.clone()),
            last_uploaded_at_ts: Some(uploaded_at.timestamp_millis()),
        };
        let palitra = bl::create_palitra(login, req, &env.dbx).await.c(h!())?;
        schedule_palitra_conversion(
            &env.dbx,
            palitra.id,
            multipart_payload.filename,
            multipart_payload.extension,
            multipart_payload.content_type,
            multipart_payload.file_data,
        )
        .await
        .c(h!())?;
        let palitra_response =
            render_created_palitra_response(&env.dbx, palitra.id)
                .await
                .c(h!())?;
        return Ok(Json(palitra_response));
    }
    let upload = kmz::load_coordinates_from_file(
        multipart_payload.filename.clone(),
        multipart_payload.file_data.clone(),
        &env,
    )
    .await
    .c(h!())?;
    let mut points_by_color = group_palitra_points_by_color(upload.points);
    let mut line_strings_by_color =
        group_palitra_lines_by_color(upload.line_strings);
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

    txn.commit().await.c(h!())?;
    update_palitra_conversion_status(
        &env.dbx,
        palitra.id,
        PALITRA_CONVERSION_STATUS_READY,
        Some(multipart_payload.extension.clone()),
        None,
        None,
    )
    .await
    .c(h!())?;
    schedule_palitra_goi_upload(
        &env.dbx,
        palitra.id,
        multipart_payload.file_data,
    )
    .await
    .c(h!())?;

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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;

    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let raw_filename = field
        .content_disposition()
        .and_then(|cd| cd.get_filename().map(|s| s.to_string()))
        .unwrap_or_else(|| "file.kmz".to_string());
    let filename = kmz::sanitize_upload_filename(&raw_filename);

    let extension = validate_palitra_upload_filename(&filename).c(h!())?;
    let name_without_ext = Path::new(&filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&filename)
        .to_string();
    if !is_direct_palitra_upload_extension(&extension) {
        return Ok(Json(AnalyzeKmzResponse {
            top_colors: vec![],
            filename: name_without_ext,
        }));
    }

    // Save to temporary directory for analysis
    let tmp_dir = tempdir().c(h!())?;
    let tmp_path = tmp_dir.path().join(&filename);
    tokio::fs::write(&tmp_path, val).await.c(h!())?;

    let top_colors = match extension.as_str() {
        "kmz" => kmz::extract_top_colors_from_kmz(&tmp_path).await.c(h!())?,
        "kml" => kmz::extract_top_colors_from_kml(&tmp_path).await.c(h!())?,
        _ => vec![],
    };

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
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
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
    ensure_palitra_echo_edit_allowed(&env.dbx, palitra_id).await?;
    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let raw_filename = field
        .content_disposition()
        .and_then(|cd| cd.get_filename().map(str::to_string))
        .or_else(|| field.name().map(str::to_string))
        .unwrap_or_else(|| "file.kmz".to_string());
    let filename = kmz::sanitize_upload_filename(&raw_filename);
    let content_type = field.content_type().map(|ct| ct.to_string());
    let extension = validate_palitra_upload_filename(&filename).c(h!())?;
    let raw_file_data = val;
    if !is_direct_palitra_upload_extension(&extension) {
        let txn = env.dbx.begin().await.c(h!())?;
        schedule_palitra_replacement_conversion_with_goi_upload(
            &txn,
            palitra.id,
            filename,
            extension,
            content_type,
            raw_file_data,
            true,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        env.palitra_worker_context.flush_cache(palitra_id).await;
        return Ok(Json(()));
    }
    replace_existing_palitra_with_direct_file(
        env.as_ref(),
        &palitra,
        filename,
        extension,
        raw_file_data,
    )
    .await
    .c(h!())?;
    env.palitra_worker_context.flush_cache(palitra_id).await;

    Ok(Json(()))
}

pub(crate) async fn replace_existing_palitra_with_direct_file(
    env: &Env,
    palitra: &palitra::Model,
    filename: String,
    extension: String,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    let upload = kmz::load_coordinates_from_file(
        filename.clone(),
        file_data.clone(),
        env,
    )
    .await
    .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    cancel_palitra_conversion(&txn, palitra.id).await.c(h!())?;
    apply_loaded_palitra_file_to_existing_palitra(
        env, &txn, palitra, &filename, upload, None,
    )
    .await
    .c(h!())?;
    update_palitra_conversion_status(
        &txn,
        palitra.id,
        PALITRA_CONVERSION_STATUS_READY,
        Some(extension),
        None,
        None,
    )
    .await
    .c(h!())?;
    schedule_palitra_goi_upload(&txn, palitra.id, file_data)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn apply_loaded_palitra_file_to_existing_palitra(
    env: &Env,
    txn: &DatabaseTransaction,
    palitra: &palitra::Model,
    filename: &str,
    upload: kmz::PalitraKmzData,
    fallback_replacement_color_hex: Option<&str>,
) -> anyhow::Result<()> {
    let mut points_by_color = group_palitra_points_by_color(upload.points);
    let mut line_strings_by_color =
        group_palitra_lines_by_color(upload.line_strings);
    remap_fallback_geometry_color(
        &mut points_by_color,
        &mut line_strings_by_color,
        fallback_replacement_color_hex,
    );
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
    let existing_palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    let mut retained_geometry_ids: HashSet<i64> = HashSet::new();
    for color_hex in geometry_colors {
        let palitra_geometry = upsert_palitra_geometry_by_color(
            txn,
            palitra.id,
            &color_hex,
            filename,
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
            txn,
            &env.rq,
        )
        .await
        .c(h!())?;
        bl::rewrite_palitra_line_strings(
            palitra_geometry.id,
            color_line_strings,
            txn,
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
        bl::soft_delete_palitra_geometry(stale_geometry_id, txn)
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
    bl::update_palitra_s3_id(txn, palitra.id, upload.s3_id)
        .await
        .c(h!())?;

    Ok(())
}

#[post("/api/palitra/retry-conversion/{palitra_id}")]
pub async fn retry_palitra_conversion(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<Palitra>, AppError> {
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
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
            "Only author or Admin may retry palitra conversion".into(),
        ));
    }
    let job = palitra_conversion_job::Entity::find()
        .filter(palitra_conversion_job::Column::PalitraId.eq(palitra_id))
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    if job.file_data.is_none() {
        return Err(AppError::BL {
            msg: "Cannot retry palitra conversion: source file data is not available".to_string(),
        });
    }
    let source_format = job.source_format.clone();
    let mut job = job.into_active_model();
    job.status = Set(PALITRA_CONVERSION_JOB_STATUS_PENDING.to_string());
    job.last_attempt_at = Set(None);
    job.last_error = Set(None);
    job.update(&env.dbx).await.c(h!())?;
    update_palitra_conversion_status(
        &env.dbx,
        palitra_id,
        PALITRA_CONVERSION_STATUS_PROCESSING,
        Some(source_format),
        None,
        None,
    )
    .await
    .c(h!())?;
    env.palitra_worker_context.flush_cache(palitra_id).await;
    let palitra_response =
        render_created_palitra_response(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    Ok(Json(palitra_response))
}

#[post("/api/palitra/retry-goi-source-conversion/{palitra_id}")]
pub async fn retry_goi_source_conversion(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<Palitra>, AppError> {
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let palitra_id = path.into_inner();
    palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_admin = is_palitra_admin(&env, &login).await.c(h!())?;
    let is_accessible = if is_admin {
        true
    } else {
        bl::collect_accessible_palitra_ids(login, &env.dbx)
            .await
            .c(h!())?
            .contains(&palitra_id)
    };
    if !is_accessible {
        return Err(AppError::Forbidden(
            "Palitra is not accessible for GOI source conversion retry".into(),
        ));
    }
    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::Direction
                .eq(PALITRA_GOI_SYNC_DIRECTION_GOI),
        )
        .filter(
            goi_palitra_sync::Column::RemoteStatus
                .eq(PALITRA_GOI_REMOTE_STATUS_PRESENT),
        )
        .filter(goi_palitra_sync::Column::GoiSourceFileSha256.is_not_null())
        .select_only()
        .column(goi_palitra_sync::Column::Id)
        .column(goi_palitra_sync::Column::Direction)
        .column(goi_palitra_sync::Column::RemoteStatus)
        .column(goi_palitra_sync::Column::GoiSourceFileSha256)
        .column(goi_palitra_sync::Column::Changelog)
        .column_as(
            Expr::col((
                goi_palitra_sync::Entity,
                goi_palitra_sync::Column::GoiSourceFileData,
            ))
            .is_not_null(),
            "has_goi_source_file_data",
        )
        .order_by_desc(goi_palitra_sync::Column::UpdatedAt)
        .order_by_desc(goi_palitra_sync::Column::Id)
        .into_model::<GoiSourceConversionRetryCandidate>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let row_id = select_goi_source_conversion_retry_row_id(rows)
        .ok_or_else(goi_source_conversion_retry_unavailable_error)?;
    let row = goi_palitra_sync::Entity::find_by_id(row_id)
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::Direction
                .eq(PALITRA_GOI_SYNC_DIRECTION_GOI),
        )
        .filter(
            goi_palitra_sync::Column::RemoteStatus
                .eq(PALITRA_GOI_REMOTE_STATUS_PRESENT),
        )
        .filter(goi_palitra_sync::Column::GoiSourceFileData.is_not_null())
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(goi_source_conversion_retry_unavailable_error)?;
    let filename = row.goi_source_file_name.clone().c(h!())?;
    let extension = row.goi_source_format.clone().c(h!())?;
    let file_data = row.goi_source_file_data.clone().c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    schedule_palitra_goi_source_conversion(
        &txn,
        palitra_id,
        filename,
        extension,
        row.goi_source_content_type,
        file_data,
    )
    .await
    .c(h!())?;
    goi_changelog::append_for_palitra_goi_source_row_ids(
        &txn,
        &[row.id],
        goi_changelog::ok_entry(
            "GOI source conversion retry queued",
            "Повторну конвертацію файлу ГОІ поставлено в чергу.",
        ),
    )
    .await
    .c(h!())?;
    goi_palitra_sync::Entity::update_many()
        .filter(goi_palitra_sync::Column::Id.eq(row.id))
        .col_expr(
            goi_palitra_sync::Column::GoiSourceLastRetryAt,
            Expr::value(Some(Utc::now().fixed_offset())),
        )
        .exec(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    env.palitra_worker_context.flush_cache(palitra_id).await;
    let palitra_response =
        render_created_palitra_response(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    Ok(Json(palitra_response))
}

fn goi_source_conversion_retry_unavailable_error() -> AppError {
    AppError::BL {
        msg: "Cannot retry GOI source conversion: failed source file data is not available"
            .to_string(),
    }
}

fn select_goi_source_conversion_retry_row_id(
    rows: Vec<GoiSourceConversionRetryCandidate>,
) -> Option<i64> {
    rows.into_iter()
        .find(|row| {
            is_goi_source_conversion_retry_candidate(
                &row.direction,
                &row.remote_status,
                row.goi_source_file_sha256.as_deref(),
                row.has_goi_source_file_data,
                &row.changelog,
            )
        })
        .map(|row| row.id)
}

#[cfg(test)]
fn select_goi_source_conversion_retry_row(
    rows: Vec<goi_palitra_sync::Model>,
) -> Option<goi_palitra_sync::Model> {
    rows.into_iter().find(|row| {
        is_goi_source_conversion_retry_candidate(
            &row.direction,
            &row.remote_status,
            row.goi_source_file_sha256.as_deref(),
            row.goi_source_file_data.is_some(),
            &row.changelog,
        )
    })
}

fn is_goi_source_conversion_retry_candidate(
    direction: &str,
    remote_status: &str,
    goi_source_file_sha256: Option<&str>,
    has_goi_source_file_data: bool,
    changelog: &serde_json::Value,
) -> bool {
    if direction != PALITRA_GOI_SYNC_DIRECTION_GOI
        || remote_status != PALITRA_GOI_REMOTE_STATUS_PRESENT
        || goi_source_file_sha256.is_none()
        || !has_goi_source_file_data
    {
        return false;
    }
    let changelog = goi_changelog::entries_from_value(changelog);
    goi_changelog::latest_goi_source_conversion_warning(&changelog)
}

#[post("/api/palitra/list")]
pub async fn list_all_palitras(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<Palitra>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra = bl::list_all_palitras(login, &env.dbx).await.context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/v2/list")]
pub async fn list_all_palitras_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraReadV2>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra = bl::list_all_palitras_v2(login, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/v2/list-map")]
pub async fn list_map_palitras_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraReadV2>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra = bl::list_map_palitras_v2(login, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/list-detailed")] // TODO implement filter
pub async fn list_all_palitras_detailed(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraDetails>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra = bl::list_all_palitras_detailed(login, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/goi-sync-history/{palitra_id}")]
pub async fn read_palitra_goi_sync_history(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<Vec<PalitraChangelogEntry>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra_id = path.into_inner();
    let is_admin = is_palitra_admin(&env, &login).await.c(h!())?;
    let is_accessible = if is_admin {
        true
    } else {
        bl::collect_accessible_palitra_ids(login, &env.dbx)
            .await
            .c(h!())?
            .contains(&palitra_id)
    };
    if !is_accessible {
        return Err(AppError::Forbidden(
            "Palitra is not accessible for GOI sync history".into(),
        ));
    }
    let summary = bl::read_palitra_goi_sync_summary(&env.dbx, palitra_id)
        .await
        .context(h!())?;
    Ok(Json(summary.changelog))
}

#[post("/api/palitra/v2/read/{palitra_id}")]
pub async fn read_palitra_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraReadV2>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra_id = path.into_inner();
    let palitra = bl::read_palitra_v2(login, palitra_id, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/v2/read-preview/{palitra_id}")]
pub async fn read_palitra_preview_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraReadV2>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
    let palitra_id = path.into_inner();
    let palitra = bl::read_palitra_preview_v2(login, palitra_id, &env.dbx)
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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
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
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
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
    let login = login_id_from_identity(&user)?;
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
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let palitra_id = path.into_inner();
    ensure_palitra_echo_edit_allowed(&env.dbx, palitra_id).await?;
    let txn = env.dbx.begin().await.c(h!())?;
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
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let palitra_id = path.into_inner();
    ensure_palitra_echo_edit_allowed(&env.dbx, palitra_id).await?;
    let txn = env.dbx.begin().await.c(h!())?;
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
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let req = req.into_inner();
    ensure_palitras_echo_edit_allowed(&env.dbx, &req.palitra_ids).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let sync_items = bl::assign_folder_to_accessible_palitras(
        login,
        req.palitra_ids,
        req.folder,
        &env.dbx,
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    schedule_palitra_goi_moves(&env.dbx, &sync_items)
        .await
        .c(h!())?;
    let palitra_ids =
        sync_items.iter().map(|item| item.palitra_id).collect_vec();
    Ok(Json(PalitraBulkActionRsp { palitra_ids }))
}

#[post("/api/palitra/folder/rename")]
pub async fn rename_palitra_folder(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraFolderRenameReq>,
) -> Result<Json<PalitraBulkActionRsp>, AppError> {
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let req = req.into_inner();
    let txn = env.dbx.begin().await.c(h!())?;
    let sync_items = bl::rename_accessible_palitra_folder(
        login,
        req.from_folder,
        req.to_folder,
        &env.dbx,
        &txn,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    schedule_palitra_goi_moves(&env.dbx, &sync_items)
        .await
        .c(h!())?;
    let palitra_ids =
        sync_items.iter().map(|item| item.palitra_id).collect_vec();
    Ok(Json(PalitraBulkActionRsp { palitra_ids }))
}

#[post("/api/palitra/folder/archive")]
pub async fn archive_palitra_folder(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraFolderReq>,
) -> Result<Json<PalitraBulkActionRsp>, AppError> {
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let folder = req.into_inner().folder;
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra_ids = bl::archive_accessible_palitra_folder(
        login, folder, true, &env.dbx, &txn,
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
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
        .await
        .c(h!())?;
    let palitra_ids = bl::collect_accessible_palitra_ids_in_folder(
        login,
        req.into_inner().folder,
        &env.dbx,
    )
    .await
    .c(h!())?;
    let mut deleted_palitra_ids = Vec::new();
    for palitra_id in &palitra_ids {
        if delete_palitra_from_folder_if_allowed(*palitra_id, &login, &env)
            .await
            .c(h!())?
        {
            deleted_palitra_ids.push(*palitra_id);
        }
    }
    for palitra_id in &deleted_palitra_ids {
        env.palitra_worker_context.flush_cache(*palitra_id).await;
    }
    Ok(Json(PalitraBulkActionRsp {
        palitra_ids: deleted_palitra_ids,
    }))
}

async fn delete_palitra_from_folder_if_allowed(
    palitra_id: i64,
    login: &uuid::Uuid,
    env: &Data<Env>,
) -> Result<bool, AppError> {
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let is_author_or_admin =
        is_palitra_author_or_admin(&env.dbx, login, &palitra)
            .await
            .c(h!())?;
    if !is_author_or_admin {
        return Ok(false);
    }
    if !is_palitra_echo_edit_allowed(&env.dbx, palitra_id).await? {
        return Ok(false);
    }
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    bl::delete_palitra(palitra_id, &palitra.name, &txn, existing_access, env)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(true)
}

#[post("/api/palitra/download")]
pub async fn download_palitras(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<PalitraDownloadReq>,
) -> Result<HttpResponse, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let login = login_id_from_identity(&user)?;
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
    let mut total_encrypted_bytes = 0u64;
    let mut total_bytes = 0u64;

    for (palitra, geometry) in palitras {
        let stored_bytes = download_stored_palitra_bytes(
            &env,
            &strongbox_key,
            &palitra,
            &mut total_encrypted_bytes,
        )
        .await?;
        let is_generated = stored_bytes.is_none();
        let bytes = match stored_bytes {
            Some(bytes) => bytes,
            None => {
                let palitra_read = bl::render_palitra_v2(
                    Either::Left(palitra.clone()),
                    &env.dbx,
                )
                .await
                .c(h!())?;
                download::build_geometry_palitra_kmz_bytes(&palitra_read)?
            }
        };
        let file_bytes = bytes.len() as u64;
        add_palitra_download_bytes(palitra.id, file_bytes, &mut total_bytes)?;
        let mut file_name =
            bl::build_palitra_download_file_name(&palitra, geometry.as_ref());
        if is_generated {
            file_name = download::force_kmz_extension(&file_name);
        }
        let file_name =
            ensure_unique_zip_entry_name(&mut used_file_names, file_name);
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

async fn download_stored_palitra_bytes(
    env: &Data<Env>,
    strongbox_key: &str,
    palitra: &palitra::Model,
    total_encrypted_bytes: &mut u64,
) -> Result<Option<Vec<u8>>, AppError> {
    let Some(s3_id) = palitra.s3_id.as_deref() else {
        return Ok(None);
    };
    let Some(encrypted_file_bytes) =
        crate::storage::stat_s3_object_size_with_operator(
            &env.s3,
            &env.s3_config,
            s3_id,
        )
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    add_palitra_download_bytes(
        palitra.id,
        encrypted_file_bytes,
        total_encrypted_bytes,
    )?;
    let bytes = crate::storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        strongbox_key,
        s3_id,
    )
    .await
    .c(h!())?;
    Ok((!bytes.is_empty()).then_some(bytes))
}

fn add_palitra_download_bytes(
    palitra_id: i64,
    file_bytes: u64,
    total_bytes: &mut u64,
) -> Result<(), AppError> {
    if file_bytes > crate::config::PALITRA_DOWNLOAD_MAX_FILE_BYTES {
        return Err(AppError::BL {
            msg: format!(
                "Palitra file is too large to download in one request: palitra_id={palitra_id}, bytes={file_bytes}, max={}",
                crate::config::PALITRA_DOWNLOAD_MAX_FILE_BYTES
            ),
        });
    }
    *total_bytes = total_bytes.saturating_add(file_bytes);
    if *total_bytes > crate::config::PALITRA_DOWNLOAD_MAX_TOTAL_BYTES {
        return Err(AppError::BL {
            msg: format!(
                "Requested palitra download is too large: bytes={}, max={}",
                *total_bytes,
                crate::config::PALITRA_DOWNLOAD_MAX_TOTAL_BYTES
            ),
        });
    }
    Ok(())
}

#[post("/api/palitra/update/{palitra_id}")]
pub async fn update_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraDetails>, AppError> {
    let login = login_id_from_identity(&user)?;
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
    ensure_palitra_echo_edit_allowed(&env.dbx, palitra_id).await?;
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
    let login = login_id_from_identity(&user)?;
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
    ensure_palitra_echo_edit_allowed(&env.dbx, palitra_id).await?;
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
    let login = login_id_from_identity(&user)?;
    ensure_palitra_management_permission(&env, &login)
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
            "Only author or Admin may delete palitra".into(),
        ));
    }
    ensure_palitra_echo_edit_allowed(&env.dbx, palitra_id).await?;
    let existing_access =
        read_palitra_access(&env.dbx, palitra_id).await.c(h!())?;

    bl::delete_palitra(palitra.id, &palitra.name, &txn, existing_access, &env)
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
    let mut upload_file: Option<(String, Vec<u8>, Option<String>, String)> =
        None;

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
                let content_type =
                    field.content_type().map(|ct| ct.to_string());
                let extension =
                    validate_palitra_upload_filename(&filename).c(h!())?;
                let file_data = read_multipart_field_bytes(&mut field).await?;
                upload_file =
                    Some((filename, file_data, content_type, extension));
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
    let (filename, file_data, content_type, extension) = upload_file.c(h!())?;
    Ok(CreatePalitraMultipartPayload {
        name,
        color_hex,
        access_type,
        access_values,
        filename,
        file_data,
        content_type,
        extension,
    })
}

fn validate_palitra_upload_filename(filename: &str) -> anyhow::Result<String> {
    let extension = upload_extension(filename).c(h!())?;
    if PALITRA_BLOCKED_UNSTABLE_UPLOAD_EXTENSIONS.contains(&extension.as_str())
    {
        bail!(
            "PGD conversion is not stable enough yet, so PGD palitra uploads are not permitted for now"
        );
    }
    if !PALITRA_ALLOWED_UPLOAD_EXTENSIONS.contains(&extension.as_str()) {
        bail!("Unsupported palitra file extension: {extension}");
    }
    Ok(extension)
}

fn upload_extension(filename: &str) -> anyhow::Result<String> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
        .c(h!())?;
    Ok(extension)
}

fn is_direct_palitra_upload_extension(extension: &str) -> bool {
    PALITRA_DIRECT_PARSE_EXTENSIONS.contains(&extension)
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

fn remap_fallback_geometry_color(
    points_by_color: &mut BTreeMap<String, Vec<PalitraPoint>>,
    line_strings_by_color: &mut BTreeMap<String, Vec<kmz::PalitraLineString>>,
    replacement_color_hex: Option<&str>,
) {
    let Some(replacement_color_hex) = replacement_color_hex else {
        return;
    };
    let replacement_color_hex = normalize_color_hex_or_fallback(Some(
        replacement_color_hex.to_string(),
    ));
    remap_fallback_color(
        points_by_color,
        crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX,
        &replacement_color_hex,
    );
    remap_fallback_color(
        line_strings_by_color,
        crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX,
        &replacement_color_hex,
    );
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
    let access_organism_ids =
        bl::collect_palitra_access_organisms(dbx, palitra_id)
            .await
            .c(h!())?;
    let access_logins =
        if palitra.imported_from_goi && !access_organism_ids.is_empty() {
            vec![]
        } else {
            bl::collect_palitra_access_logins(dbx, palitra_id)
                .await
                .c(h!())?
        };
    let access_login_names =
        crate::users::login_names_by_ids(dbx, access_logins.clone())
            .await
            .c(h!())?;
    let author = match palitra.author_login_id {
        Some(author_login_id) => {
            crate::users::login_names_by_ids(dbx, vec![author_login_id])
                .await?
                .remove(&author_login_id)
        }
        None => None,
    };
    let goi_sync_summary = bl::read_palitra_goi_sync_summary(dbx, palitra_id)
        .await
        .c(h!())?;
    Ok(Palitra {
        id: palitra.id,
        name: palitra.name,
        folder: bl::normalize_palitra_folder_from_db(palitra.folder),
        is_archived: palitra.is_archived,
        color_hex: palitra_geometry.hex,
        author,
        source_file_name: palitra_geometry.source_file_name,
        last_uploaded_at_ts: palitra_geometry
            .last_uploaded_at
            .map(|ts| ts.and_utc().timestamp_millis()),
        conversion_status: palitra.conversion_status,
        source_format: palitra.source_format,
        conversion_error: palitra.conversion_error,
        missing_in_goi: palitra.missing_in_goi,
        imported_from_goi: palitra.imported_from_goi,
        goi_owned: goi_sync_summary.goi_owned,
        goi_source_refresh_retry_available: goi_sync_summary
            .goi_source_refresh_retry_available,
        latest_changelog_warning: goi_sync_summary.latest_changelog_warning,
        changelog: goi_sync_summary.changelog,
        geometry: None,
        access_aor_id: bl::collect_palitra_access_aors(dbx, palitra_id)
            .await
            .c(h!())?,
        access_organism_ids,
        access_logins: access_logins
            .into_iter()
            .map(|login_id| {
                let login = access_login_names
                    .get(&login_id)
                    .cloned()
                    .unwrap_or_else(|| login_id.to_string());
                PalitraAccessLogin {
                    id: login_id.to_string(),
                    login,
                }
            })
            .collect(),
    })
}

async fn ensure_palitra_permissions(
    env: &Data<Env>,
    login: &uuid::Uuid,
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

    let is_admin = is_palitra_admin(env, login).await.c(h!())?;
    let is_rer = has_role_or_false(env, login, "Rer").await.c(h!())?;
    let caller_login_name = if is_rer {
        crate::users::login_names_by_ids(&env.dbx, vec![*login])
            .await
            .c(h!())?
            .remove(login)
    } else {
        None
    };

    match access {
        PalitraAccess::ByLogins { logins } => {
            if is_admin {
                return Ok(());
            }
            if !is_rer {
                bail!("Only Rer may manage login-scoped palitra");
            }
            let all_self = logins.iter().all(|login_id| {
                Uuid::parse_str(login_id).ok().as_ref() == Some(login)
                    || caller_login_name.as_deref() == Some(login_id.as_str())
            });
            if !all_self {
                bail!("Rer may only manage palitra scoped to own login");
            }
        }
        PalitraAccess::ByOrganisms { organism_ids } => {
            if is_admin {
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
        PalitraAccess::ByAor { aor_ids: _ } => {
            if is_admin {
                return Ok(());
            }
            bail!("Only Admin may manage AOR-scoped palitra");
        }
    };
    Ok(())
}

async fn ensure_palitra_management_permission(
    env: &Data<Env>,
    login: &uuid::Uuid,
) -> Result<(), AppError> {
    if is_palitra_admin(env, login).await.c(h!())? {
        return Ok(());
    }

    if has_role_or_false(env, login, "Rer").await.c(h!())? {
        return Ok(());
    }

    Err(AppError::Forbidden(
        "Only Admin or Rer may manage palitra".into(),
    ))
}

async fn ensure_palitra_echo_edit_allowed<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'a,
{
    if !is_palitra_echo_edit_allowed(dbx, palitra_id).await? {
        return Err(AppError::BL {
            msg: GOI_OWNED_PALITRA_EDIT_ERROR.to_string(),
        });
    }
    Ok(())
}

async fn is_palitra_echo_edit_allowed<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> Result<bool, AppError>
where
    C: ConnectionTrait + 'a,
{
    Ok(!bl::is_goi_owned_convertible_palitra(dbx, palitra_id)
        .await
        .c(h!())?)
}

async fn ensure_palitras_echo_edit_allowed<'a, C>(
    dbx: &'a C,
    palitra_ids: &[i64],
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'a,
{
    for palitra_id in palitra_ids {
        ensure_palitra_echo_edit_allowed(dbx, *palitra_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn is_palitra_admin(
    env: &Data<Env>,
    login: &uuid::Uuid,
) -> Result<bool, AppError> {
    has_role_or_false(env, login, "Admin").await
}

async fn has_role_or_false(
    env: &Data<Env>,
    login: &uuid::Uuid,
    role: &str,
) -> Result<bool, AppError> {
    match has_role(&env.dbx, login, role).await {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden(_)) => Ok(false),
        Err(err) => Err(err),
    }
}

async fn read_latest_palitra_geometry<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Option<palitra_geometry::Model>>
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
        .c(h!())
}

async fn read_latest_palitra_geometry_including_deleted<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Option<palitra_geometry::Model>>
where
    C: ConnectionTrait + 'async_trait,
{
    palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .order_by_desc(palitra_geometry::Column::UpdatedAt)
        .order_by_desc(palitra_geometry::Column::Id)
        .one(dbx)
        .await
        .c(h!())
}

async fn read_latest_palitra_geometry_with_warning<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<palitra_geometry::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    read_latest_palitra_geometry(dbx, palitra_id)
        .await
        .c(h!())?
        .c(h!())
}

async fn load_user_scope(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> anyhow::Result<UserScope> {
    let login = login::Entity::find_by_id(*login_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    Ok(UserScope {
        organism_ids: login.organism_id.into_iter().collect_vec(),
    })
}

async fn is_palitra_author_or_admin(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    palitra: &palitra::Model,
) -> anyhow::Result<bool> {
    let is_admin = has_role(dbx, login, "Admin").await.is_ok();
    Ok(is_admin || palitra.author_login_id == Some(*login))
}

async fn read_palitra_access<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<PalitraAccess>
where
    C: ConnectionTrait + 'a,
{
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
    logins: Vec<uuid::Uuid>,
    organism_ids: Vec<i64>,
    aor_ids: Vec<i64>,
) -> anyhow::Result<PalitraAccess> {
    if !organism_ids.is_empty() {
        return Ok(PalitraAccess::ByOrganisms { organism_ids });
    }
    if !logins.is_empty() {
        return Ok(PalitraAccess::ByLogins {
            logins: logins
                .into_iter()
                .map(|login_id| login_id.to_string())
                .collect(),
        });
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

pub(crate) async fn schedule_palitra_goi_upload<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    file_data: Vec<u8>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    palitra_goi_sync_job::Entity::insert(palitra_goi_sync_job::ActiveModel {
        palitra_id: Set(palitra_id),
        kind: Set(PALITRA_GOI_SYNC_JOB_KIND_UPLOAD.to_string()),
        source_folder: Set(String::new()),
        file_data: Set(Some(file_data)),
        last_attempt_at: Set(None),
        attempt_count: Set(0),
        last_error: Set(None),
        ..Default::default()
    })
    .on_conflict(
        sea_orm::sea_query::OnConflict::columns([
            palitra_goi_sync_job::Column::PalitraId,
            palitra_goi_sync_job::Column::Kind,
            palitra_goi_sync_job::Column::SourceFolder,
        ])
        .update_columns([
            palitra_goi_sync_job::Column::FileData,
            palitra_goi_sync_job::Column::LastAttemptAt,
            palitra_goi_sync_job::Column::AttemptCount,
            palitra_goi_sync_job::Column::LastError,
        ])
        .to_owned(),
    )
    .exec(dbx)
    .await
    .c(h!())?;
    Ok(())
}

async fn cancel_palitra_goi_upload<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    palitra_goi_sync_job::Entity::delete_many()
        .filter(palitra_goi_sync_job::Column::PalitraId.eq(palitra_id))
        .filter(
            palitra_goi_sync_job::Column::Kind
                .eq(PALITRA_GOI_SYNC_JOB_KIND_UPLOAD),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn schedule_palitra_conversion<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    filename: String,
    extension: String,
    content_type: Option<String>,
    file_data: Vec<u8>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    schedule_palitra_conversion_with_goi_upload(
        dbx,
        palitra_id,
        filename,
        extension,
        content_type,
        file_data,
        false,
    )
    .await
    .c(h!())
}

pub(crate) async fn schedule_palitra_conversion_with_goi_upload<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    filename: String,
    extension: String,
    content_type: Option<String>,
    file_data: Vec<u8>,
    should_schedule_goi_upload: bool,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    palitra_conversion_job::Entity::insert(
        palitra_conversion_job::ActiveModel {
            palitra_id: Set(palitra_id),
            source_file_name: Set(filename.clone()),
            source_format: Set(extension.clone()),
            content_type: Set(content_type),
            file_data: Set(Some(file_data)),
            status: Set(PALITRA_CONVERSION_JOB_STATUS_PENDING.to_string()),
            conversion_receipt: Set(None),
            last_attempt_at: Set(None),
            attempt_count: Set(0),
            last_error: Set(None),
            should_schedule_goi_upload: Set(should_schedule_goi_upload),
            ..Default::default()
        },
    )
    .on_conflict(
        sea_orm::sea_query::OnConflict::column(
            palitra_conversion_job::Column::PalitraId,
        )
        .update_columns([
            palitra_conversion_job::Column::SourceFileName,
            palitra_conversion_job::Column::SourceFormat,
            palitra_conversion_job::Column::ContentType,
            palitra_conversion_job::Column::FileData,
            palitra_conversion_job::Column::Status,
            palitra_conversion_job::Column::ConversionReceipt,
            palitra_conversion_job::Column::LastAttemptAt,
            palitra_conversion_job::Column::LastError,
            palitra_conversion_job::Column::ShouldScheduleGoiUpload,
        ])
        .to_owned(),
    )
    .exec(dbx)
    .await
    .c(h!())?;
    update_palitra_conversion_status(
        dbx,
        palitra_id,
        PALITRA_CONVERSION_STATUS_PROCESSING,
        Some(extension),
        None,
        None,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn schedule_palitra_replacement_conversion_with_goi_upload(
    txn: &DatabaseTransaction,
    palitra_id: i64,
    filename: String,
    extension: String,
    content_type: Option<String>,
    file_data: Vec<u8>,
    should_schedule_goi_upload: bool,
) -> anyhow::Result<()> {
    cancel_palitra_goi_upload(txn, palitra_id).await.c(h!())?;
    schedule_palitra_conversion_with_goi_upload(
        txn,
        palitra_id,
        filename,
        extension,
        content_type,
        file_data,
        should_schedule_goi_upload,
    )
    .await
    .c(h!())?;
    clear_active_palitra_geometries(txn, palitra_id)
        .await
        .c(h!())
}

pub(crate) async fn schedule_palitra_goi_source_conversion(
    txn: &DatabaseTransaction,
    palitra_id: i64,
    filename: String,
    extension: String,
    content_type: Option<String>,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    cancel_palitra_goi_upload(txn, palitra_id).await.c(h!())?;
    schedule_palitra_conversion_with_goi_upload(
        txn,
        palitra_id,
        filename,
        extension,
        content_type,
        file_data,
        false,
    )
    .await
    .c(h!())
}

async fn clear_active_palitra_geometries(
    txn: &DatabaseTransaction,
    palitra_id: i64,
) -> anyhow::Result<()> {
    let palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    for palitra_geometry in palitra_geometries {
        bl::soft_delete_palitra_geometry(palitra_geometry.id, txn)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub(crate) async fn cancel_palitra_conversion<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    palitra_conversion_job::Entity::delete_many()
        .filter(palitra_conversion_job::Column::PalitraId.eq(palitra_id))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn update_palitra_conversion_status<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    status: &str,
    source_format: Option<String>,
    receipt: Option<String>,
    error: Option<String>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let now = Utc::now();
    let mut update = palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(palitra_id))
        .col_expr(
            palitra::Column::ConversionStatus,
            Expr::value(status.to_string()),
        )
        .col_expr(
            palitra::Column::ConversionLastAttemptAt,
            Expr::value(Some(now)),
        );
    if let Some(source_format) = source_format {
        update = update.col_expr(
            palitra::Column::SourceFormat,
            Expr::value(Some(source_format)),
        );
    }
    update = update
        .col_expr(palitra::Column::ConversionReceipt, Expr::value(receipt));
    update =
        update.col_expr(palitra::Column::ConversionError, Expr::value(error));
    if status == PALITRA_CONVERSION_STATUS_ERROR {
        update = update.col_expr(
            palitra::Column::ConversionAttemptCount,
            Expr::cust("conversion_attempt_count + 1"),
        );
    }
    update.exec(dbx).await.c(h!())?;
    Ok(())
}

pub(crate) async fn schedule_palitra_goi_moves(
    dbx: &DatabaseConnection,
    sync_items: &[bl::PalitraFolderSyncItem],
) -> anyhow::Result<()> {
    for item in sync_items {
        palitra_goi_sync_job::Entity::insert(
            palitra_goi_sync_job::ActiveModel {
                palitra_id: Set(item.palitra_id),
                kind: Set(PALITRA_GOI_SYNC_JOB_KIND_MOVE.to_string()),
                source_folder: Set(item
                    .source_folder
                    .clone()
                    .unwrap_or_default()),
                ..Default::default()
            },
        )
        .on_conflict(
            sea_orm::sea_query::OnConflict::columns([
                palitra_goi_sync_job::Column::PalitraId,
                palitra_goi_sync_job::Column::Kind,
                palitra_goi_sync_job::Column::SourceFolder,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

pub(crate) async fn schedule_palitra_goi_delete(
    dbx: &DatabaseConnection,
    palitra_id: i64,
) -> anyhow::Result<()> {
    let source_folders = palitra_goi_sync_job::Entity::find()
        .filter(palitra_goi_sync_job::Column::PalitraId.eq(palitra_id))
        .filter(
            palitra_goi_sync_job::Column::Kind
                .eq(PALITRA_GOI_SYNC_JOB_KIND_MOVE),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|job| job.source_folder)
        .collect::<std::collections::BTreeSet<_>>();
    palitra_goi_sync_job::Entity::delete_many()
        .filter(palitra_goi_sync_job::Column::PalitraId.eq(palitra_id))
        .filter(palitra_goi_sync_job::Column::Kind.is_in([
            PALITRA_GOI_SYNC_JOB_KIND_UPLOAD,
            PALITRA_GOI_SYNC_JOB_KIND_MOVE,
        ]))
        .exec(dbx)
        .await
        .c(h!())?;
    let source_folders = std::iter::once(String::new())
        .chain(source_folders)
        .collect::<std::collections::BTreeSet<_>>();
    for source_folder in source_folders {
        palitra_goi_sync_job::Entity::insert(
            palitra_goi_sync_job::ActiveModel {
                palitra_id: Set(palitra_id),
                kind: Set(PALITRA_GOI_SYNC_JOB_KIND_DELETE.to_string()),
                source_folder: Set(source_folder),
                ..Default::default()
            },
        )
        .on_conflict(
            sea_orm::sea_query::OnConflict::columns([
                palitra_goi_sync_job::Column::PalitraId,
                palitra_goi_sync_job::Column::Kind,
                palitra_goi_sync_job::Column::SourceFolder,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn sync_move_palitra_files_to_connected_organisms(
    env: &Env,
    sync_items: &[bl::PalitraFolderSyncItem],
) -> anyhow::Result<()> {
    let mut palitra_ids = std::collections::BTreeSet::new();
    for item in sync_items {
        palitra_ids.insert(item.palitra_id);
    }
    let mut tasks_by_target: BTreeMap<
        i64,
        (ConnectedGoiTarget, Vec<GoiMoveTask>),
    > = BTreeMap::new();
    for palitra_id in palitra_ids {
        let source_folder_hint = sync_items
            .iter()
            .find(|item| item.palitra_id == palitra_id)
            .map(|item| item.source_folder.clone().unwrap_or_default());
        let Some(palitra) = palitra::Entity::find_by_id(palitra_id)
            .filter(palitra::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let geometry = match read_latest_palitra_geometry_with_warning(
            &env.dbx, palitra.id,
        )
        .await
        {
            Ok(geometry) => geometry,
            Err(err) => {
                warn!(
                    "Skipping GOI file move for palitra {}: missing geometry: {err:#}",
                    palitra.id
                );
                continue;
            }
        };
        let Some(source_file_name) = geometry.source_file_name else {
            continue;
        };
        let access = read_palitra_access(&env.dbx, palitra.id).await.c(h!())?;
        let PalitraAccess::ByOrganisms { organism_ids } = &access else {
            continue;
        };
        let target_folder =
            bl::normalize_palitra_folder_from_db(palitra.folder.clone());
        let source_file_names = palitra_goi_remote_file_names(
            palitra.id,
            Some(&palitra.name),
            Some(&source_file_name),
        );
        let target_file_name = source_file_names.first().cloned().c(h!())?;
        let tracked_relative_paths_by_integration =
            read_tracked_goi_palitra_relative_paths_by_integration(
                &env.dbx, palitra.id,
            )
            .await
            .c(h!())?;
        let goi_targets =
            collect_connected_goi_targets(env, organism_ids.as_slice())
                .await
                .c(h!())?;
        for target in goi_targets {
            let target_key = target.integration_id;
            let tracked_relative_paths = tracked_relative_paths_by_integration
                .get(&target.integration_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let tasks = goi_move_tasks_for_target(
                palitra.id,
                source_file_names.as_slice(),
                &target_file_name,
                target_folder.clone(),
                source_folder_hint.as_deref(),
                tracked_relative_paths,
            );
            let task_list = &mut tasks_by_target
                .entry(target_key)
                .or_insert_with(|| (target, Vec::new()))
                .1;
            for task in tasks {
                match task_list.iter().find(|existing| {
                    existing.target_file_name == task.target_file_name
                }) {
                    None => task_list.push(task),
                    Some(existing) if existing == &task => {}
                    Some(existing) => {
                        warn!(
                            "Skipping GOI file move task with duplicate target path '{}': conflicting tasks (existing folder {:?}, source hint {:?}; new folder {:?}, source hint {:?})",
                            task.target_file_name,
                            existing.target_folder,
                            existing.source_folder_hint,
                            task.target_folder,
                            task.source_folder_hint
                        );
                    }
                }
            }
        }
    }

    let mut errors = Vec::new();
    for (_, (target, tasks)) in tasks_by_target {
        if target.disable_goi_to_echo_palitra_sync {
            if let Err(err) =
                move_palitra_files_to_goi_target(&env.dbx, &target, tasks).await
            {
                errors.push(format!("{} {err:#}", target.api.label()));
            }
            continue;
        }
        let Some(lock) = target.api.try_acquire_sync_lock().await.c(h!())?
        else {
            errors.push(format!(
                "{} sync lock is held by another worker",
                target.api.label()
            ));
            continue;
        };
        let sync_result = async {
            let mut entries = target.api.list_palette_files().await.c(h!())?;
            lock.refresh().await.c(h!())?;

            for task in tasks {
                let tracking_update = goi_move_task_tracking_update(&task);
                let palitra_id = task.palitra_id;
                crate::organism::goi::goi_move_file_to_folder_with_entries(
                    target.api.clone(),
                    task.source_file_names,
                    task.target_file_name,
                    task.target_folder,
                    task.source_folder_hint,
                    &mut entries,
                )
                .await
                .c(h!())?;
                if let Some((source_relative_path, target_relative_path)) =
                    tracking_update
                {
                    update_tracked_goi_move_path(
                        &env.dbx,
                        target.integration_id,
                        palitra_id,
                        &source_relative_path,
                        &target_relative_path,
                    )
                    .await
                    .c(h!())?;
                }
                lock.refresh().await.c(h!())?;
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        let lock_target = lock.target().to_string();
        if let Err(err) = lock.release().await {
            warn!("Failed to release GOI sync lock for {lock_target}: {err:#}");
        }
        if let Err(err) = sync_result {
            errors.push(format!("{} {err:#}", target.api.label()));
        }
    }
    if errors.is_empty() {
        return Ok(());
    }
    bail!("palitra GOI move failed: {}", errors.join("; "));
}

async fn move_palitra_files_to_goi_target(
    dbx: &impl ConnectionTrait,
    target: &ConnectedGoiTarget,
    tasks: Vec<GoiMoveTask>,
) -> anyhow::Result<()> {
    let mut entries = target.api.list_palette_files().await.c(h!())?;

    for task in tasks {
        let tracking_update = goi_move_task_tracking_update(&task);
        let palitra_id = task.palitra_id;
        crate::organism::goi::goi_move_file_to_folder_with_entries(
            target.api.clone(),
            task.source_file_names,
            task.target_file_name,
            task.target_folder,
            task.source_folder_hint,
            &mut entries,
        )
        .await
        .c(h!())?;
        if let Some((source_relative_path, target_relative_path)) =
            tracking_update
        {
            update_tracked_goi_move_path(
                dbx,
                target.integration_id,
                palitra_id,
                &source_relative_path,
                &target_relative_path,
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

fn goi_move_tasks_for_target(
    palitra_id: i64,
    source_file_names: &[String],
    target_file_name: &str,
    target_folder: Option<String>,
    source_folder_hint: Option<&str>,
    tracked_relative_paths: &[String],
) -> Vec<GoiMoveTask> {
    let mut tracked_tasks = Vec::new();
    let mut used_tracked_paths = BTreeSet::new();
    for tracked_relative_path in tracked_relative_paths {
        let Some((source_folder_hint, file_name, tracked_relative_path)) =
            split_goi_relative_path(tracked_relative_path)
        else {
            continue;
        };
        if !used_tracked_paths.insert(tracked_relative_path.clone()) {
            continue;
        }
        tracked_tasks.push(GoiMoveTask {
            palitra_id,
            source_file_names: vec![file_name.clone()],
            target_file_name: file_name,
            target_folder: target_folder.clone(),
            source_folder_hint: Some(source_folder_hint),
            tracked_source_relative_path: Some(tracked_relative_path),
        });
    }
    if !tracked_tasks.is_empty() {
        return tracked_tasks;
    }
    vec![GoiMoveTask {
        palitra_id,
        source_file_names: source_file_names.to_vec(),
        target_file_name: target_file_name.to_string(),
        target_folder,
        source_folder_hint: normalize_goi_source_folder_hint(
            source_folder_hint,
        ),
        tracked_source_relative_path: None,
    }]
}

fn goi_move_task_tracking_update(
    task: &GoiMoveTask,
) -> Option<(String, String)> {
    let source_relative_path = task.tracked_source_relative_path.clone()?;
    let target_relative_path = compose_goi_relative_path(
        task.target_folder.as_deref(),
        &task.target_file_name,
    );
    Some((source_relative_path, target_relative_path))
}

async fn update_tracked_goi_move_path(
    dbx: &impl ConnectionTrait,
    goi_integration_id: i64,
    palitra_id: i64,
    source_relative_path: &str,
    target_relative_path: &str,
) -> anyhow::Result<()> {
    if source_relative_path == target_relative_path {
        return Ok(());
    }
    goi_palitra_sync::Entity::delete_many()
        .filter(
            goi_palitra_sync::Column::GoiIntegrationId.eq(goi_integration_id),
        )
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::RemoteRelativePath
                .eq(target_relative_path.to_string()),
        )
        .exec(dbx)
        .await
        .c(h!())?;

    let now = Utc::now().fixed_offset();
    goi_palitra_sync::Entity::update_many()
        .filter(
            goi_palitra_sync::Column::GoiIntegrationId.eq(goi_integration_id),
        )
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::RemoteRelativePath
                .eq(source_relative_path.to_string()),
        )
        .col_expr(
            goi_palitra_sync::Column::RemoteRelativePath,
            Expr::value(target_relative_path.to_string()),
        )
        .col_expr(
            goi_palitra_sync::Column::RemoteStatus,
            Expr::value(PALITRA_GOI_REMOTE_STATUS_PRESENT.to_string()),
        )
        .col_expr(goi_palitra_sync::Column::UpdatedAt, Expr::value(now))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn read_tracked_goi_palitra_relative_paths_by_integration<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<BTreeMap<i64, Vec<String>>>
where
    C: ConnectionTrait + 'a,
{
    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .all(dbx)
        .await
        .c(h!())?;
    let mut paths_by_integration = BTreeMap::<i64, BTreeSet<String>>::new();
    for row in rows {
        let Some(path) =
            normalize_goi_remote_relative_path(&row.remote_relative_path)
        else {
            continue;
        };
        paths_by_integration
            .entry(row.goi_integration_id)
            .or_default()
            .insert(path);
    }
    Ok(paths_by_integration
        .into_iter()
        .map(|(integration_id, paths)| {
            (integration_id, paths.into_iter().collect_vec())
        })
        .collect())
}

fn split_goi_relative_path(path: &str) -> Option<(String, String, String)> {
    let path = normalize_goi_remote_relative_path(path)?;
    if let Some((folder, file_name)) = path.rsplit_once('/') {
        let file_name = file_name.trim();
        if file_name.is_empty() {
            return None;
        }
        return Some((
            folder.trim_matches('/').to_string(),
            file_name.to_string(),
            path,
        ));
    }
    Some((String::new(), path.clone(), path))
}

fn normalize_goi_remote_relative_path(path: &str) -> Option<String> {
    let path = path.trim().trim_start_matches("./").trim_matches('/');
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn normalize_goi_source_folder_hint(
    source_folder_hint: Option<&str>,
) -> Option<String> {
    source_folder_hint
        .map(str::trim)
        .map(|folder| folder.trim_matches('/').to_string())
}

fn compose_goi_relative_path(
    target_folder: Option<&str>,
    file_name: &str,
) -> String {
    let file_name = file_name.trim().trim_start_matches('/');
    match target_folder
        .map(str::trim)
        .map(|folder| folder.trim_matches('/'))
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => format!("{folder}/{file_name}"),
        None => file_name.to_string(),
    }
}

async fn collect_connected_goi_targets(
    env: &Env,
    organism_ids: &[i64],
) -> anyhow::Result<Vec<ConnectedGoiTarget>> {
    if organism_ids.is_empty() {
        return Ok(vec![]);
    }

    let integrations = goi_integration::Entity::find()
        .filter(
            goi_integration::Column::OwnerOrganismId
                .is_in(organism_ids.to_vec()),
        )
        .filter(
            goi_integration::Column::IntegrationType
                .eq(ORGANISM_GOI_INTEGRATION_TYPE_FULL),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;

    let mut goi_targets = Vec::with_capacity(integrations.len());
    for integration in integrations {
        let integration_id = integration.id;
        match GoiApiTarget::from_integration(env.rq.clone(), &integration) {
            Ok(api) => goi_targets.push(ConnectedGoiTarget {
                integration_id,
                api,
                disable_goi_to_echo_palitra_sync: integration
                    .disable_goi_to_echo_palitra_sync,
            }),
            Err(err) => {
                warn!(
                    "Skipping GOI sync target for integration {} ({}): {err:#}",
                    integration_id, integration.server_label
                );
            }
        }
    }

    Ok(goi_targets)
}

pub(crate) fn kmz_file_name_as_kmz(source_file_name: &str) -> String {
    let safe_name = kmz::sanitize_upload_filename(source_file_name);
    let safe_name = safe_name.trim();
    let lower_name = safe_name.to_ascii_lowercase();
    let (stem, extension) = if lower_name.ends_with(".kml") {
        (
            strip_duplicate_extension(
                safe_name[..safe_name.len() - 4].trim(),
                "kml",
            ),
            Some("kml"),
        )
    } else if lower_name.ends_with(".kmz") {
        (
            strip_duplicate_extension(
                safe_name[..safe_name.len() - 4].trim(),
                "kmz",
            ),
            Some("kmz"),
        )
    } else {
        (safe_name.to_string(), None)
    };
    let stem = if stem.is_empty() {
        "palitra".to_string()
    } else {
        stem
    };

    match extension {
        Some("kml") => format!("{stem}.kml"),
        Some("kmz") => format!("{stem}.kmz"),
        _ => format!("{stem}.kmz"),
    }
}

fn strip_duplicate_extension(stem: &str, extension: &str) -> String {
    let lower_stem = stem.to_ascii_lowercase();
    if lower_stem.ends_with(&format!(".{extension}")) {
        let next = stem[..stem.len() - extension.len() - 1].trim();
        if next.is_empty() {
            "palitra".to_string()
        } else {
            next.to_string()
        }
    } else {
        stem.to_string()
    }
}

fn palitra_goi_remote_file_name_legacy(palitra_id: i64) -> String {
    format!("palitra_{palitra_id:06}.kmz")
}

pub(crate) fn palitra_goi_remote_file_name(
    palitra_id: i64,
    palitra_name: Option<&str>,
    source_file_name: Option<&str>,
) -> String {
    match palitra_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(palitra_name) => kmz_file_name_as_kmz(palitra_name),
        None => match source_file_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(source_file_name) => kmz_file_name_as_kmz(source_file_name),
            None => palitra_goi_remote_file_name_legacy(palitra_id),
        },
    }
}

fn palitra_goi_remote_file_names(
    palitra_id: i64,
    palitra_name: Option<&str>,
    source_file_name: Option<&str>,
) -> Vec<String> {
    let mut file_names = vec![palitra_goi_remote_file_name(
        palitra_id,
        palitra_name,
        source_file_name,
    )];
    if let Some(source_file_name) = source_file_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(kmz_file_name_as_kmz)
    {
        if !file_names.contains(&source_file_name) {
            file_names.push(source_file_name);
        }
    }
    let legacy_file_name = palitra_goi_remote_file_name_legacy(palitra_id);
    if !file_names.contains(&legacy_file_name) {
        file_names.push(legacy_file_name);
    }
    file_names
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

#[cfg(test)]
mod tests {
    use super::*;

    fn goi_source_retry_row_for_test(
        id: i64,
        updated_at_offset_sec: i64,
        latest_warning: bool,
        filename: &str,
        file_data: Vec<u8>,
    ) -> goi_palitra_sync::Model {
        let entry = if latest_warning {
            goi_changelog::error_entry(
                "GOI source conversion failed",
                "Не вдалося сконвертувати файл ГОІ.",
            )
        } else {
            goi_changelog::ok_entry(
                "Converted GOI source",
                "Файл ГОІ успішно сконвертовано.",
            )
        };
        goi_source_retry_row_with_entry_for_test(
            id,
            updated_at_offset_sec,
            entry,
            filename,
            PALITRA_GOI_REMOTE_STATUS_PRESENT,
            file_data,
        )
    }

    fn goi_source_retry_row_with_entry_for_test(
        id: i64,
        updated_at_offset_sec: i64,
        entry: PalitraChangelogEntry,
        filename: &str,
        remote_status: &str,
        file_data: Vec<u8>,
    ) -> goi_palitra_sync::Model {
        let now = Utc::now().fixed_offset();
        let updated_at = now + chrono::Duration::seconds(updated_at_offset_sec);
        let changelog =
            goi_changelog::append_to_value(&serde_json::json!([]), entry)
                .unwrap();

        goi_palitra_sync::Model {
            id,
            goi_integration_id: 2,
            palitra_id: Some(10),
            remote_relative_path: filename.to_string(),
            direction: crate::config::PALITRA_GOI_SYNC_DIRECTION_GOI
                .to_string(),
            remote_status: remote_status.to_string(),
            file_size: Some(3),
            file_sha256: Some("abc".to_string()),
            echo_file_size: Some(3),
            echo_file_sha256: Some("abc".to_string()),
            echo_updated_at: Some(now),
            goi_file_size: Some(3),
            goi_file_sha256: Some("abc".to_string()),
            goi_updated_at: Some(now),
            last_seen_at: Some(now),
            last_sync_at: Some(now),
            created_at: now,
            updated_at,
            changelog,
            goi_source_file_name: Some(filename.to_string()),
            goi_source_format: Some("gpx".to_string()),
            goi_source_content_type: None,
            goi_source_file_data: Some(file_data),
            goi_source_file_size: Some(3),
            goi_source_file_sha256: Some(format!("sha-{id}")),
            goi_source_failed_file_sha256: None,
            goi_source_last_retry_at: None,
        }
    }

    #[test]
    fn retry_goi_source_conversion_selects_failed_source_row() {
        let failed_row = goi_source_retry_row_for_test(
            1,
            0,
            true,
            "failed-source.gpx",
            vec![1, 2, 3],
        );

        let row =
            select_goi_source_conversion_retry_row(vec![failed_row]).unwrap();

        assert_eq!(row.id, 1);
        assert_eq!(
            row.goi_source_file_name.as_deref(),
            Some("failed-source.gpx")
        );
        assert_eq!(row.goi_source_file_data, Some(vec![1, 2, 3]));
    }

    #[test]
    fn retry_goi_source_conversion_selects_retryable_row_after_newer_ok() {
        let older_failed_row = goi_source_retry_row_for_test(
            1,
            0,
            true,
            "older-failed-source.gpx",
            vec![1, 2, 3],
        );
        let current_ok_row = goi_source_retry_row_for_test(
            2,
            10,
            false,
            "current-ok-source.gpx",
            vec![4, 5, 6],
        );

        let row = select_goi_source_conversion_retry_row(vec![
            current_ok_row,
            older_failed_row,
        ])
        .unwrap();

        assert_eq!(row.id, 1);
    }

    #[test]
    fn retry_goi_source_conversion_selects_older_warning_when_newer_lacks_data()
    {
        let older_failed_row = goi_source_retry_row_for_test(
            1,
            0,
            true,
            "older-failed-source.gpx",
            vec![1, 2, 3],
        );
        let mut current_failed_row = goi_source_retry_row_for_test(
            2,
            10,
            true,
            "current-failed-source.gpx",
            vec![4, 5, 6],
        );
        current_failed_row.goi_source_file_data = None;

        assert!(select_goi_source_conversion_retry_row(vec![
            current_failed_row,
            older_failed_row,
        ])
        .is_some_and(|row| row.id == 1));
    }

    #[test]
    fn retry_goi_source_conversion_ignores_non_conversion_warning() {
        let duplicate_conflict_row = goi_source_retry_row_with_entry_for_test(
            1,
            0,
            goi_changelog::error_entry(
                "Duplicate GOI remote path tracking conflict",
                "Дубльований шлях ГОІ.",
            ),
            "source.gpx",
            PALITRA_GOI_REMOTE_STATUS_PRESENT,
            vec![1, 2, 3],
        );

        assert!(select_goi_source_conversion_retry_row(vec![
            duplicate_conflict_row
        ])
        .is_none());
    }

    #[test]
    fn retry_goi_source_conversion_ignores_missing_source_row() {
        let missing_failed_row = goi_source_retry_row_with_entry_for_test(
            1,
            0,
            goi_changelog::error_entry(
                "GOI source conversion failed",
                "Не вдалося сконвертувати файл ГОІ.",
            ),
            "missing-source.gpx",
            crate::config::PALITRA_GOI_REMOTE_STATUS_MISSING,
            vec![1, 2, 3],
        );

        assert!(select_goi_source_conversion_retry_row(vec![
            missing_failed_row
        ])
        .is_none());
    }

    #[test]
    fn pick_access_preserves_organism_scope_when_login_rows_exist() {
        let access =
            pick_access(vec![uuid::Uuid::nil()], vec![10], vec![]).unwrap();

        assert!(matches!(
            access,
            PalitraAccess::ByOrganisms { organism_ids } if organism_ids == vec![10]
        ));
    }

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
    fn remaps_fallback_geometry_color_to_selected_color() {
        let fallback_color =
            crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string();
        let selected_color = "#112233";
        let mut points_by_color = BTreeMap::from([(
            fallback_color.clone(),
            vec![PalitraPoint {
                coords: Coords {
                    lat: 50.0,
                    lng: 30.0,
                },
                label: None,
                color: Some(fallback_color.clone()),
            }],
        )]);
        let mut line_strings_by_color = BTreeMap::from([(
            fallback_color.clone(),
            vec![kmz::PalitraLineString {
                coords: vec![
                    Coords {
                        lat: 50.0,
                        lng: 30.0,
                    },
                    Coords {
                        lat: 50.1,
                        lng: 30.1,
                    },
                ],
                color: Some(fallback_color.clone()),
            }],
        )]);

        remap_fallback_geometry_color(
            &mut points_by_color,
            &mut line_strings_by_color,
            Some(selected_color),
        );

        assert!(!points_by_color.contains_key(&fallback_color));
        assert!(!line_strings_by_color.contains_key(&fallback_color));
        assert_eq!(points_by_color.get(selected_color).map(Vec::len), Some(1));
        assert_eq!(
            line_strings_by_color.get(selected_color).map(Vec::len),
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

    #[test]
    fn uses_source_filename_for_goi_remote_name() {
        assert_eq!(
            palitra_goi_remote_file_name(
                418,
                None,
                Some(" Блоки-2023-05-12.KMZ "),
            ),
            "Блоки-2023-05-12.kmz".to_string()
        );
    }

    #[test]
    fn keeps_inner_dots_when_source_filename_has_extension() {
        assert_eq!(
            kmz_file_name_as_kmz("new palitra (27.04).KMZ.kmz"),
            "new palitra (27.04).kmz".to_string()
        );
    }

    #[test]
    fn trims_outer_whitespace_when_source_filename_has_extension() {
        assert_eq!(
            kmz_file_name_as_kmz(" new palitra (27.04).KMZ "),
            "new palitra (27.04).kmz".to_string()
        );
    }

    #[test]
    fn prefers_palitra_name_for_goi_remote_name() {
        assert_eq!(
            palitra_goi_remote_file_name(
                418,
                Some(" Палітра ППО "),
                Some(" Блоки-2023-05-12.KMZ "),
            ),
            "Палітра ППО.kmz".to_string()
        );
    }

    #[test]
    fn strips_duplicate_extension_from_palitra_name() {
        assert_eq!(
            palitra_goi_remote_file_name(
                418,
                Some(" new palitra (27.04).KMZ "),
                Some("ignored.kmz"),
            ),
            "new palitra (27.04).kmz".to_string()
        );
    }

    #[test]
    fn keeps_inner_dots_when_palitra_name_has_no_extension() {
        assert_eq!(
            palitra_goi_remote_file_name(
                418,
                Some(" new palitra (27.04) "),
                Some("ignored.kmz"),
            ),
            "new palitra (27.04).kmz".to_string()
        );
    }

    #[test]
    fn keeps_inner_dots_when_source_filename_has_no_extension() {
        assert_eq!(
            kmz_file_name_as_kmz(" new palitra (27.04) "),
            "new palitra (27.04).kmz".to_string()
        );
    }

    #[test]
    fn falls_back_to_synthetic_goi_remote_name_without_source_filename() {
        assert_eq!(
            palitra_goi_remote_file_name(418, None, None),
            "palitra_000418.kmz".to_string()
        );
    }

    #[test]
    fn includes_name_source_and_legacy_goi_remote_names() {
        assert_eq!(
            palitra_goi_remote_file_names(
                418,
                Some(" Палітра ППО "),
                Some(" Блоки-2023-05-12.KMZ "),
            ),
            vec![
                "Палітра ППО.kmz".to_string(),
                "Блоки-2023-05-12.kmz".to_string(),
                "palitra_000418.kmz".to_string(),
            ]
        );
    }

    #[test]
    fn goi_move_task_preserves_tracked_original_file_path() {
        let generated_file_names =
            palitra_goi_remote_file_names(418, Some("foo"), Some("foo.kmz"));
        let tracked_paths = vec!["sector/foo.gpx".to_string()];

        let tasks = goi_move_tasks_for_target(
            418,
            generated_file_names.as_slice(),
            generated_file_names.first().unwrap(),
            Some("new-sector".to_string()),
            Some("sector"),
            tracked_paths.as_slice(),
        );

        assert_eq!(tasks.len(), 1);
        let task = &tasks[0];
        assert_eq!(task.source_file_names, vec!["foo.gpx".to_string()]);
        assert_eq!(task.target_file_name, "foo.gpx");
        assert_eq!(task.target_folder.as_deref(), Some("new-sector"));
        assert_eq!(task.source_folder_hint.as_deref(), Some("sector"));
        assert_eq!(
            goi_move_task_tracking_update(task),
            Some((
                "sector/foo.gpx".to_string(),
                "new-sector/foo.gpx".to_string()
            ))
        );
    }

    #[test]
    fn goi_move_task_uses_generated_names_without_tracked_path() {
        let generated_file_names =
            palitra_goi_remote_file_names(418, Some("foo"), Some("foo.kmz"));

        let tasks = goi_move_tasks_for_target(
            418,
            generated_file_names.as_slice(),
            generated_file_names.first().unwrap(),
            Some("new-sector".to_string()),
            Some("sector"),
            &[],
        );

        assert_eq!(tasks.len(), 1);
        let task = &tasks[0];
        assert_eq!(task.source_file_names, generated_file_names);
        assert_eq!(task.target_file_name, "foo.kmz");
        assert_eq!(task.target_folder.as_deref(), Some("new-sector"));
        assert_eq!(task.source_folder_hint.as_deref(), Some("sector"));
        assert_eq!(goi_move_task_tracking_update(task), None);
    }
}

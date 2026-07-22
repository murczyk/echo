use crate::config::{
    Config, PALETTE_FILE_LIST_LIMIT, SYNC_LOCK_ADVISORY_KEY,
    SYNC_LOCK_LIVE_TTL_SECS,
};
use crate::http_api::{require_basic_auth, AppState};
use actix_web::error::{
    ErrorBadRequest, ErrorConflict, ErrorInternalServerError, ErrorNotFound,
};
use actix_web::{
    delete, get, post, put, web, Error, HttpRequest, HttpResponse,
};
use anyhow::{bail, Context};
use goi_echo_worker::api::{
    GoiPaletteFileMoveReq, GoiPaletteFileReq, GoiPaletteFilesRsp, GoiService,
    GoiServiceReq, GoiSyncLockAcquireRsp, GoiSyncLockReq,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, Statement, TransactionTrait, TryGetable,
    Value,
};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

#[get("/api/palettes/files")]
pub async fn list_palette_files(
    http_req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let root = ensure_palette_root(&state.config)
        .await
        .map_err(ErrorInternalServerError)?;
    let relative_paths =
        tokio::task::spawn_blocking(move || list_regular_files(&root))
            .await
            .map_err(ErrorInternalServerError)?
            .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(GoiPaletteFilesRsp { relative_paths }))
}

#[post("/api/palettes/file/download")]
pub async fn download_palette_file(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<GoiPaletteFileReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let path = checked_palette_path(&state.config, &req.relative_path)
        .await
        .map_err(ErrorBadRequest)?;
    let metadata = tokio::fs::metadata(&path).await.map_err(|err| match err
        .kind()
    {
        std::io::ErrorKind::NotFound => ErrorNotFound("palette file not found"),
        _ => ErrorInternalServerError(err),
    })?;
    if !metadata.is_file() {
        return Err(ErrorNotFound("palette file not found"));
    }
    let body = tokio::fs::read(path)
        .await
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok()
        .content_type("application/octet-stream")
        .body(body))
}

#[put("/api/palettes/file")]
pub async fn upload_palette_file(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Query<GoiPaletteFileReq>,
    body: web::Bytes,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    if body.is_empty() {
        return Err(ErrorBadRequest("palette file body is empty"));
    }
    let path = checked_palette_path(&state.config, &req.relative_path)
        .await
        .map_err(ErrorBadRequest)?;
    replace_file(&path, body.as_ref())
        .await
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(true))
}

#[delete("/api/palettes/file")]
pub async fn delete_palette_file(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Query<GoiPaletteFileReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let path = checked_palette_path(&state.config, &req.relative_path)
        .await
        .map_err(ErrorBadRequest)?;
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(ErrorInternalServerError(err)),
    }
    Ok(HttpResponse::Ok().json(true))
}

#[post("/api/palettes/file/move")]
pub async fn move_palette_file(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<GoiPaletteFileMoveReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let source = checked_palette_path(&state.config, &req.source_relative_path)
        .await
        .map_err(ErrorBadRequest)?;
    let target = checked_palette_path(&state.config, &req.target_relative_path)
        .await
        .map_err(ErrorBadRequest)?;
    let source_metadata =
        tokio::fs::metadata(&source)
            .await
            .map_err(|err| match err.kind() {
                std::io::ErrorKind::NotFound => {
                    ErrorNotFound("palette source file not found")
                }
                _ => ErrorInternalServerError(err),
            })?;
    if !source_metadata.is_file() {
        return Err(ErrorBadRequest("palette source is not a regular file"));
    }
    if tokio::fs::try_exists(&target)
        .await
        .map_err(ErrorInternalServerError)?
    {
        return Err(ErrorConflict("palette destination already exists"));
    }
    let parent = target
        .parent()
        .context("palette destination has no parent")
        .map_err(ErrorBadRequest)?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(ErrorInternalServerError)?;
    tokio::fs::rename(source, target)
        .await
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(true))
}

#[get("/api/palettes/archive")]
pub async fn download_palettes_archive(
    http_req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let root = ensure_palette_root(&state.config)
        .await
        .map_err(ErrorInternalServerError)?;
    let archive = tokio::task::spawn_blocking(move || palette_archive(&root))
        .await
        .map_err(ErrorInternalServerError)?
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok()
        .content_type("application/zip")
        .body(archive))
}

#[get("/api/knowledge/workbook")]
pub async fn download_knowledge_workbook(
    http_req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let path = state.config.preferred_knowledge_xlsx_path();
    let body =
        tokio::fs::read(&path)
            .await
            .map_err(|err| match err.kind() {
                std::io::ErrorKind::NotFound => {
                    ErrorNotFound("knowledge workbook not found")
                }
                _ => ErrorInternalServerError(
                    anyhow::Error::from(err)
                        .context(format!("reading {}", path.display())),
                ),
            })?;
    Ok(HttpResponse::Ok()
        .content_type(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .body(body))
}

#[put("/api/knowledge/workbook")]
pub async fn upload_knowledge_workbook(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Bytes,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    validate_xlsx(body.as_ref())?;
    let path = state.config.preferred_knowledge_xlsx_path();
    replace_file(&path, body.as_ref())
        .await
        .with_context(|| format!("replacing {}", path.display()))
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(true))
}

#[get("/api/categories")]
pub async fn download_categories(
    http_req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let path = PathBuf::from(state.config.categories_path());
    let body = tokio::fs::read(&path)
        .await
        .with_context(|| format!("reading {}", path.display()))
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .body(body))
}

#[put("/api/categories")]
pub async fn upload_categories(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Bytes,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    serde_json::from_slice::<serde_json::Value>(body.as_ref()).map_err(
        |err| ErrorBadRequest(format!("invalid categories JSON: {err}")),
    )?;
    let path = PathBuf::from(state.config.categories_path());
    replace_file(&path, body.as_ref())
        .await
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(true))
}

#[post("/api/sync-lock/acquire")]
pub async fn acquire_sync_lock(
    http_req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let tx = state.db.begin().await.map_err(ErrorInternalServerError)?;
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [SYNC_LOCK_ADVISORY_KEY.into()],
    ))
    .await
    .map_err(ErrorInternalServerError)?;
    let row = tx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select exists (select 1 from sync_lock where released_at is null and updated_at >= now() - make_interval(secs => $1::double precision)) as is_locked",
            [SYNC_LOCK_LIVE_TTL_SECS.into()],
        ))
        .await
        .map_err(ErrorInternalServerError)?
        .context("sync lock query returned no row")
        .map_err(ErrorInternalServerError)?;
    let is_locked = bool::try_get(&row, "", "is_locked")
        .map_err(|err| ErrorInternalServerError(format!("{err:?}")))?;
    let lock_id = if is_locked {
        None
    } else {
        let lock_id = uuid::Uuid::new_v4().to_string();
        tx.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into sync_lock (id, created_at, updated_at) values ($1::uuid, now(), now())",
            [lock_id.clone().into()],
        ))
        .await
        .map_err(ErrorInternalServerError)?;
        Some(lock_id)
    };
    tx.commit().await.map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(GoiSyncLockAcquireRsp { lock_id }))
}

#[post("/api/sync-lock/refresh")]
pub async fn refresh_sync_lock(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<GoiSyncLockReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    validate_lock_id(&req.lock_id)?;
    update_sync_lock(&state, &req.lock_id, false).await?;
    Ok(HttpResponse::Ok().json(true))
}

#[post("/api/sync-lock/release")]
pub async fn release_sync_lock(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<GoiSyncLockReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    validate_lock_id(&req.lock_id)?;
    update_sync_lock(&state, &req.lock_id, true).await?;
    Ok(HttpResponse::Ok().json(true))
}

#[post("/api/services/restart")]
pub async fn restart_service(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<GoiServiceReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let unit = match req.service {
        GoiService::Swapp => "swapp",
        GoiService::SwappAlt => "swapp-alt",
        GoiService::Goi => "goi",
        GoiService::EchoSwapp => "echo-swapp",
    };
    run_process("systemctl", &["restart", unit], None)
        .await
        .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(true))
}

#[post("/api/services/unlink-whatsapp")]
pub async fn unlink_whatsapp(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<GoiServiceReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    let working_dir = match req.service {
        GoiService::Swapp => "/etc/swapp",
        GoiService::SwappAlt => "/etc/swapp-alt",
        GoiService::Goi | GoiService::EchoSwapp => {
            return Err(ErrorBadRequest(
                "WhatsApp unlink is available only for SWAPP services",
            ));
        }
    };
    run_process(
        "npm",
        &["run", "whatsapp:delete"],
        Some(Path::new(working_dir)),
    )
    .await
    .map_err(ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(true))
}

async fn update_sync_lock(
    state: &AppState,
    lock_id: &str,
    release: bool,
) -> Result<(), Error> {
    let (sql, values): (&str, Vec<Value>) = if release {
        (
            "update sync_lock set updated_at = now(), released_at = now() where id = $1::uuid and released_at is null",
            vec![lock_id.to_string().into()],
        )
    } else {
        (
            "update sync_lock set updated_at = now() where id = $1::uuid and released_at is null and updated_at >= now() - make_interval(secs => $2::double precision)",
            vec![
                lock_id.to_string().into(),
                SYNC_LOCK_LIVE_TTL_SECS.into(),
            ],
        )
    };
    let result = state
        .db
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .map_err(ErrorInternalServerError)?;
    if result.rows_affected() == 0 {
        return Err(ErrorNotFound("active sync lock not found"));
    }
    Ok(())
}

fn validate_lock_id(lock_id: &str) -> Result<(), Error> {
    uuid::Uuid::parse_str(lock_id)
        .map(|_| ())
        .map_err(|_| ErrorBadRequest("invalid sync lock id"))
}

async fn run_process(
    program: &str,
    args: &[&str],
    working_dir: Option<&Path>,
) -> anyhow::Result<()> {
    let program = program.to_string();
    let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    let working_dir = working_dir.map(Path::to_path_buf);
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&program);
        command.args(&args);
        if let Some(working_dir) = working_dir {
            command.current_dir(working_dir);
        }
        let output = command.output().context("starting feature command")?;
        if output.status.success() {
            return Ok(());
        }
        bail!(
            "feature command failed with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })
    .await
    .context("joining feature command")?
}

async fn ensure_palette_root(config: &Config) -> anyhow::Result<PathBuf> {
    let root = PathBuf::from(config.palettes_path());
    tokio::fs::create_dir_all(&root).await?;
    tokio::fs::canonicalize(root)
        .await
        .context("canonicalizing palettes root")
}

async fn checked_palette_path(
    config: &Config,
    raw_relative_path: &str,
) -> anyhow::Result<PathBuf> {
    let relative_path = normalize_relative_path(raw_relative_path)?;
    let root = ensure_palette_root(config).await?;
    let mut current = root.clone();
    for component in relative_path.components() {
        let Component::Normal(component) = component else {
            continue;
        };
        current.push(component);
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!("palette path may not traverse symbolic links")
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(root.join(relative_path))
}

fn normalize_relative_path(raw_relative_path: &str) -> anyhow::Result<PathBuf> {
    let raw_relative_path = raw_relative_path.trim().trim_start_matches("./");
    let path = Path::new(raw_relative_path);
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(component) => normalized.push(component),
            Component::CurDir => {}
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                bail!("palette path must be relative and may not contain '..'")
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        bail!("palette path is empty");
    }
    Ok(normalized)
}

fn list_regular_files(root: &Path) -> anyhow::Result<Vec<String>> {
    let mut paths = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative_path = entry.path().strip_prefix(root)?;
        paths.push(relative_path.to_string_lossy().replace('\\', "/"));
        if paths.len() > PALETTE_FILE_LIST_LIMIT {
            bail!("palette file count exceeds limit {PALETTE_FILE_LIST_LIMIT}");
        }
    }
    paths.sort();
    Ok(paths)
}

fn palette_archive(root: &Path) -> anyhow::Result<Vec<u8>> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for relative_path in list_regular_files(root)? {
        let path = root.join(&relative_path);
        archive.start_file(format!("palettes/{relative_path}"), options)?;
        let mut file = std::fs::File::open(path)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        archive.write_all(&data)?;
    }
    Ok(archive.finish()?.into_inner())
}

async fn replace_file(path: &Path, body: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("file path has no parent directory")?;
    tokio::fs::create_dir_all(parent).await?;
    let tmp_path = temp_file_path(path);
    tokio::fs::write(&tmp_path, body).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(
            &tmp_path,
            std::fs::Permissions::from_mode(0o644),
        )
        .await?;
    }
    if let Err(err) = tokio::fs::rename(&tmp_path, path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(err.into());
    }
    Ok(())
}

fn temp_file_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(".{file_name}.tmp-{suffix}"))
}

fn validate_xlsx(body: &[u8]) -> Result<(), Error> {
    if body.len() < 4 || &body[..4] != b"PK\x03\x04" {
        return Err(ErrorBadRequest("request body is not an XLSX file"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_relative_path_rejects_parent_traversal() {
        assert!(normalize_relative_path("../outside").is_err());
        assert!(normalize_relative_path("folder/../../outside").is_err());
    }

    #[test]
    fn palette_relative_path_normalizes_current_directory() {
        assert_eq!(
            normalize_relative_path("./folder/file.kmz").unwrap(),
            PathBuf::from("folder/file.kmz")
        );
    }
}

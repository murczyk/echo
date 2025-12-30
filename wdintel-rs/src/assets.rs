use crate::config::get_assets_folder;
use crate::error::AppError;
use crate::types::{Env, ShortContext};
use actix_files::NamedFile;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use log::error;
use std::path::PathBuf;
use uuid::Uuid;

pub async fn serve_assets(
    user: actix_identity::Identity,
    req: HttpRequest,
    env: web::Data<Env>,
) -> Result<impl Responder, AppError> {
    let login = user.id().c(crate::h!())?;
    crate::users::has_role(&env.dbx, &login, "Basic")
        .await
        .c(crate::h!())?;

    let path: PathBuf = req.match_info().query("filename").parse().unwrap();
    let local_path = PathBuf::from(get_assets_folder(&env.config)).join(&path);

    // 1. Attempt to serve from local storage
    if local_path.exists() && local_path.is_file() {
        if let Ok(named_file) = NamedFile::open(local_path) {
            return Ok(named_file.into_response(&req));
        }
    }

    // 2. Fallback: Attempt to read from S3
    let m_id = path
        .as_path()
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .and_then(|s| Uuid::parse_str(&s).ok());

    let m_body = match m_id {
        None => None,
        Some(id) => {
            let key = crate::storage::nested_object_key(&id);
            match crate::messenger::media::fetch_media_bytes_by_key(&env, &key)
                .await
            {
                Ok(body) => Some(body),
                Err(e) => {
                    error!("failed to load asset: {e:?}");
                    None
                }
            }
        }
    };

    match m_body {
        Some(body) => Ok(HttpResponse::Ok()
            .content_type("application/octet-stream")
            .body(body)),
        None => Ok(HttpResponse::NotFound().body("Asset not found")),
    }
}

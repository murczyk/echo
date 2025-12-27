use crate::config::get_assets_folder;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_files::NamedFile;
use actix_web::{get, web, HttpRequest, HttpResponse, Responder};
use std::path::PathBuf;

pub async fn serve_assets(
    req: HttpRequest,
    env: web::Data<Env>,
) -> impl Responder {
    let path: PathBuf = req.match_info().query("filename").parse().unwrap();
    let local_path = PathBuf::from(get_assets_folder(&env.config)).join(&path);

    // 1. Attempt to serve from local storage
    if local_path.exists() && local_path.is_file() {
        if let Ok(named_file) = NamedFile::open(local_path) {
            return named_file.into_response(&req);
        }
    }

    // 2. Fallback: Attempt to read from S3
    let key = path
        .as_path()
        .file_stem()
        .c(h!())?
        .to_string_lossy()
        .to_string();

    match crate::messenger::media::fetch_media_bytes_by_key(&env, &key).await {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/octet-stream")
            .body(body),
        Err(_) => HttpResponse::NotFound().body("Asset not found"),
    }
}

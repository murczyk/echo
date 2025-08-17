use crate::types::*;
use actix_web::http::header::HeaderName;
use actix_web::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Params {
    msg: String,
}

#[get("/api/log-error.json")]
pub async fn log_error(req: HttpRequest) -> HttpResponse {
    let referer = match extract_referer_header(&req) {
        None => "".to_string(),
        Some(referer) => format!(" at {referer}"),
    };
    let params = web::Query::<Params>::from_query(req.query_string()).unwrap();

    error!("an error occurred on web UI{}: {}", referer, params.msg);
    HttpResponse::Ok().body("")
}

fn extract_referer_header(req: &HttpRequest) -> Option<String> {
    let referer_header = req
        .headers()
        .get(HeaderName::from_static("referer"))?;
    if let Ok(referer_str) = referer_header.to_str() {
        Some(referer_str.to_string())
    } else {
        None
    }
}

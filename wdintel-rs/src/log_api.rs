use crate::types::*;
use actix_web::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Params {
    msg: String,
}

#[get("/api/log-error.json")]
pub async fn log_error(req: HttpRequest) -> HttpResponse {
    let params = web::Query::<Params>::from_query(req.query_string()).unwrap();
    error!("an error occurred on web UI: {}", params.msg);
    HttpResponse::Ok().body("")
}

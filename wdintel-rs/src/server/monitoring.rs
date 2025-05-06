use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{get, post, HttpResponse, Responder};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};

#[get("/api/ping")]
async fn ping() -> impl Responder {
    HttpResponse::Ok().body("pong")
}

#[get("/api-public/ping")]
async fn public_ping() -> impl Responder {
    HttpResponse::Ok().body("pong in public")
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ServerInfo {
    pub mode: String,
    pub public_host: String,
    pub grafana_address: String,
    pub feature_delta: bool,
    pub feature_analysis_map: bool,
}

#[post("/api-public/server-info")]
async fn server_info(
    env: actix_web::web::Data<Env>,
) -> Result<Json<ServerInfo>, AppError> {
    Ok(Json(ServerInfo {
        mode: env.mode.to_string(),
        public_host: env.config.public_host.clone(),
        grafana_address: format!("https://{}/grafana", env.config.public_host),
        feature_delta: env.config.feature_delta.unwrap_or(false),
        feature_analysis_map: env.config.feature_analysis_map.unwrap_or(true),
    }))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MonitoringDatasource {
    pub display_name: String,
    pub latest_signal_message_created_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Monitoring {
    pub datasources: Vec<MonitoringDatasource>,
}

#[post("/api/monitoring")]
async fn monitoring(
    env: actix_web::web::Data<Env>,
) -> Result<Json<Monitoring>, AppError> {
    let datasources = datasource::Entity::find()
        .filter(datasource::Column::Enabled.eq(true))
        .all(&env.dbx)
        .await?;
    let mut datasources_res = vec![];
    let week_ago = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::days(7))
        .unwrap();
    for datasource in datasources {
        let latest_signal_message_created_at_ms =
            signal_message::Entity::find()
                .filter(signal_message::Column::DatasourceId.eq(datasource.id))
                .filter(signal_message::Column::CreatedAt.gt(week_ago))
                .filter(signal_message::Column::Deleted.eq(false))
                .order_by_desc(signal_message::Column::CreatedAt)
                .one(&env.dbx)
                .await?
                .map(|x| x.created_at.and_utc().timestamp_millis())
                .unwrap_or(week_ago.timestamp_millis());
        datasources_res.push(MonitoringDatasource {
            display_name: datasource.display_name,
            latest_signal_message_created_at_ms,
        });
    }
    Ok(Json(Monitoring {
        datasources: datasources_res,
    }))
}

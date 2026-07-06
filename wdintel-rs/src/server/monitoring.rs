use crate::config::SERVER_MONITORING_CACHE_TTL_SEC;
use crate::error::AppError;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{get, post, HttpResponse, Responder};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use fs2::available_space;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

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
    pub feature_strict_networks: bool,
    pub feature_my_admin_groups_edit: bool,
    pub version: String,
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
        feature_strict_networks: env
            .config
            .feature_strict_networks
            .unwrap_or(false),
        feature_my_admin_groups_edit: env
            .config
            .feature_my_admin_groups_edit
            .unwrap_or(false),
        version: env.version.clone(),
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
    pub free_space_root_mb: i64,
}

#[derive(Clone)]
struct MonitoringCache {
    updated_at: Instant,
    monitoring: Monitoring,
}

static MONITORING_CACHE: OnceLock<Mutex<Option<MonitoringCache>>> =
    OnceLock::new();

#[post("/api/monitoring")]
async fn monitoring(
    env: actix_web::web::Data<Env>,
) -> Result<Json<Monitoring>, AppError> {
    let cache = MONITORING_CACHE.get_or_init(|| Mutex::new(None));
    let mut cache = cache.lock().await;
    if let Some(cache) = cache.as_ref() {
        if cache.updated_at.elapsed()
            < Duration::from_secs(SERVER_MONITORING_CACHE_TTL_SEC)
        {
            return Ok(Json(cache.monitoring.clone()));
        }
    }

    let monitoring = load_monitoring(env).await.c(h!())?;
    *cache = Some(MonitoringCache {
        updated_at: Instant::now(),
        monitoring: monitoring.clone(),
    });

    Ok(Json(monitoring))
}

async fn load_monitoring(
    env: actix_web::web::Data<Env>,
) -> Result<Monitoring, AppError> {
    let data = echo_im::collect_monitoring_data(&env.dbx).await.c(h!())?;
    let mut datasources = vec![];
    for d in data {
        datasources.push(MonitoringDatasource {
            display_name: d.display_name,
            latest_signal_message_created_at_ms: d
                .last_inbox_at_ms
                .unwrap_or(d.last_sync_at_ms),
        });
    }
    Ok(Monitoring {
        datasources,
        free_space_root_mb: root_free_space_mb(),
    })
}

fn root_free_space_mb() -> i64 {
    const BYTES_IN_MB: u64 = 1_048_576;
    let root_path = Path::new("/");
    match available_space(root_path) {
        Ok(bytes) => {
            let mb = bytes / BYTES_IN_MB;
            (mb.min(i64::MAX as u64)) as i64
        }
        Err(err) => {
            warn!(
                "Failed to read free space for root partition {}: {err}",
                root_path.display()
            );
            0
        }
    }
}

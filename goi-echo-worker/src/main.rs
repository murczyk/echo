mod config;
mod db;
mod entities;
mod http_api;
mod migration;
mod worker;

use actix_web::{web, App, HttpServer};
use anyhow::Result;
use http_api::{import_signed_frequencies, list_associations, AppState};

#[actix_web::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config = config::read_config()?;
    let db = db::connect(&config).await?;
    migration::run_migration(&db).await?;

    let worker_db = db.clone();
    let worker_config = config.clone();
    tokio::spawn(async move {
        worker::associations_worker_nofail(worker_db, worker_config).await;
    });

    let state = AppState {
        db,
        config: config.clone(),
    };
    log::info!(
        "starting goi-echo-worker on {}:{}",
        config.listen_host(),
        config.listen_port()
    );
    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .service(list_associations)
            .service(import_signed_frequencies)
    })
    .bind((config.listen_host(), config.listen_port()))?
    .run()
    .await?;

    Ok(())
}

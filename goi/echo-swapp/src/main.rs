mod api;
mod automation;
mod config;
mod db;
mod error;
mod messenger;
mod ui;
mod worker;

use crate::error::ShortContext;
use actix_web::{middleware::Logger, web, App, HttpServer};
use anyhow::Result;
use config::Config;
use sea_orm::DatabaseConnection;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: DatabaseConnection,
}

#[actix_web::main]
async fn main() -> Result<()> {
    env_logger::init();
    let config = config::read_config().c(h!())?;
    let db = db::connect(&config).await.c(h!())?;
    echo_im::run_migration(&db).await.c(h!())?;
    automation::ensure_schema(&db).await.c(h!())?;
    messenger::ensure_pause_state_storage(&db).await.c(h!())?;
    worker::spawn_workers(db.clone());
    let state = web::Data::new(AppState {
        config: config.clone(),
        db,
    });
    let bind = format!("{}:{}", config.listen_host(), config.listen_port());
    log::info!("starting echo-swapp on {bind}");

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .wrap(Logger::default())
            .service(ui::index)
            .service(ui::echo_logo)
            .configure(api::configure)
    })
    .bind(bind)
    .c(h!())?
    .run()
    .await
    .c(h!())?;

    Ok(())
}

mod api;
mod automation;
mod chat_redis;
mod chats;
mod config;
mod db;
mod error;
mod map_screenshot;
mod messenger;
mod ui;
mod worker;

use crate::error::ShortContext;
use actix_web::{middleware::Logger, web, App, HttpServer};
use anyhow::Result;
use config::{Config, ECHO_MESSENGERS_JSON_PAYLOAD_MAX_BYTES};
use sea_orm::DatabaseConnection;

enum Cmd {
    Serve,
    Migrate,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: DatabaseConnection,
    pub chat_redis: chat_redis::ChatRedis,
}

#[actix_web::main]
async fn main() -> Result<()> {
    env_logger::init();
    let cmd = cmd().c(h!())?;
    let config = config::read_config().c(h!())?;
    let db = db::connect(&config).await.c(h!())?;
    migrate(&db).await.c(h!())?;
    if matches!(cmd, Cmd::Migrate) {
        return Ok(());
    }
    serve(config, db).await.c(h!())
}

fn cmd() -> Result<Cmd> {
    match std::env::args().nth(1).as_deref() {
        None => Ok(Cmd::Serve),
        Some("migrate") => Ok(Cmd::Migrate),
        Some(cmd) => Err(anyhow::anyhow!("unknown command: {cmd}")),
    }
}

async fn migrate(db: &DatabaseConnection) -> Result<()> {
    echo_im::run_migration(db).await.c(h!())?;
    automation::ensure_schema(db).await.c(h!())?;
    messenger::ensure_schema(db).await.c(h!())?;
    chats::ensure_schema(db).await.c(h!())?;
    Ok(())
}

async fn serve(config: Config, db: DatabaseConnection) -> Result<()> {
    messenger::recover_interrupted_relinks(&db, &config)
        .await
        .c(h!())?;
    std::fs::create_dir_all(config.chat_storage_dir()).c(h!())?;
    let chat_redis = chat_redis::ChatRedis::connect(&config).await;
    worker::spawn_workers(db.clone(), config.clone(), chat_redis.clone());
    let state = web::Data::new(AppState {
        config: config.clone(),
        db,
        chat_redis,
    });
    let bind = format!("{}:{}", config.listen_host(), config.listen_port());
    log::info!("starting echo-messengers on {bind}");

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(
                web::JsonConfig::default()
                    .limit(ECHO_MESSENGERS_JSON_PAYLOAD_MAX_BYTES),
            )
            .wrap(Logger::default())
            .service(ui::index)
            .service(ui::echo_logo)
            .service(ui::leaflet_css)
            .service(ui::leaflet_js)
            .service(ui::chat_css)
            .service(ui::chat_js)
            .configure(api::configure)
    })
    .bind(bind)
    .c(h!())?
    .run()
    .await
    .c(h!())?;

    Ok(())
}

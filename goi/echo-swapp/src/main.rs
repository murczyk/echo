mod api;
mod config;
mod db;
mod messenger;
mod ui;

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
    let config = config::read_config()?;
    let db = db::connect(&config).await?;
    echo_im::run_migration(&db).await?;
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
            .configure(api::configure)
    })
    .bind(bind)?
    .run()
    .await?;

    Ok(())
}

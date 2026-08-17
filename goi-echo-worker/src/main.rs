macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

mod config;
mod db;
mod entities;
mod http_api;
mod migration;
mod remote_api;
mod worker;
mod xlsx_sync;

use actix_web::{middleware::Compress, web, App, HttpServer};
use anyhow::Result;
use http_api::{
    import_signed_frequencies, list_associations, list_knowledge, AppState,
};
use remote_api::{
    acquire_sync_lock, delete_palette_file, download_categories,
    download_knowledge_workbook, download_palette_file,
    download_palettes_archive, list_palette_files, move_palette_file,
    refresh_sync_lock, release_sync_lock, restart_service, unlink_whatsapp,
    upload_categories, upload_knowledge_workbook, upload_palette_file,
};

#[actix_web::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config = config::read_config()?;
    let db = db::connect(&config).await?;
    migration::run_migration(&db).await?;
    worker::ensure_xlsx_files_exist(&config).await?;

    let worker_db = db.clone();
    let worker_config = config.clone();
    tokio::spawn(async move {
        worker::associations_worker_nofail(worker_db, worker_config).await;
    });
    let knowledge_worker_db = db.clone();
    let knowledge_worker_config = config.clone();
    tokio::spawn(async move {
        worker::knowledge_worker_nofail(
            knowledge_worker_db,
            knowledge_worker_config,
        )
        .await;
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
            .wrap(Compress::default())
            .app_data(web::Data::new(state.clone()))
            .app_data(web::PayloadConfig::new(config::API_FILE_BODY_MAX_BYTES))
            .service(list_associations)
            .service(list_knowledge)
            .service(import_signed_frequencies)
            .service(list_palette_files)
            .service(download_palette_file)
            .service(upload_palette_file)
            .service(delete_palette_file)
            .service(move_palette_file)
            .service(download_palettes_archive)
            .service(download_knowledge_workbook)
            .service(upload_knowledge_workbook)
            .service(download_categories)
            .service(upload_categories)
            .service(acquire_sync_lock)
            .service(refresh_sync_lock)
            .service(release_sync_lock)
            .service(restart_service)
            .service(unlink_whatsapp)
    })
    .bind((config.listen_host(), config.listen_port()))?
    .run()
    .await?;

    Ok(())
}

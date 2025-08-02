use crate::config::Config;
use crate::datasource::importer::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::location::SettlementsData;
use crate::types::*;
use crate::{OneoffExportDataSourcePs, OneoffImportDataSourcePs};
use chrono::Utc;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod bl;
mod types;

#[tokio::main]
pub async fn oneoff_import_datasource(
    mode: Mode,
    params: OneoffImportDataSourcePs,
) -> Result<(), AppError> {
    info!("starting oneoff_import_datasource...");
    let mut file = File::open(&params.source_path).await.context(h!())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).await.context(h!())?;
    let data: DataSourceFile = serde_json::from_str(&contents).context(h!())?;
    info!(
        "importing from {}: data source {} exported at {}; groups - {}, profiles - {}, messages - {}",
        data.source_server,
        data.datasource.datasource.display_name,
        data.created_at,
        data.groups_count,
        data.profiles_count,
        data.inbox_items_count
    );
    let should_import = data.groups_count > 0
        || data.profiles_count > 0
        || data.inbox_items_count > 0;
    if !should_import {
        info!("nothing to import, skipping...");
    } else {
        let config = crate::config::read_config(mode).context(h!())?;
        let db = crate::new_pg_pool_from_config(&config)
            .await
            .context(h!())?;
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(
                config.settlement_paths().context(h!())?,
            )
            .context(h!())?,
        ));
        let rq: reqwest::Client = reqwest::Client::builder()
            .timeout(core::time::Duration::from_secs(
                crate::config::RQ_TIMEOUT_SIGNAL_API,
            ))
            .build()?;
        let redis = crate::new_redis(&config).await.context(h!())?;
        import_data(data.datasource, db, settlements, config, redis, rq)
            .await
            .context(h!())?;
    }

    info!("done oneoff_import_datasource!");
    Ok(())
}

#[tokio::main]
pub async fn oneoff_export_datasource(
    mode: Mode,
    params: OneoffExportDataSourcePs,
) -> Result<(), AppError> {
    info!("starting oneoff_export_datasource...");
    let config = crate::config::read_config(mode).context(h!())?;
    let db = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let mut destination_file =
        File::create(&params.destination_path).await.context(h!())?;
    let exported_data =
        collect_datasource_data(params, db).await.context(h!())?;

    let result = DataSourceFile {
        source_server: config.public_host.to_string(),
        created_at: Utc::now().naive_utc(),
        groups_count: exported_data.signal_groups.len() as i64,
        profiles_count: exported_data.profiles.len() as i64,
        inbox_items_count: exported_data.messages.len() as i64,
        datasource: exported_data,
    };

    let data = serde_json::to_string(&result).context(h!())?;
    destination_file
        .write_all(data.as_bytes())
        .await
        .context(h!())?;
    info!("done oneoff_export_datasource!");
    Ok(())
}

async fn collect_datasource_data(
    params: OneoffExportDataSourcePs,
    db: DatabaseConnection,
) -> anyhow::Result<DatasourceDetails> {
    let datasource = datasource::Entity::find_by_id(params.datasource_id)
        .one(&db)
        .await
        .context(h!())?
        .context(h!())?;

    let profiles = signal_profile::Entity::find()
        .all(&db)
        .await
        .context(h!())?;

    let signal_groups =
        signal_group::Entity::find().all(&db).await.context(h!())?;

    let whatsapp_groups = whatsapp_group::Entity::find()
        .all(&db)
        .await
        .context(h!())?;

    let messages = sigint_inbox_item::Entity::find()
        .find_with_related(signal_message::Entity)
        .all(&db)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|(item, messages)| {
            messages
                .into_iter()
                .map(move |message| (item.clone(), message))
        })
        .map(|(inbox_item, message)| Message {
            inbox_item,
            message,
        })
        .collect::<Vec<_>>();

    let exported_data = DatasourceDetails {
        datasource,
        profiles,
        signal_groups,
        whatsapp_groups,
        messages,
    };

    Ok(exported_data)
}

async fn import_data(
    imported_data: DatasourceDetails,
    db: DatabaseConnection,
    settlements: Arc<RwLock<SettlementsData>>,
    config: Config,
    redis: ConnectionManager,
    rq: Client,
) -> anyhow::Result<()> {
    let datasource_id_mapping =
        bl::upsert_datasource(&db, imported_data.datasource)
            .await
            .context(h!())?;
    println!(
        "imported datasource {} as {}",
        datasource_id_mapping.0, datasource_id_mapping.1
    );
    let signal_profiles_map =
        bl::upsert_signal_profiles(&db, imported_data.profiles)
            .await
            .context(h!())?;
    bl::upsert_signal_groups(
        &db,
        imported_data.signal_groups,
        datasource_id_mapping,
    )
    .await
    .context(h!())?;
    bl::upsert_whatsapp_groups(&db, imported_data.whatsapp_groups)
        .await
        .context(h!())?;
    bl::upsert_messages(
        &db,
        imported_data.messages,
        datasource_id_mapping,
        signal_profiles_map,
        settlements,
        config,
        redis,
        rq,
    )
    .await
    .context(h!())?;
    Ok(()) // fixme
}

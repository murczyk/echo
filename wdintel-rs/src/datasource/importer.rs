use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::{OneoffExportDataSourcePs, OneoffImportDataSourcePs};
use chrono::Utc;
use sea_orm::{DatabaseConnection, EntityTrait};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DataSourceFile {
    pub source_server: String,
    pub created_at: NaiveDateTime,
    pub groups_count: i64,
    pub profiles_count: i64,
    pub inbox_items_count: i64,
    pub datasource: DatasourceDetails,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DatasourceDetails {
    pub datasource: datasource::Model,
    pub profiles: Vec<signal_profile::Model>,
    pub signal_groups: Vec<signal_group::Model>,
    pub whatsapp_groups: Vec<whatsapp_group::Model>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Message {
    pub message: signal_message::Model,
    pub inbox_item: sigint_inbox_item::Model,
}

#[tokio::main]
pub async fn oneoff_import_datasource(
    mode: Mode,
    params: OneoffImportDataSourcePs,
) -> Result<(), AppError> {
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
        tokio::fs::File::create(&params.destination_path)
            .await
            .context(h!())?;
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

    let exported_data = DatasourceDetails {
        datasource,
        profiles: vec![],
        signal_groups: vec![],
        whatsapp_groups: vec![],
        messages: vec![],
    };
    Ok(exported_data)
}

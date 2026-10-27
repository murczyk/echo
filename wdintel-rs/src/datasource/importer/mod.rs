use crate::config::Config;
use crate::datasource::importer::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::location::SettlementsDataConfig;
use crate::types::*;
use crate::{OneoffExportDataSourcePs, OneoffImportDataSourcePs};
use chrono::Utc;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use std::collections::BTreeMap;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod bl;
mod types;

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
        validate_external_import(&db, &data.datasource)
            .await
            .c(h!())?;
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().context(h!())?,
                mode,
            )
            .context(h!())?,
        ));
        crate::location::aor_config::init_aor_location_config(
            &db,
            settlements.clone(),
        )
        .await
        .context(h!())?;
        let rq: reqwest::Client = reqwest::Client::builder()
            .timeout(core::time::Duration::from_secs(
                crate::config::RQ_TIMEOUT_SIGNAL_API,
            ))
            .build()
            .context(h!())?;
        let redis = crate::new_redis(&config).await.context(h!())?;
        import_data(data.datasource, db, settlements, config, redis, rq)
            .await
            .context(h!())?;
    }

    info!("done oneoff_import_datasource!");
    Ok(())
}

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

    let signal_groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_group::Relation::DatasourceGroup.def(),
        )
        .filter(datasource_group::Column::DatasourceId.eq(params.datasource_id))
        .all(&db)
        .await
        .context(h!())?;

    let whatsapp_groups = whatsapp_group::Entity::find()
        .filter(whatsapp_group::Column::Deleted.eq(false))
        .all(&db)
        .await
        .context(h!())?;

    let datasource_groups = datasource_group::Entity::find()
        .filter(datasource_group::Column::DatasourceId.eq(params.datasource_id))
        .all(&db)
        .await
        .context(h!())?;

    let group_ids = datasource_groups.iter().map(|g| g.id).collect::<Vec<_>>();

    let mut messages_q = sigint_inbox_item::Entity::find()
        .find_with_related(signal_message::Entity)
        .filter(signal_message::Column::DatasourceGroupId.eq_any(group_ids));

    if let Some(since_ms) = params.since_epoch_ms {
        if let Some(datetime) =
            chrono::DateTime::from_timestamp_millis(since_ms)
        {
            let since = datetime.naive_utc();
            info!("collecting messages since {since}");
            messages_q = messages_q
                .filter(sigint_inbox_item::Column::Datetime.gte(since));
        }
    }

    if let Some(till_ms) = params.till_epoch_ms {
        if let Some(datetime) = chrono::DateTime::from_timestamp_millis(till_ms)
        {
            let till = datetime.naive_utc();
            info!("collecting messages till {till}");
            messages_q = messages_q
                .filter(sigint_inbox_item::Column::Datetime.lte(till));
        }
    }

    let message_pairs = messages_q
        .all(&db)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|(item, messages)| {
            messages
                .into_iter()
                .map(move |message| (item.clone(), message))
        })
        .collect::<Vec<_>>();

    let message_ids = message_pairs
        .iter()
        .map(|(_, message)| message.id)
        .collect::<Vec<_>>();

    let mut group_map: BTreeMap<i64, Vec<signal_message_group::Model>> =
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq_any(message_ids),
            )
            .all(&db)
            .await
            .context(h!())?
            .into_iter()
            .fold(BTreeMap::new(), |mut acc, group| {
                acc.entry(group.signal_message_id).or_default().push(group);
                acc
            });

    let messages = message_pairs
        .into_iter()
        .map(|(inbox_item, message)| Message {
            inbox_item,
            message_groups: group_map.remove(&message.id).unwrap_or_default(),
            message,
        })
        .collect::<Vec<_>>();

    let exported_data = DatasourceDetails {
        datasource,
        profiles,
        signal_groups,
        whatsapp_groups,
        datasource_groups,
        messages,
    };

    Ok(exported_data)
}

async fn import_data(
    imported_data: DatasourceDetails,
    db: DatabaseConnection,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    config: Config,
    redis: ConnectionManager,
    rq: Client,
) -> anyhow::Result<()> {
    validate_external_import(&db, &imported_data)
        .await
        .c(h!())?;
    let datasource_id_mapping =
        bl::upsert_datasource(&db, imported_data.datasource)
            .await
            .context(h!())?;
    println!(
        "imported datasource {} as {}",
        datasource_id_mapping.0, datasource_id_mapping.1
    );

    let count = imported_data.profiles.len();
    bl::upsert_signal_profiles(&db, imported_data.profiles)
        .await
        .context(h!())?;
    println!("imported {count} signal profiles");

    let count = imported_data.signal_groups.len();
    let (_, target_datasource_id) = datasource_id_mapping;
    bl::upsert_signal_groups(
        &db,
        imported_data.signal_groups.clone(),
        target_datasource_id,
    )
    .await
    .context(h!())?;
    println!("imported {count} signal groups");

    let count = imported_data.whatsapp_groups.len();
    bl::upsert_whatsapp_groups(&db, imported_data.whatsapp_groups)
        .await
        .context(h!())?;
    println!("imported {count} whatsapp groups");

    bl::upsert_messages(
        &db,
        imported_data.messages,
        imported_data.datasource_groups,
        datasource_id_mapping,
        settlements,
        config,
        redis,
        rq,
    )
    .await
    .context(h!())?;
    Ok(())
}

async fn validate_external_import<C: ConnectionTrait>(
    db: &C,
    data: &DatasourceDetails,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        data.datasource.kind != crate::config::DATASOURCE_ECHO_NATIVE_KIND,
        "Імпорт службового джерела Echo не підтримується"
    );
    let mut keys = std::collections::BTreeSet::new();
    keys.extend(data.datasource.group_master_key.iter().cloned());
    keys.extend(
        data.signal_groups
            .iter()
            .map(|group| group.master_key.clone()),
    );
    keys.extend(data.whatsapp_groups.iter().map(|group| group.jid.clone()));
    keys.extend(
        data.datasource_groups
            .iter()
            .map(|group| group.group_master_key.clone()),
    );
    keys.extend(
        data.messages
            .iter()
            .flat_map(|message| &message.message_groups)
            .filter_map(|group| group.group_master_key.clone()),
    );
    crate::datasource::native::require_external_group_keys(
        db,
        &keys.into_iter().collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_datasource, mk_datasource_group, mk_sigint_inbox_item,
        mk_signal_message, mk_signal_message_group,
    };
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn native_import_rejection_precedes_all_import_writes() {
        let env = cleanup().await.unwrap();
        let native = crate::datasource::native::load(&env.dbx).await.unwrap();
        let external =
            mk_datasource(&env.dbx, Default::default()).await.unwrap();
        let mapping = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                datasource_id: Set(external.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(mapping.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message_group = mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                datasource_group_id: Set(Some(mapping.id)),
                group_master_key: Set(Some(mapping.group_master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut external = external;
        external.kind = "external-import-attempt".into();
        let empty_import = DatasourceDetails {
            datasource: external,
            profiles: vec![],
            signal_groups: vec![],
            whatsapp_groups: vec![],
            datasource_groups: vec![],
            messages: vec![],
        };
        let native_key = format!(
            "{}{}",
            crate::config::DATASOURCE_ECHO_NATIVE_GROUP_PREFIX,
            uuid::Uuid::new_v4()
        );
        let mut source_import = empty_import.clone();
        source_import.datasource = native;
        let mut mapping_import = empty_import.clone();
        let mut mapping = mapping;
        mapping.group_master_key = native_key.clone();
        mapping_import.datasource_groups.push(mapping);
        let mut message_import = empty_import;
        let mut message_group = message_group;
        message_group.group_master_key = Some(native_key);
        message_import.messages.push(Message {
            message,
            inbox_item: inbox,
            message_groups: vec![message_group],
        });
        let before = datasource::Entity::find().count(&env.dbx).await.unwrap();
        for data in [source_import, mapping_import, message_import] {
            assert!(import_data(
                data,
                env.dbx.clone(),
                env.settlements.clone(),
                env.config.clone(),
                env.redis.clone(),
                env.rq.clone()
            )
            .await
            .is_err());
            assert_eq!(
                datasource::Entity::find().count(&env.dbx).await.unwrap(),
                before
            );
        }
    }
}

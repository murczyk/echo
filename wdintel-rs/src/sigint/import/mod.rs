pub mod types;

use crate::entities::{sigint_signal, sigint_signal_changelog};
use crate::error::AppError;
use crate::h;
use crate::sigint::import::types::*;
use crate::types::Mode;
use anyhow::Context;
use chrono::Utc;
use dialoguer::{theme::ColorfulTheme, Confirm};
use log::{info, warn};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, NotSet,
    QueryFilter, Set, TransactionTrait,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
pub async fn oneoff_import_etalon_data(
    mode: Mode,
    path: String,
    autocommit: bool,
) -> Result<(), AppError> {
    info!("importing etalon from {path}");

    let mut file_read = File::open(path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon = String::from_utf8_lossy(&buffer).to_string();
    let etalon: EtalonData = serde_json::from_str(&etalon).context(h!())?;

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    describe_etalon(&etalon);
    let committed = {
        let txn = dbx.begin().await.context(h!())?;
        let ok = import_etalon_data(&txn, etalon.clone(), true)
            .await
            .context(h!())?;
        let should_commit = ok && autocommit;
        if should_commit {
            txn.commit().await.context(h!())?;
            info!("Import completed.")
        }
        should_commit
    };
    if !committed {
        if Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Confirm import?")
            .interact()
            .context(h!())?
        {
            import_etalon_data(&dbx, etalon.clone(), false)
                .await
                .context(h!())?;
            info!("Import completed.")
        } else {
            info!("Import aborted.")
        }
    }
    Ok(())
}

fn describe_etalon(etalon: &EtalonData) {
    info!("------------------");
    info!("Importing etalon data");
    info!("- sigint_signal records: {}", etalon.sigint_signal.len());
    info!(
        "- sigint_signal_changelog records: {}",
        etalon.sigint_signal_changelog.len()
    );
}

#[tokio::main]
pub async fn oneoff_export_etalon_data(mode: Mode) -> Result<(), AppError> {
    info!("exporting etalon...");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let etalon = export_etalon_data(&dbx).await.context(h!())?;
    let content = serde_json::to_string(&etalon).context(h!())?;
    let file_path = PathBuf::from("/tmp")
        .join(format!("etalon_data_{}.json", Utc::now().naive_utc()));
    let path_log = file_path.display().to_string();
    let mut file = File::create(file_path).await.context(h!())?;
    file.write_all(content.as_bytes()).await.context(h!())?;
    info!("export completed, check out {path_log}");
    Ok(())
}

async fn export_etalon_data<'a, 'async_trait, C>(
    txn: &'a C,
) -> anyhow::Result<EtalonData>
where
    C: ConnectionTrait + 'async_trait,
{
    let sigint_signal_changelog = sigint_signal_changelog::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_signal = sigint_signal::Entity::find()
        .filter(sigint_signal::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;
    let result = EtalonData {
        sigint_signal,
        sigint_signal_changelog,
    };
    Ok(result)
}

async fn import_etalon_data<'a, 'async_trait, C>(
    txn: &'a C,
    data: EtalonData, // todo pass origin server id for etalon data?
    dry_run: bool,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut import_warnings = vec![];

    let mut sigint_signal_ids_map = BTreeMap::new();
    for rec in data.sigint_signal {
        let new_id = sigint_signal::ActiveModel {
            id: NotSet,
            text: Set(rec.text),
            meaning: Set(rec.meaning),
            unit: Set(rec.unit),
            coordinates: Set(rec.coordinates),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
        }
        .insert(txn)
        .await
        .context(h!())?
        .id;
        sigint_signal_ids_map.insert(rec.id, new_id);
    }

    let mut sigint_signal_changelog_inserts = vec![];
    for rec in data.sigint_signal_changelog {
        let Some(sigint_signal_id) =
            sigint_signal_ids_map.get(&rec.sigint_signal_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_signal with id {} not found",
                rec.sigint_signal_id
            ));
            continue;
        };
        let insert = sigint_signal_changelog::ActiveModel {
            id: NotSet,
            sigint_signal_id: Set(sigint_signal_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
        };
        sigint_signal_changelog_inserts.push(insert);
    }

    if !sigint_signal_changelog_inserts.is_empty() {
        sigint_signal_changelog::Entity::insert_many(
            sigint_signal_changelog_inserts,
        )
        .exec(txn)
        .await
        .context(h!())?;
    }

    let is_ok = import_warnings.is_empty();
    if !is_ok && dry_run {
        warn!("Following import warnings occurred:");
        for err in import_warnings {
            warn!("- {}", err);
        }
    };

    Ok(is_ok)
}

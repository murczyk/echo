pub mod types;

use crate::entities::{sigint_origin, sigint_signal, sigint_signal_changelog};
use crate::error::AppError;
use crate::h;
use crate::sigint::import::types::*;
use crate::types::Mode;
use anyhow::Context;
use chrono::Utc;
use dialoguer::{theme::ColorfulTheme, Confirm};
use log::{info, warn};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait,
    IntoActiveModel, NotSet, QueryFilter, Set, TransactionTrait,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
pub async fn oneoff_import_etalon_data(
    mode: Mode,
    path: String,
    origin_name: String,
    import_type: String,
    autocommit: bool,
) -> Result<(), AppError> {
    let import_type = ImportType::from_str(&import_type)?;
    let autocommit_txt = match autocommit {
        true => "autocommit on",
        false => "autocommit off",
    };
    info!("[{:#?}] importing etalon from server {origin_name}, file {path}, {autocommit_txt}", import_type);

    let mut file_read = File::open(path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon = String::from_utf8_lossy(&buffer).to_string();
    let etalon: EtalonData = serde_json::from_str(&etalon).context(h!())?;

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let origin = sigint_origin::Entity::find()
        .filter(sigint_origin::Column::Name.eq(origin_name.clone()))
        .one(&dbx)
        .await
        .context(h!())?;
    let Some(origin) = origin else {
        return Err(AppError::BL {
            msg: format!("origin not found: {origin_name}"),
        });
    };
    describe_etalon(&etalon);
    let committed = {
        let txn = dbx.begin().await.context(h!())?;
        let ok = import_etalon_data(
            &txn,
            etalon.clone(),
            origin.id,
            &import_type,
            true,
        )
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
            import_etalon_data(
                &dbx,
                etalon.clone(),
                origin.id,
                &import_type,
                false,
            )
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
    data: EtalonData,
    origin_id: i64,
    import_type: &ImportType,
    dry_run: bool,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut import_warnings = vec![];

    let sigint_signal_ids_map = import_sigint_signal_data(
        txn,
        origin_id,
        import_type,
        data.sigint_signal,
    )
    .await
    .context(h!())?;

    import_sigint_signal_changelog_data(
        txn,
        origin_id,
        import_type,
        data.sigint_signal_changelog,
        sigint_signal_ids_map,
        &mut import_warnings,
    )
    .await
    .context(h!())?;

    let is_ok = import_warnings.is_empty();
    if !is_ok && dry_run {
        warn!("Following import warnings occurred:");
        for err in import_warnings {
            warn!("- {}", err);
        }
    };

    Ok(is_ok)
}

async fn import_sigint_signal_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    import_type: &ImportType,
    recs: Vec<sigint_signal_changelog::Model>,
    sigint_signal_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(sigint_signal_id) =
            sigint_signal_ids_map.get(&rec.sigint_signal_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_signal with id {} not found",
                rec.sigint_signal_id
            ));
            continue;
        };
        let mut model = sigint_signal_changelog::ActiveModel {
            id: NotSet,
            sigint_signal_id: Set(sigint_signal_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
            mothership_id: NotSet,
        };
        let (mothership_id, propagate_mothership_id) = match import_type {
            ImportType::FromMothership => (Set(Some(rec.id)), false),
            ImportType::ToMothership => (NotSet, true),
        };
        model.mothership_id = mothership_id;
        let new_rec = model.insert(txn).await.context(h!())?;

        let new_id = new_rec.id;

        if propagate_mothership_id {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(result)
}

async fn import_sigint_signal_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    import_type: &ImportType,
    recs: Vec<sigint_signal::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result = BTreeMap::new();
    for rec in recs {
        let mut model = sigint_signal::ActiveModel {
            id: NotSet,
            text: Set(rec.text),
            meaning: Set(rec.meaning),
            unit: Set(rec.unit),
            coordinates: Set(rec.coordinates),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: NotSet,
        };
        let (mothership_id, propagate_mothership_id) = match import_type {
            ImportType::FromMothership => (Set(Some(rec.id)), false),
            ImportType::ToMothership => (NotSet, true),
        };
        model.mothership_id = mothership_id;
        let new_rec = model.insert(txn).await.context(h!())?;

        let new_id = new_rec.id;

        if propagate_mothership_id {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(result)
}

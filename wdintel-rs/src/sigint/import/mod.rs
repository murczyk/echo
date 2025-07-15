use crate::entities::*;
use crate::entities::{
    modulation, sigint_callsign, sigint_callsign_changelog, sigint_network,
    sigint_network_changelog, sigint_network_description, sigint_network_freq,
    sigint_network_freq_changelog, sigint_network_unit,
    sigint_network_unit_changelog, sigint_signal, sigint_signal_changelog,
    sigint_unit, source,
};
use crate::error::AppError;
use crate::h;
use crate::sigint::import::types::*;
use crate::types::Mode;
use anyhow::Context;
use dialoguer::{theme::ColorfulTheme, Confirm};
use echo_migration::Expr;
use log::{info, warn};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait,
    IntoActiveModel, NotSet, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use std::collections::BTreeMap;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod query;
pub mod types;

#[tokio::main]
pub async fn oneoff_export_etalon_data(
    mode: Mode,
    destination_path: String,
) -> Result<(), AppError> {
    info!("exporting etalon...");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let etalon = export_etalon_data(&dbx).await.context(h!())?;
    let content = serde_json::to_string(&etalon).context(h!())?;
    let mut file =
        File::create(destination_path.clone()).await.context(h!())?;
    file.write_all(content.as_bytes()).await.context(h!())?;
    info!("export completed, check out {destination_path}");
    Ok(())
}
#[tokio::main]
pub async fn oneoff_import_etalon_data(
    mode: Mode,
    path: String,
    origin_name: String,
    mothership_ids_destination_path: Option<String>,
    autocommit: bool,
) -> Result<(), AppError> {
    let from_mothership = origin_name.eq("mothership");
    if mothership_ids_destination_path.is_none() && !from_mothership {
        return Err(AppError::BL { msg: format!("mothership_ids_destination_path is required when importing from {origin_name}") });
    }
    let autocommit_txt = match autocommit {
        true => "autocommit on",
        false => "autocommit off",
    };
    info!("importing etalon from server {origin_name}, file {path}, {autocommit_txt}");

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
    let (committed, mut import_result) = {
        let txn = dbx.begin().await.context(h!())?;
        let (ok, import_result) = import_etalon_data(
            &txn,
            etalon.clone(),
            origin.id,
            true,
            from_mothership,
        )
        .await
        .context(h!())?;
        let should_commit = ok && autocommit;
        if should_commit {
            txn.commit().await.context(h!())?;
            info!("Import completed.")
        }
        (should_commit, import_result)
    };
    let committed = if !committed {
        if Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Confirm import?")
            .interact()
            .context(h!())?
        {
            let (_, fin_result) = import_etalon_data(
                &dbx,
                etalon.clone(),
                origin.id,
                false,
                from_mothership,
            )
            .await
            .context(h!())?;
            import_result = fin_result;
            info!("Import completed.");
            true
        } else {
            return Err(AppError::BL {
                msg: "Import aborted.".to_string(),
            });
        }
    } else {
        true
    };
    if committed && !from_mothership {
        let file_path = mothership_ids_destination_path.context(h!())?;
        let content = serde_json::to_string(&import_result).context(h!())?;
        let mut file = File::create(file_path.clone()).await.context(h!())?;
        file.write_all(content.as_bytes()).await.context(h!())?;
        info!("import result needs to be imported back to {origin_name}. it' at {file_path}");
    }

    Ok(())
}

#[tokio::main]
pub async fn oneoff_import_mothership_ids(
    mode: Mode,
    path: String,
) -> Result<(), AppError> {
    info!("importing mothership ids from  file {path}");
    let mut file_read = File::open(path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon = String::from_utf8_lossy(&buffer).to_string();
    let ids: EtalonImportResult =
        serde_json::from_str(&etalon).context(h!())?;

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;

    for (original_id, mothership_id) in ids.sigint_signal.ids_map {
        sigint_signal::Entity::update_many()
            .filter(sigint_signal::Column::Id.eq(original_id))
            .col_expr(
                sigint_signal::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_signal_changelog.ids_map {
        sigint_signal_changelog::Entity::update_many()
            .filter(sigint_signal_changelog::Column::Id.eq(original_id))
            .col_expr(
                sigint_signal_changelog::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_unit.ids_map {
        sigint_unit::Entity::update_many()
            .filter(sigint_unit::Column::Id.eq(original_id))
            .col_expr(
                sigint_unit::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_network_description.ids_map {
        sigint_network_description::Entity::update_many()
            .filter(sigint_network_description::Column::Id.eq(original_id))
            .col_expr(
                sigint_network_description::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_network_changelog.ids_map {
        sigint_network_changelog::Entity::update_many()
            .filter(sigint_network_changelog::Column::Id.eq(original_id))
            .col_expr(
                sigint_network_changelog::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_network.ids_map {
        sigint_network::Entity::update_many()
            .filter(sigint_network::Column::Id.eq(original_id))
            .col_expr(
                sigint_network::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_network_freq.ids_map {
        sigint_network_freq::Entity::update_many()
            .filter(sigint_network_freq::Column::Id.eq(original_id))
            .col_expr(
                sigint_network_freq::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_network_unit.ids_map {
        sigint_network_unit::Entity::update_many()
            .filter(sigint_network_unit::Column::Id.eq(original_id))
            .col_expr(
                sigint_network_unit::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in
        ids.sigint_network_unit_changelog.ids_map
    {
        sigint_network_unit_changelog::Entity::update_many()
            .filter(sigint_network_unit_changelog::Column::Id.eq(original_id))
            .col_expr(
                sigint_network_unit_changelog::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in
        ids.sigint_network_freq_changelog.ids_map
    {
        sigint_network_freq_changelog::Entity::update_many()
            .filter(sigint_network_freq_changelog::Column::Id.eq(original_id))
            .col_expr(
                sigint_network_freq_changelog::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_callsign.ids_map {
        sigint_callsign::Entity::update_many()
            .filter(sigint_callsign::Column::Id.eq(original_id))
            .col_expr(
                sigint_callsign::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.sigint_callsign_changelog.ids_map {
        sigint_callsign_changelog::Entity::update_many()
            .filter(sigint_callsign_changelog::Column::Id.eq(original_id))
            .col_expr(
                sigint_callsign_changelog::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.modulation.ids_map {
        modulation::Entity::update_many()
            .filter(modulation::Column::Id.eq(original_id))
            .col_expr(
                modulation::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    for (original_id, mothership_id) in ids.source.ids_map {
        source::Entity::update_many()
            .filter(source::Column::Id.eq(original_id))
            .col_expr(
                source::Column::MothershipId,
                Expr::value(Some(mothership_id)),
            )
            .exec(&txn)
            .await
            .context(h!())?;
    }

    txn.commit().await.context(h!())?;
    info!("completed.");
    Ok(())
}

fn describe_etalon(etalon: &EtalonImportResult) {
    fn print_import_stats<ID: Id>(import_stats: &ImportResult<ID>) -> String {
        format!(
            "total {}, new {}, updated {}",
            import_stats.ids_map.len(),
            import_stats.num_created,
            import_stats.num_updated
        )
    }

    info!("------------------");
    info!("Importing etalon data");
    info!(
        "- sigint_signal records: {}",
        print_import_stats(&etalon.sigint_signal)
    );
    info!(
        "- sigint_signal_changelog records: {}",
        print_import_stats(&etalon.sigint_signal_changelog)
    );
    info!(
        "- sigint_unit records: {}",
        print_import_stats(&etalon.sigint_unit)
    );
    info!(
        "- sigint_network records: {}",
        print_import_stats(&etalon.sigint_network)
    );
    info!(
        "- sigint_network_changelog records: {}",
        print_import_stats(&etalon.sigint_network_changelog)
    );
    info!(
        "- sigint_network_description records: {}",
        print_import_stats(&etalon.sigint_network_description)
    );
    info!(
        "- sigint_network_freq records: {}",
        print_import_stats(&etalon.sigint_network_freq)
    );
    info!(
        "- sigint_network_freq_changelog records: {}",
        print_import_stats(&etalon.sigint_network_freq_changelog)
    );
    info!(
        "- sigint_network_unit records: {}",
        print_import_stats(&etalon.sigint_network_unit)
    );
    info!(
        "- sigint_network_unit_changelog records: {}",
        print_import_stats(&etalon.sigint_network_unit_changelog)
    );
    info!(
        "- sigint_callsign records: {}",
        print_import_stats(&etalon.sigint_callsign)
    );
    info!(
        "- sigint_callsign_changelog records: {}",
        print_import_stats(&etalon.sigint_callsign_changelog)
    );
    info!("- source records: {}", print_import_stats(&etalon.source));
    info!(
        "- modulation records: {}",
        print_import_stats(&etalon.modulation)
    );
}

async fn export_etalon_data<'a, 'async_trait, C>(
    txn: &'a C,
) -> anyhow::Result<EtalonData>
where
    C: ConnectionTrait + 'async_trait,
{
    let sigint_unit =
        sigint_unit::Entity::find().all(txn).await.context(h!())?;
    let sigint_signal_changelog = sigint_signal_changelog::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_signal =
        sigint_signal::Entity::find().all(txn).await.context(h!())?;
    let sigint_network = sigint_network::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_network_changelog = sigint_network_changelog::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_network_description = sigint_network_description::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_network_freq = sigint_network_freq::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_network_freq_changelog =
        sigint_network_freq_changelog::Entity::find()
            .all(txn)
            .await
            .context(h!())?;
    let sigint_network_unit = sigint_network_unit::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_network_unit_changelog =
        sigint_network_unit_changelog::Entity::find()
            .all(txn)
            .await
            .context(h!())?;
    let sigint_callsign = sigint_callsign::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let source = source::Entity::find().all(txn).await.context(h!())?;
    let modulation = modulation::Entity::find().all(txn).await.context(h!())?;
    let sigint_callsign_changelog = sigint_callsign_changelog::Entity::find()
        .all(txn)
        .await
        .context(h!())?;

    let result = EtalonData {
        sigint_unit,
        sigint_signal,
        sigint_signal_changelog,
        sigint_network,
        sigint_network_changelog,
        sigint_network_description,
        sigint_network_freq,
        sigint_network_freq_changelog,
        sigint_network_unit,
        sigint_network_unit_changelog,
        sigint_callsign,
        sigint_callsign_changelog,
        source,
        modulation,
    };
    Ok(result)
}

async fn import_etalon_data<'a, 'async_trait, C>(
    txn: &'a C,
    data: EtalonData,
    origin_id: i64,
    dry_run: bool,
    from_mothership: bool,
) -> anyhow::Result<(bool, EtalonImportResult)>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut import_warnings = vec![];

    let modulation_import_result = import_modulation_data(
        txn,
        origin_id,
        data.modulation,
        from_mothership,
    )
    .await
    .context(h!())?;

    let source_import_result =
        import_source_data(txn, origin_id, data.source, from_mothership)
            .await
            .context(h!())?;

    let sigint_unit_import_result = import_sigint_unit_data(
        txn,
        origin_id,
        data.sigint_unit,
        from_mothership,
    )
    .await
    .context(h!())?;

    let sigint_network_import_result = import_sigint_network_data(
        txn,
        origin_id,
        data.sigint_network,
        from_mothership,
    )
    .await
    .context(h!())?;

    let sigint_network_changelog_import_result =
        import_sigint_network_changelog_data(
            txn,
            origin_id,
            data.sigint_network_changelog,
            sigint_network_import_result.ids_map.clone(),
            &mut import_warnings,
            from_mothership,
        )
        .await
        .context(h!())?;

    let sigint_network_freq_import_result = import_sigint_network_freq_data(
        txn,
        origin_id,
        data.sigint_network_freq,
        sigint_network_import_result.ids_map.clone(),
        modulation_import_result.ids_map.clone(),
        &mut import_warnings,
        from_mothership,
    )
    .await
    .context(h!())?;

    let sigint_network_freq_changelog_import_result =
        import_sigint_network_freq_changelog_data(
            txn,
            origin_id,
            data.sigint_network_freq_changelog,
            sigint_network_freq_import_result.ids_map.clone(),
            &mut import_warnings,
            from_mothership,
        )
        .await
        .context(h!())?;

    let sigint_network_description_import_result =
        import_sigint_network_description_data(
            txn,
            origin_id,
            data.sigint_network_description,
            sigint_network_import_result.ids_map.clone(),
            sigint_network_freq_import_result.ids_map.clone(),
            &mut import_warnings,
            from_mothership,
        )
        .await
        .context(h!())?;

    let sigint_signal_import_result = import_sigint_signal_data(
        txn,
        origin_id,
        data.sigint_signal,
        from_mothership,
    )
    .await
    .context(h!())?;

    let sigint_signal_changelog_import_result =
        import_sigint_signal_changelog_data(
            txn,
            origin_id,
            data.sigint_signal_changelog,
            sigint_signal_import_result.ids_map.clone(),
            &mut import_warnings,
            from_mothership,
        )
        .await
        .context(h!())?;

    let sigint_network_unit_import_result = import_sigint_network_unit_data(
        txn,
        origin_id,
        data.sigint_network_unit,
        sigint_network_import_result.ids_map.clone(),
        sigint_unit_import_result.ids_map.clone(),
        &mut import_warnings,
        from_mothership,
    )
    .await
    .context(h!())?;

    let sigint_network_unit_changelog_import_result =
        import_sigint_network_unit_changelog_data(
            txn,
            origin_id,
            data.sigint_network_unit_changelog,
            sigint_network_unit_import_result.ids_map.clone(),
            &mut import_warnings,
            from_mothership,
        )
        .await
        .context(h!())?;

    let sigint_callsign_import_result = import_sigint_callsign_data(
        txn,
        origin_id,
        data.sigint_callsign,
        sigint_unit_import_result.ids_map.clone(),
        source_import_result.ids_map.clone(),
        &mut import_warnings,
        from_mothership,
    )
    .await
    .context(h!())?;

    let sigint_callsign_changelog_import_result =
        import_sigint_callsign_changelog_data(
            txn,
            origin_id,
            data.sigint_callsign_changelog,
            sigint_callsign_import_result.ids_map.clone(),
            &mut import_warnings,
            from_mothership,
        )
        .await
        .context(h!())?;

    let etalon_import_result = EtalonImportResult {
        sigint_signal: sigint_signal_import_result,
        sigint_signal_changelog: sigint_signal_changelog_import_result,
        sigint_unit: sigint_unit_import_result,
        sigint_network: sigint_network_import_result,
        sigint_network_changelog: sigint_network_changelog_import_result,
        sigint_network_description: sigint_network_description_import_result,
        sigint_network_freq: sigint_network_freq_import_result,
        sigint_network_freq_changelog:
            sigint_network_freq_changelog_import_result,
        sigint_network_unit: sigint_network_unit_import_result,
        sigint_network_unit_changelog:
            sigint_network_unit_changelog_import_result,
        sigint_callsign: sigint_callsign_import_result,
        sigint_callsign_changelog: sigint_callsign_changelog_import_result,
        modulation: modulation_import_result,
        source: source_import_result,
    };

    if dry_run {
        describe_etalon(&etalon_import_result);
    }

    let is_ok = import_warnings.is_empty();
    if !is_ok && dry_run {
        warn!("Following import warnings occurred:");
        for err in import_warnings {
            warn!("- {}", err);
        }
    };

    Ok((is_ok, etalon_import_result))
}

///
/// IMPORT METHODS GO HERE
///

async fn import_modulation_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<modulation::Model>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i32>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut max_id = modulation::Entity::find()
        .select_only()
        .column(modulation::Column::Id)
        .order_by_desc(modulation::Column::Id)
        .into_tuple()
        .one(txn)
        .await
        .context(h!())?
        .unwrap_or(0);
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_modulations(txn, &recs)
        .await
        .context(h!())?;

    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&id))
            .flatten();
        let (id, new_record) = match id {
            None => {
                max_id += 1;
                (Set(max_id), true)
            }
            Some(id) => (Set(*id), false),
        };

        let model = modulation::ActiveModel {
            id,
            mothership_id: Set(rec.mothership_id),
            created_at: Set(rec.created_at),
            name: Set(rec.name),
            lft: Set(rec.lft),
            rgt: Set(rec.rgt),
            enabled: Set(rec.enabled),
            sigint_origin_id: Set(Some(origin_id)),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_signal_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_signal::Model>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_sigint_signals(txn, &recs)
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id as i64)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_signal::ActiveModel {
            id,

            text: Set(rec.text),
            meaning: Set(rec.meaning),
            unit: Set(rec.unit),
            coordinates: Set(rec.coordinates),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_source_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<source::Model>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_sources(txn, &recs)
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id as i64)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = source::ActiveModel {
            id,
            created_at: Set(rec.created_at),
            name: Set(rec.name),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
            deleted: Set(rec.deleted),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_unit_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_unit::Model>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_sigint_units(txn, &recs)
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id as i64)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_unit::ActiveModel {
            id,
            company: Set(rec.company),
            regiment: Set(rec.regiment),
            division: Set(rec.division),
            army: Set(rec.army),
            active: Set(rec.active),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            created_by: Set("system".to_string()),
            name: Set(rec.name),
            comment: Set(rec.comment),
            battalion: Set(rec.battalion),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network::Model>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_sigint_networks(txn, &recs)
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    let mut new_records = vec![];
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id as i64)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network::ActiveModel {
            id,
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            updated_by: Set(Some("system".to_string())),
            updated_at: Set(rec.updated_at),
            radio_station: Set(rec.radio_station),
            purpose: Set(rec.purpose),
            operation_mode: Set(rec.operation_mode),
            operation_type: Set(rec.operation_type),
            operation_period: Set(rec.operation_period),
            merged_to: Set(rec.merged_to),
            active_from: Set(rec.active_from),
            name: Set(rec.name),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
            location: Set(rec.location),
            active_to: Set(rec.active_to),
        };
        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;
        let new_rec = if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?
        } else {
            new_rec
        };
        result.insert(rec.id, new_id);
        new_records.push(new_rec.clone());
    }

    for new_rec in new_records {
        // patch merged_to attribute
        let Some(merged_into) = new_rec.merged_to.clone() else {
            continue;
        };
        let mut model = new_rec.into_active_model();
        model.merged_to = Set(result.get(&merged_into).cloned());
        model.update(txn).await.context(h!())?;
    }

    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_description_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_description::Model>,
    sigint_network_ids_map: BTreeMap<i64, i64>,
    sigint_network_freq_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_descriptions(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(sigint_network_id) =
            sigint_network_ids_map.get(&rec.network_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.network_id
            ));
            continue;
        };
        let sigint_network_freq_id = match &rec.sigint_network_freq_id {
            None => NotSet,
            Some(sigint_network_freq_id) => {
                let Some(sigint_network_freq_id) = sigint_network_freq_ids_map
                    .get(sigint_network_freq_id)
                    .cloned()
                else {
                    import_warnings.push(format!(
                        "sigint_network_freq with id {} not found",
                        rec.network_id
                    ));
                    continue;
                };
                Set(Some(sigint_network_freq_id))
            }
        };
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id as i64)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_description::ActiveModel {
            id,
            network_id: Set(sigint_network_id),
            login: Set("system".to_string()),
            r#type: Set(rec.r#type),
            description: Set(rec.description),
            comment: Set(rec.comment),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            sigint_network_freq_id,
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_freq_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_freq::Model>,
    sigint_network_ids_map: BTreeMap<i64, i64>,
    modulation_ids_map: BTreeMap<i32, i32>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_freqs(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(sigint_network_id) =
            sigint_network_ids_map.get(&rec.network_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.network_id
            ));
            continue;
        };
        let modulation_id = match rec.modulation_id {
            None => NotSet,
            Some(modulation_id) => {
                let Some(modulation_id) =
                    modulation_ids_map.get(&modulation_id).cloned()
                else {
                    import_warnings.push(format!(
                        "modulation with id {} not found",
                        modulation_id
                    ));
                    continue;
                };
                Set(Some(modulation_id))
            }
        };
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id as i64)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_freq::ActiveModel {
            id,
            modulation_id,
            network_id: Set(sigint_network_id),
            freq: Set(rec.freq),
            created_at: Set(rec.created_at),
            kind: Set(rec.kind),
            active_from: Set(rec.active_from),
            active_to: Set(rec.active_to),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_callsign_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_callsign::Model>,
    sigint_unit_ids_map: BTreeMap<i64, i64>,
    source_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_sigint_callsigns(txn, &recs)
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(source_id) =
            source_ids_map.get(&(rec.source_id as i64)).cloned()
        else {
            import_warnings
                .push(format!("source with id {} not found", rec.unit_id));
            continue;
        };
        let Some(unit_id) = sigint_unit_ids_map.get(&rec.unit_id).cloned()
        else {
            import_warnings
                .push(format!("sigint_unit with id {} not found", rec.unit_id));
            continue;
        };
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_callsign::ActiveModel {
            id,
            callsign: Set(rec.callsign),
            position: Set(rec.position),
            comment: Set(rec.comment),
            unit_id: Set(unit_id),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            source_id: Set(source_id as i32),
            developing: Set(rec.developing),
            radio_freq: Set(rec.radio_freq),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_unit_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_unit::Model>,
    sigint_network_ids_map: BTreeMap<i64, i64>,
    sigint_unit_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_units(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(unit_id) = sigint_unit_ids_map.get(&rec.unit_id).cloned()
        else {
            import_warnings
                .push(format!("sigint_unit with id {} not found", rec.unit_id));
            continue;
        };
        let Some(sigint_network_id) =
            sigint_network_ids_map.get(&rec.network_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.network_id
            ));
            continue;
        };
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&(id)))
            .flatten();
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_unit::ActiveModel {
            id,
            network_id: Set(sigint_network_id),
            unit_id: Set(unit_id),
            created_at: Set(rec.created_at),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = if new_record {
            num_created += 1;
            model.insert(txn)
        } else {
            num_updated += 1;
            model.update(txn)
        }
        .await
        .context(h!())?;
        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_unit_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_unit_changelog::Model>,
    sigint_network_unit_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_unit_changelogs(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&id))
            .flatten();
        if id.is_some() {
            continue;
        }
        let Some(sigint_network_unit_id) = sigint_network_unit_ids_map
            .get(&rec.sigint_network_unit_id)
            .cloned()
        else {
            import_warnings.push(format!(
                "sigint_network_unit with id {} not found",
                rec.sigint_network_unit_id
            ));
            continue;
        };

        let model = sigint_network_unit_changelog::ActiveModel {
            id: NotSet,
            sigint_network_unit_id: Set(sigint_network_unit_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = model.insert(txn).await.context(h!())?;
        num_created += 1;

        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated: 0,
    })
}

async fn import_sigint_callsign_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_callsign_changelog::Model>,
    sigint_callsign_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let existing_record_ids =
        query::find_existing_sigint_callsign_changelogs(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&id))
            .flatten();
        if id.is_some() {
            continue;
        }
        let Some(sigint_callsign_id) = sigint_callsign_ids_map
            .get(&rec.sigint_callsign_id)
            .cloned()
        else {
            import_warnings.push(format!(
                "sigint_callsign with id {} not found",
                rec.sigint_callsign_id
            ));
            continue;
        };

        let model = sigint_callsign_changelog::ActiveModel {
            id: NotSet,
            sigint_callsign_id: Set(sigint_callsign_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = model.insert(txn).await.context(h!())?;
        num_created += 1;

        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated: 0,
    })
}

async fn import_sigint_signal_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_signal_changelog::Model>,
    sigint_signal_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let existing_record_ids =
        query::find_existing_sigint_signal_changelogs(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&id))
            .flatten();
        if id.is_some() {
            continue;
        }
        let Some(sigint_signal_id) =
            sigint_signal_ids_map.get(&rec.sigint_signal_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_signal with id {} not found",
                rec.sigint_signal_id
            ));
            continue;
        };

        let model = sigint_signal_changelog::ActiveModel {
            id: NotSet,
            sigint_signal_id: Set(sigint_signal_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = model.insert(txn).await.context(h!())?;
        num_created += 1;

        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated: 0,
    })
}

async fn import_sigint_network_freq_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_freq_changelog::Model>,
    sigint_network_freq_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_freq_changelogs(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&id))
            .flatten();
        if id.is_some() {
            continue;
        }
        let Some(sigint_network_freq_id) = sigint_network_freq_ids_map
            .get(&rec.sigint_network_freq_id)
            .cloned()
        else {
            import_warnings.push(format!(
                "sigint_network_freq with id {} not found",
                rec.sigint_network_freq_id
            ));
            continue;
        };

        let model = sigint_network_freq_changelog::ActiveModel {
            id: NotSet,
            sigint_network_freq_id: Set(sigint_network_freq_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = model.insert(txn).await.context(h!())?;
        num_created += 1;

        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated: 0,
    })
}

async fn import_sigint_network_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_changelog::Model>,
    sigint_network_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
    from_mothership: bool,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_changelogs(txn, &recs)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = rec
            .mothership_id
            .clone()
            .map(|id| existing_record_ids.get(&id))
            .flatten();
        if id.is_some() {
            continue;
        }
        let Some(sigint_network_id) =
            sigint_network_ids_map.get(&rec.sigint_network_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.sigint_network_id
            ));
            continue;
        };

        let model = sigint_network_changelog::ActiveModel {
            id: NotSet,
            sigint_network_id: Set(sigint_network_id),
            login: Set("system".to_string()),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
            mothership_id: Set(rec.mothership_id),
        };

        let new_rec = model.insert(txn).await.context(h!())?;
        num_created += 1;

        let new_id = new_rec.id;

        if !from_mothership {
            let new_id = new_rec.id;
            let mut model = new_rec.into_active_model();
            model.mothership_id = Set(Some(new_id));
            model.update(txn).await.context(h!())?;
        }

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated: 0,
    })
}

use crate::entities::sea_orm_active_enums::SigintNetworkKind;
use crate::entities::*;
use crate::entities::{
    area_of_responsibility, sigint_network_aor, sigint_zone_aor,
};
use crate::error::AppError;
use crate::h;
use crate::sigint::aor::load_default_aor;
use crate::sigint::import::types::*;
use crate::types::Mode;
use crate::types::*;
use anyhow::Context;
use dialoguer::{theme::ColorfulTheme, Confirm};
use itertools::Itertools;
use sea_orm::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod query;
pub mod tui;
pub mod types;

pub async fn oneoff_export_etalon_data(
    mode: Mode,
    destination_path: String,
    only_sigint_unit_id: Option<i64>,
) -> Result<(), AppError> {
    info!("exporting etalon...");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let etalon = export_etalon_data(&dbx, true, only_sigint_unit_id)
        .await
        .context(h!())?;
    let content = serde_json::to_string(&etalon).context(h!())?;
    let mut file =
        File::create(destination_path.clone()).await.context(h!())?;
    file.write_all(content.as_bytes()).await.context(h!())?;
    info!("export completed, check out {destination_path}");
    Ok(())
}

pub async fn oneoff_import_etalon_data(
    mode: Mode,
    path: String,
    origin_name: String,
    autocommit: bool,
) -> Result<(), AppError> {
    let autocommit_txt = match autocommit {
        true => "autocommit on",
        false => "autocommit off",
    };
    info!(
        "importing etalon from server {origin_name}, file {path}, {autocommit_txt}"
    );

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
    let ok = import_etalon_data(&dbx, etalon.clone(), origin.id, true)
        .await
        .context(h!())?;
    let should_commit = ok && autocommit;
    if !should_commit {
        let import_confirmed = Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Confirm import?")
            .interact()
            .context(h!())?;
        if !import_confirmed {
            return Err(AppError::BL {
                msg: "Import aborted.".to_string(),
            });
        }
    };
    import_etalon_data(&dbx, etalon.clone(), origin.id, false)
        .await
        .context(h!())?;
    info!("Import completed.");
    Ok(())
}

fn describe_etalon(etalon: &EtalonImportResult) {
    info!("------------------");
    info!("Importing etalon data");
    info!(
        "- sigint_network_post records: {}",
        print_import_stats(&etalon.sigint_network_post)
    );
    info!(
        "- area_of_responsibility records: {}",
        print_import_stats(&etalon.area_of_responsibility)
    );
    info!(
        "- sigint_zone_aor records: {}",
        print_import_stats(&etalon.sigint_zone_aor)
    );
    info!(
        "- sigint_network_callsign records: {}",
        print_import_stats(&etalon.sigint_network_callsign)
    );
    info!(
        "- sigint_network_callsign_changelog records: {}",
        print_import_stats(&etalon.sigint_network_callsign_changelog)
    );
    info!(
        "- sigint_network_aor records: {}",
        print_import_stats(&etalon.sigint_network_aor)
    );
    info!(
        "- sigint_post records: {}",
        print_import_stats(&etalon.sigint_post)
    );
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
        "- encryption records: {}",
        print_import_stats(&etalon.encryption)
    );
}

fn print_import_stats<ID: Id>(import_stats: &ImportResult<ID>) -> String {
    format!(
        "new {}, updated {}",
        import_stats.num_created, import_stats.num_updated
    )
}

async fn export_etalon_data<'a, 'async_trait, C>(
    txn: &'a C,
    include_deleted: bool,
    only_sigint_unit_id: Option<i64>,
) -> anyhow::Result<EtalonData>
where
    C: ConnectionTrait + 'async_trait,
{
    let sigint_unit = match &only_sigint_unit_id {
        None => sigint_unit::Entity::find(),
        Some(id) => sigint_unit::Entity::find_by_id(*id),
    }
    .all(txn)
    .await
    .context(h!())?;

    let sigint_signal = match &only_sigint_unit_id {
        None => sigint_signal::Entity::find(),
        Some(id) => sigint_signal::Entity::find()
            .filter(sigint_signal::Column::Unit.eq(*id)),
    }
    .all(txn)
    .await
    .context(h!())?;

    let signal_ids = sigint_signal.iter().map(|x| x.id).collect::<Vec<_>>();
    let sigint_signal_changelog = match &only_sigint_unit_id {
        None => sigint_signal_changelog::Entity::find(),
        Some(_) => sigint_signal_changelog::Entity::find().filter(
            sigint_signal_changelog::Column::SigintSignalId.is_in(signal_ids),
        ),
    }
    .all(txn)
    .await
    .context(h!())?;

    let mut sigint_network_q = match &only_sigint_unit_id {
        None => sigint_network::Entity::find(),
        Some(id) => sigint_network::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_network::Relation::SigintNetworkUnit.def(),
            )
            .filter(sigint_network_unit::Column::UnitId.eq(*id)),
    };
    if !include_deleted {
        sigint_network_q =
            sigint_network_q.filter(sigint_network::Column::Deleted.eq(false));
    }
    let sigint_network = sigint_network_q.all(txn).await.context(h!())?;
    let sigint_network_ids = sigint_network
        .iter()
        .map(|network| network.id)
        .collect::<Vec<_>>();
    let deleted_sigint_network_ids = sigint_network
        .iter()
        .filter(|network| network.deleted)
        .map(|network| network.id)
        .collect::<HashSet<_>>();
    let sigint_network_changelog = sigint_network_changelog::Entity::find()
        .filter(
            sigint_network_changelog::Column::SigintNetworkId
                .is_in(sigint_network_ids.clone()),
        )
        .all(txn)
        .await
        .context(h!())?;
    let mut sigint_network_description = if sigint_network_ids.is_empty() {
        Vec::new()
    } else {
        sigint_network_description::Entity::find()
            .filter(
                sigint_network_description::Column::NetworkId
                    .eq_any(sigint_network_ids.clone()),
            )
            .all(txn)
            .await
            .context(h!())?
    };
    let mut sigint_network_freq = if sigint_network_ids.is_empty() {
        Vec::new()
    } else {
        sigint_network_freq::Entity::find()
            .filter(
                sigint_network_freq::Column::NetworkId
                    .eq_any(sigint_network_ids.clone()),
            )
            .all(txn)
            .await
            .context(h!())?
    };
    let sigint_network_freq_changelog =
        sigint_network_freq_changelog::Entity::find()
            .all(txn)
            .await
            .context(h!())?;
    let sigint_network_unit = if sigint_network_ids.is_empty() {
        Vec::new()
    } else {
        sigint_network_unit::Entity::find()
            .filter(
                sigint_network_unit::Column::NetworkId
                    .eq_any(sigint_network_ids.clone()),
            )
            .all(txn)
            .await
            .context(h!())?
    };
    let sigint_network_unit_ids =
        sigint_network_unit.iter().map(|x| x.id).collect_vec();
    let sigint_network_unit_changelog =
        sigint_network_unit_changelog::Entity::find()
            .filter(
                sigint_network_unit_changelog::Column::Id
                    .is_in(sigint_network_unit_ids),
            )
            .all(txn)
            .await
            .context(h!())?;
    let sigint_callsign = match &only_sigint_unit_id {
        None => sigint_callsign::Entity::find(),
        Some(id) => sigint_callsign::Entity::find()
            .filter(sigint_callsign::Column::UnitId.eq(*id)),
    }
    .all(txn)
    .await
    .context(h!())?;
    let sigint_callsign_ids =
        sigint_callsign.iter().map(|x| x.id).collect_vec();
    let sigint_callsign_changelog = sigint_callsign_changelog::Entity::find()
        .filter(
            sigint_callsign_changelog::Column::SigintCallsignId
                .is_in(sigint_callsign_ids),
        )
        .all(txn)
        .await
        .context(h!())?;
    let source = match &only_sigint_unit_id {
        None => source::Entity::find().all(txn).await.context(h!())?,
        Some(_) => vec![],
    };
    // Always include all encryption rows: the table has only 6 seeded entries and
    // every migrated freq row references one of them, including unit-scoped exports.
    let encryption = encryption::Entity::find().all(txn).await.context(h!())?;
    let sigint_post =
        sigint_post::Entity::find().all(txn).await.context(h!())?;
    let mut sigint_network_post = if sigint_network_ids.is_empty() {
        Vec::new()
    } else {
        sigint_network_post::Entity::find()
            .filter(
                sigint_network_post::Column::NetworkId
                    .eq_any(sigint_network_ids.clone()),
            )
            .all(txn)
            .await
            .context(h!())?
    };
    let mut sigint_network_callsign = if sigint_network_ids.is_empty() {
        Vec::new()
    } else {
        sigint_network_callsign::Entity::find()
            .filter(
                sigint_network_callsign::Column::SigintNetworkId
                    .eq_any(sigint_network_ids.clone()),
            )
            .all(txn)
            .await
            .context(h!())?
    };
    let sigint_network_callsign_ids =
        sigint_network_callsign.iter().map(|x| x.id).collect_vec();
    let sigint_network_callsign_changelog =
        sigint_network_callsign_changelog::Entity::find()
            .filter(
                sigint_network_callsign_changelog::Column::Id
                    .is_in(sigint_network_callsign_ids),
            )
            .all(txn)
            .await
            .context(h!())?;
    let area_of_responsibility = area_of_responsibility::Entity::find()
        .all(txn)
        .await
        .context(h!())?;
    let sigint_network_aor = if sigint_network_ids.is_empty() {
        Vec::new()
    } else {
        sigint_network_aor::Entity::find()
            .filter(
                sigint_network_aor::Column::NetworkId
                    .eq_any(sigint_network_ids),
            )
            .all(txn)
            .await
            .context(h!())?
    };
    let sigint_zone_aor = sigint_zone_aor::Entity::find()
        .all(txn)
        .await
        .context(h!())?;

    if include_deleted && !deleted_sigint_network_ids.is_empty() {
        mark_network_related_data_as_deleted(
            &deleted_sigint_network_ids,
            &mut sigint_network_freq,
            &mut sigint_network_description,
            &mut sigint_network_post,
            &mut sigint_network_callsign,
        );
    }

    let result = EtalonData {
        area_of_responsibility,
        sigint_network_aor,
        sigint_zone_aor,
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
        encryption,
        sigint_post,
        sigint_network_post,
        sigint_network_callsign,
        sigint_network_callsign_changelog,
    };
    Ok(result)
}

fn mark_network_related_data_as_deleted(
    deleted_network_ids: &HashSet<i64>,
    sigint_network_freq: &mut [sigint_network_freq::Model],
    sigint_network_description: &mut [sigint_network_description::Model],
    sigint_network_post: &mut [sigint_network_post::Model],
    sigint_network_callsign: &mut [sigint_network_callsign::Model],
) {
    for network_freq in sigint_network_freq {
        if deleted_network_ids.contains(&network_freq.network_id) {
            network_freq.deleted = true;
        }
    }
    for network_description in sigint_network_description {
        if deleted_network_ids.contains(&network_description.network_id) {
            network_description.deleted = true;
        }
    }
    for network_post in sigint_network_post {
        if deleted_network_ids.contains(&network_post.network_id) {
            network_post.deleted = true;
        }
    }
    for network_callsign in sigint_network_callsign {
        if deleted_network_ids.contains(&network_callsign.sigint_network_id) {
            network_callsign.deleted = true;
        }
    }
}

async fn import_etalon_data(
    dbx: &DatabaseConnection,
    data: EtalonData,
    origin_id: i64,
    dry_run: bool,
) -> anyhow::Result<bool> {
    let mut import_warnings = vec![];
    let mut txn = dbx.begin().await.context(h!())?;
    let default_zone_id = sigint_zone::Entity::find()
        .filter(sigint_zone::Column::Deleted.eq(false))
        .order_by_asc(sigint_zone::Column::CreatedAt)
        .one(&txn)
        .await
        .context(h!())?
        .context(h!())?
        .id;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let area_of_responsibility_import_result =
        import_area_of_responsibility_data(
            &txn,
            origin_id,
            data.area_of_responsibility.clone(),
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let aors_map = with_default_aors_mapping(
        &area_of_responsibility_import_result.ids_map,
        data.area_of_responsibility,
        &txn,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let modulation_import_result =
        import_encryption_data(&txn, origin_id, data.encryption)
            .await
            .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let source_import_result = import_source_data(&txn, origin_id, data.source)
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_unit_import_result =
        import_sigint_unit_data(&txn, origin_id, data.sigint_unit)
            .await
            .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_import_result =
        import_sigint_network_data(&txn, origin_id, data.sigint_network)
            .await
            .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_aor_import_result = import_sigint_network_aor_data(
        &txn,
        origin_id,
        data.sigint_network_aor,
        &aors_map,
        &sigint_network_import_result.ids_map,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_zone_aor_import_result = import_sigint_zone_aor_data(
        &txn,
        origin_id,
        default_zone_id,
        data.sigint_zone_aor,
        &aors_map,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_changelog_import_result =
        import_sigint_network_changelog_data(
            &txn,
            origin_id,
            data.sigint_network_changelog,
            sigint_network_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_freq_import_result = import_sigint_network_freq_data(
        &txn,
        origin_id,
        data.sigint_network_freq,
        sigint_network_import_result.ids_map.clone(),
        modulation_import_result.ids_map.clone(),
        &mut import_warnings,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_freq_changelog_import_result =
        import_sigint_network_freq_changelog_data(
            &txn,
            origin_id,
            data.sigint_network_freq_changelog,
            sigint_network_freq_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_description_import_result =
        import_sigint_network_description_data(
            &txn,
            origin_id,
            data.sigint_network_description,
            sigint_network_import_result.ids_map.clone(),
            sigint_network_freq_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_signal_import_result = import_sigint_signal_data(
        &txn,
        origin_id,
        data.sigint_signal,
        sigint_unit_import_result.ids_map.clone(),
        &mut import_warnings,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_signal_changelog_import_result =
        import_sigint_signal_changelog_data(
            &txn,
            origin_id,
            data.sigint_signal_changelog,
            sigint_signal_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_unit_import_result = import_sigint_network_unit_data(
        &txn,
        origin_id,
        data.sigint_network_unit,
        sigint_network_import_result.ids_map.clone(),
        sigint_unit_import_result.ids_map.clone(),
        &mut import_warnings,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_unit_changelog_import_result =
        import_sigint_network_unit_changelog_data(
            &txn,
            origin_id,
            data.sigint_network_unit_changelog,
            sigint_network_unit_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_callsign_import_result = import_sigint_callsign_data(
        &txn,
        origin_id,
        data.sigint_callsign,
        sigint_unit_import_result.ids_map.clone(),
        source_import_result.ids_map.clone(),
        &mut import_warnings,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_callsign_changelog_import_result =
        import_sigint_callsign_changelog_data(
            &txn,
            origin_id,
            data.sigint_callsign_changelog,
            sigint_callsign_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_post_import_result =
        import_sigint_post_data(&txn, origin_id, data.sigint_post)
            .await
            .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_post_import_result = import_sigint_network_post_data(
        &txn,
        origin_id,
        data.sigint_network_post,
        sigint_network_import_result.ids_map.clone(),
        sigint_post_import_result.ids_map.clone(),
        &mut import_warnings,
    )
    .await
    .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_callsign_import_result =
        import_sigint_network_callsign_data(
            &txn,
            origin_id,
            data.sigint_network_callsign,
            sigint_network_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    txn = maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let sigint_network_callsign_changelog_import_result =
        import_sigint_network_callsign_changelog_data(
            &txn,
            origin_id,
            data.sigint_network_callsign_changelog,
            sigint_network_callsign_import_result.ids_map.clone(),
            &mut import_warnings,
        )
        .await
        .context(h!())?;
    maybe_commit(txn, dbx, dry_run).await.context(h!())?;

    let etalon_import_result = EtalonImportResult {
        area_of_responsibility: area_of_responsibility_import_result,
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
        encryption: modulation_import_result,
        source: source_import_result,
        sigint_post: sigint_post_import_result,
        sigint_network_post: sigint_network_post_import_result,
        sigint_network_callsign: sigint_network_callsign_import_result,
        sigint_network_callsign_changelog:
            sigint_network_callsign_changelog_import_result,
        sigint_network_aor: sigint_network_aor_import_result,
        sigint_zone_aor: sigint_zone_aor_import_result,
    };

    describe_etalon(&etalon_import_result);

    let is_ok = import_warnings.is_empty();
    if !is_ok && dry_run {
        warn!("Following import warnings occurred:");
        for err in import_warnings {
            warn!("- {err}");
        }
    };

    Ok(is_ok)
}

async fn with_default_aors_mapping<'a, 'async_trait, C>(
    mapping: &BTreeMap<i64, i64>,
    areas: Vec<area_of_responsibility::Model>,
    txn: &'a C,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result = mapping.clone();
    let default_aor =
        areas.into_iter().find(|a| a.is_default && a.is_top_level);
    if let Some(default_aor) = default_aor {
        let target_default_aor = load_default_aor(txn).await.context(h!())?;
        result.insert(default_aor.id, target_default_aor.id);
    };
    Ok(result)
}

///
/// IMPORT METHODS GO HERE
///
async fn import_area_of_responsibility_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<area_of_responsibility::Model>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut max_id = area_of_responsibility::Entity::find()
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .order_by_desc(area_of_responsibility::Column::Id)
        .into_tuple()
        .one(txn)
        .await
        .context(h!())?
        .unwrap_or(0);
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_areas_of_responsibility(txn, &recs, origin_id)
            .await
            .context(h!())?;

    let mut result = BTreeMap::new();
    for rec in recs {
        if rec.is_top_level && rec.is_default {
            let default_aor = load_default_aor(txn).await.context(h!())?;
            result.insert(rec.id, default_aor.id);
            continue;
        }
        let id = existing_record_ids.get(&rec.id);
        let (id, new_record) = match id {
            None => {
                max_id += 1;
                (Set(max_id), true)
            }
            Some(id) => (Set(*id), false),
        };

        let model = area_of_responsibility::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            created_at: Set(rec.created_at),
            deleted: Set(rec.deleted),
            is_top_level: Set(rec.is_top_level),
            name: Set(rec.name),
            description: Set(rec.description),
            left_bound: Set(rec.left_bound),
            right_bound: Set(rec.right_bound),
            left_lat: Set(rec.left_lat),
            left_lon: Set(rec.left_lon),
            right_lat: Set(rec.right_lat),
            right_lon: Set(rec.right_lon),
            left_settlement: Set(rec.left_settlement),
            right_settlement: Set(rec.right_settlement),
            updated_by_login_id: Set(Some(
                crate::users::system_login_id(txn).await?,
            )),
            updated_at: Set(rec.updated_at),
            order_for_report_legacy: Set(rec.order_for_report_legacy),
            is_default: Set(rec.is_default),
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
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_encryption_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<encryption::Model>,
) -> anyhow::Result<ImportResult<i32>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut max_id = encryption::Entity::find()
        .select_only()
        .column(encryption::Column::Id)
        .order_by_desc(encryption::Column::Id)
        .into_tuple()
        .one(txn)
        .await
        .context(h!())?
        .unwrap_or(0);
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids = query::find_existing_encryptions(txn, &recs)
        .await
        .context(h!())?;

    let mut result = BTreeMap::new();
    for rec in recs {
        let id = existing_record_ids.get(&rec.name);
        let (id, new_record) = match id {
            None => {
                max_id += 1;
                (Set(max_id), true)
            }
            Some(id) => (Set(*id), false),
        };

        let model = encryption::ActiveModel {
            id,
            created_at: Set(rec.created_at),
            name: Set(rec.name),
            enabled: Set(rec.enabled),
            sigint_origin_id: Set(Some(origin_id)),
            mothership_id: NotSet,
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
    sigint_unit_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_signals(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };
        let unit_id = match rec.unit {
            None => None,
            Some(unit_id) => {
                let Some(unit_id) = sigint_unit_ids_map.get(&unit_id).cloned()
                else {
                    import_warnings.push(format!(
                        "sigint_unit with id {unit_id} not found"
                    ));
                    continue;
                };
                Some(unit_id)
            }
        };

        let model = sigint_signal::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            text: Set(rec.text),
            meaning: Set(rec.meaning),
            unit: Set(unit_id),
            coordinates: Set(rec.coordinates),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sources(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let id = existing_record_ids.get(&rec.name);
        let (id, new_record) = match id {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = source::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            created_at: Set(rec.created_at),
            name: Set(rec.name),
            sigint_origin_id: Set(Some(origin_id)),
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_units(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_unit::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            other: Set(rec.other),
            team_or_crew: Set(rec.team_or_crew),
            section: Set(rec.section),
            squad: Set(rec.squad),
            platoon: Set(rec.platoon),
            company: Set(rec.company),
            regiment: Set(rec.regiment),
            brigade: Set(rec.brigade),
            division: Set(rec.division),
            corps: Set(rec.corps),
            army: Set(rec.army),
            army_region: Set(rec.army_region),
            military_district: Set(rec.military_district),
            active: Set(rec.active),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            created_by_login_id: Set(crate::users::system_login_id(txn)
                .await
                .c(h!())?),
            name: Set(rec.name),
            comment: Set(rec.comment),
            battalion: Set(rec.battalion),
            sigint_origin_id: Set(Some(origin_id)),
            is_deduplicate_candidate: NotSet,
            orbit_note: NotSet,
            is_inconsistent: NotSet,
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_networks(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    let mut new_records = vec![];
    for rec in recs {
        let original_id = rec.id;
        let (id, new_record) = match existing_record_ids.get(&original_id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network::ActiveModel {
            original_id: Set(Some(original_id)),
            id,
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            updated_by_login_id: Set(Some(
                crate::users::system_login_id(txn).await?,
            )),
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
            location: Set(rec.location),
            active_to: Set(rec.active_to),
            do_not_archive: Set(rec.do_not_archive),
            unit_mask: Set(rec.unit_mask),
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
        result.insert(original_id, new_id);
        new_records.push(new_rec.clone());
    }

    for new_rec in new_records {
        // patch merged_to attribute
        let Some(merged_into) = new_rec.merged_to else {
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

async fn import_sigint_network_aor_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_aor::Model>,
    aors_map: &BTreeMap<i64, i64>,
    sigint_network_import_result: &BTreeMap<i64, i64>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_aors(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    let mut new_records = vec![];
    for rec in recs {
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let network_id = sigint_network_import_result
            .get(&rec.network_id)
            .cloned()
            .context(h!())?;
        let model = sigint_network_aor::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            network_id: Set(network_id),
            aor_id: Set(aors_map.get(&rec.aor_id).cloned().context(h!())?),
            created_at: Set(rec.created_at),
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
        result.insert(rec.id, new_id);
        new_records.push(new_rec.clone());
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_zone_aor_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    zone_id: i64,
    recs: Vec<sigint_zone_aor::Model>,
    aors_map: &BTreeMap<i64, i64>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_zone_aors(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    let mut new_records = vec![];
    for rec in recs {
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_zone_aor::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            zone_id: Set(zone_id),
            aor_id: Set(aors_map.get(&rec.aor_id).cloned().context(h!())?),
            created_at: Set(rec.created_at),
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
        result.insert(rec.id, new_id);
        new_records.push(new_rec.clone());
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_post_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_post::Model>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_posts(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    // currently post name is unique
    let mut existing_posts_by_name = sigint_post::Entity::find()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|p| (p.name, p.id))
        .collect::<HashMap<_, _>>();
    for rec in recs {
        if let Some(post_id) = existing_posts_by_name.remove(&rec.name) {
            result.insert(rec.id, post_id);
            continue;
        }
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_post::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            name: Set(rec.name),
            origin: Set(rec.origin),
            sigint_origin_id: Set(Some(origin_id)),
            description: Set(rec.description),
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
        result.insert(rec.id, new_id);
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_descriptions(txn, &recs, origin_id)
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
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_description::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            network_id: Set(sigint_network_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            r#type: Set(rec.r#type),
            topic: Set(rec.topic),
            description: Set(rec.description),
            comment: Set(rec.comment),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            sigint_network_freq_id,
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_freqs(txn, &recs, origin_id)
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
        let encryption_id = match rec.encryption_id {
            None => NotSet,
            Some(encryption_id) => {
                let Some(new_id) =
                    modulation_ids_map.get(&encryption_id).cloned()
                else {
                    import_warnings.push(format!(
                        "encryption with id {encryption_id} not found"
                    ));
                    continue;
                };
                Set(Some(new_id))
            }
        };
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_freq::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            encryption_id,
            network_id: Set(sigint_network_id),
            freq: Set(rec.freq),
            created_at: Set(rec.created_at),
            last_seen_dt: Set(rec.last_seen_dt),
            kind: Set(match rec.modulation.as_str() {
                "NFM" | "AM" => SigintNetworkKind::Vhf,
                _ => SigintNetworkKind::Dmr,
            }),
            modulation: Set(rec.modulation),
            modulation_id: NotSet,
            active_from: Set(rec.active_from),
            active_to: Set(rec.active_to),
            deleted: Set(rec.deleted),
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
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_callsign_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_callsign::Model>,
    sigint_network_import_result: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_callsigns(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(network_id) = sigint_network_import_result
            .get(&rec.sigint_network_id)
            .cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.sigint_network_id
            ));
            continue;
        };
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_callsign::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_network_id: Set(network_id),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            sigint_callsign_id: Set(rec.sigint_callsign_id),
            sigint_callsign: Set(rec.sigint_callsign),
            position: Set(rec.position),
            comment: Set(rec.comment),
            full_name: Set(rec.full_name),
            source_id: Set(rec.source_id),
            radio_freq: Set(rec.radio_freq),
            developing: Set(rec.developing),
            sigint_origin_id: Set(Some(origin_id)),
            unit_developing: Set(rec.unit_developing),
            unit_id: Set(rec.unit_id),
            main_radio_station: Set(rec.main_radio_station),
            command_control: Set(rec.command_control),
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
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_callsign_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_callsign_changelog::Model>,
    sigint_network_callsign_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_callsign_changelogs(
            txn, &recs, origin_id,
        )
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(sigint_network_callsign_id) = sigint_network_callsign_ids_map
            .get(&rec.sigint_network_callsign_id)
            .cloned()
        else {
            import_warnings.push(format!(
                "sigint_callsign with id {} not found",
                rec.sigint_network_callsign_id
            ));
            continue;
        };
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_callsign_changelog::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_network_callsign_id: Set(sigint_network_callsign_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
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
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}
async fn import_sigint_network_post_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_post::Model>,
    sigint_network_import_result: BTreeMap<i64, i64>,
    sigint_post_import_result: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_posts(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(post_id) =
            sigint_post_import_result.get(&(rec.post_id)).cloned()
        else {
            import_warnings
                .push(format!("sigint_post with id {} not found", rec.post_id));
            continue;
        };
        let Some(network_id) =
            sigint_network_import_result.get(&rec.network_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.network_id
            ));
            continue;
        };
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_post::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            network_id: Set(network_id),
            post_id: Set(post_id),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_callsigns(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        // Convert source_id to Option<i32> first
        let source_id = rec.source_id.and_then(|src_id| {
            source_ids_map
                .get(&(src_id as i64))
                .map(|&mapped_id| mapped_id as i32)
        });
        let Some(unit_id) = sigint_unit_ids_map.get(&rec.unit_id).cloned()
        else {
            import_warnings
                .push(format!("sigint_unit with id {} not found", rec.unit_id));
            continue;
        };
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_callsign::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            callsign: Set(rec.callsign),
            position: Set(rec.position),
            comment: Set(rec.comment),
            full_name: Set(rec.full_name),
            unit_id: Set(unit_id),
            deleted: Set(rec.deleted),
            created_at: Set(rec.created_at),
            source_id: Set(source_id),
            developing: Set(rec.developing),
            radio_freq: Set(rec.radio_freq),
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_units(txn, &recs, origin_id)
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
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_unit::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            network_id: Set(sigint_network_id),
            unit_id: Set(unit_id),
            created_at: Set(rec.created_at),
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
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_unit_changelogs(
            txn, &recs, origin_id,
        )
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
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
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_unit_changelog::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_network_unit_id: Set(sigint_network_unit_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
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

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_callsign_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_callsign_changelog::Model>,
    sigint_callsign_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_callsign_changelogs(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
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
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_callsign_changelog::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_callsign_id: Set(sigint_callsign_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
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
        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_signal_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_signal_changelog::Model>,
    sigint_signal_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_signal_changelogs(txn, &recs, origin_id)
            .await
            .context(h!())?;
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
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_signal_changelog::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_signal_id: Set(sigint_signal_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
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

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_freq_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_freq_changelog::Model>,
    sigint_network_freq_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_freq_changelogs(
            txn, &recs, origin_id,
        )
        .await
        .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
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
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_freq_changelog::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_network_freq_id: Set(sigint_network_freq_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
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

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn import_sigint_network_changelog_data<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    recs: Vec<sigint_network_changelog::Model>,
    sigint_network_ids_map: BTreeMap<i64, i64>,
    import_warnings: &mut Vec<String>,
) -> anyhow::Result<ImportResult<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut num_created = 0;
    let mut num_updated = 0;
    let existing_record_ids =
        query::find_existing_sigint_network_changelogs(txn, &recs, origin_id)
            .await
            .context(h!())?;
    let mut result = BTreeMap::new();
    for rec in recs {
        let Some(sigint_network_id) =
            sigint_network_ids_map.get(&rec.sigint_network_id).cloned()
        else {
            import_warnings.push(format!(
                "sigint_network with id {} not found",
                rec.sigint_network_id
            ));
            continue;
        };
        let (id, new_record) = match existing_record_ids.get(&rec.id) {
            None => (NotSet, true),
            Some(id) => (Set(*id), false),
        };

        let model = sigint_network_changelog::ActiveModel {
            original_id: Set(Some(rec.id)),
            id,
            sigint_network_id: Set(sigint_network_id),
            login_id: Set(crate::users::system_login_id(txn).await.c(h!())?),
            action: Set(rec.action),
            created_at: Set(rec.created_at),
            req: Set(rec.req),
            sigint_origin_id: Set(Some(origin_id)),
            new_value: Set(rec.new_value),
            old_value: Set(rec.old_value),
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

        result.insert(rec.id, new_id);
    }
    Ok(ImportResult {
        ids_map: result,
        num_created,
        num_updated,
    })
}

async fn maybe_commit(
    txn: DatabaseTransaction,
    dbx: &DatabaseConnection,
    dry_run: bool,
) -> anyhow::Result<DatabaseTransaction> {
    if dry_run {
        return Ok(txn);
    };
    txn.commit().await.context(h!())?;
    dbx.begin().await.context(h!())
}

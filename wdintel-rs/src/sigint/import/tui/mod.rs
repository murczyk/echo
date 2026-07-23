use crate::config::*;
use crate::entities::sea_orm_active_enums::SigintNetworkKind;
use crate::entities::*;
use crate::error::AppError;
use crate::sigint::import::types::EtalonData;
use crate::sigint::unit::types::Unit;
use crate::sigint::unit::{render_unit, unit_name};
use crate::types::*;
use crate::{h, new_pg_pool_from_mode, ImportTuiPs};
use anyhow::Context;
use crossterm::event::{self, Event, KeyCode};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use dialoguer::{theme::ColorfulTheme, Confirm};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use sea_orm::*;
use serde_json::json;
use std::io;
use std::io::Stdout;
use std::time::Duration;
use tempfile::TempDir;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use types::*;

pub mod types;

enum DataKind {
    Units,
    Networks,
    NetworkFeqs,
}

#[derive(PartialEq)]
enum MergeKind {
    Skip,
    MergeAToB,
    MergeBToA,
}

pub async fn run_merge_unit_tui(mode: Mode) -> Result<(), AppError> {
    let tmp_dir = TempDir::new()?;
    let now = Utc::now().naive_utc();
    let path = tmp_dir
        .path()
        .join(format!("merge_unit_{now}.json"))
        .as_os_str()
        .to_string_lossy()
        .to_string();
    crate::sigint::import::oneoff_export_etalon_data(mode, path.clone(), None)
        .await
        .c(h!())?;
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut file_read = File::open(path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon_txt = String::from_utf8_lossy(&buffer).to_string();
    let etalon_full: EtalonData =
        serde_json::from_str(&etalon_txt).context(h!())?;
    let units = etalon_full.sigint_unit;
    let result = load_unit_data(&db, units, true).await.c(h!())?;
    let records_to_merge = result.perfect_matches;
    let models = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(&db)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|u| render_unit(&u).ok().map(|u1| (u.id, (u, u1))))
        .map(|(id, (u1, u2))| (id, unit_details(u2, u1.deleted)))
        .collect::<HashMap<_, _>>();

    if let Err(e) =
        merge_all(&db, records_to_merge, models, DataKind::Units).await
    {
        error!("{:#?}", e);
    }
    Ok(())
}

pub async fn run_merge_network_tui(mode: Mode) -> Result<(), AppError> {
    let tmp_dir = TempDir::new()?;
    let now = Utc::now().naive_utc();
    let path = tmp_dir
        .path()
        .join(format!("merge_network_{now}.json"))
        .as_os_str()
        .to_string_lossy()
        .to_string();
    crate::sigint::import::oneoff_export_etalon_data(mode, path.clone(), None)
        .await
        .c(h!())?;
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut file_read = File::open(path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon_txt = String::from_utf8_lossy(&buffer).to_string();
    let etalon_full: EtalonData =
        serde_json::from_str(&etalon_txt).context(h!())?;
    let units = etalon_full.sigint_unit;
    let unit_data = load_unit_data(&db, units, false).await.c(h!())?;
    let imported_network_units: Vec<sigint_network_unit::Model> =
        etalon_full.sigint_network_unit;
    let imported_networks: Vec<sigint_network::Model> =
        etalon_full.sigint_network;
    let result = load_network_data(
        &db,
        unit_data,
        imported_network_units,
        imported_networks,
        true,
    )
    .await
    .c(h!())?;

    let sigint_network_units = sigint_network_unit::Entity::find()
        .all(&db)
        .await
        .c(h!())?
        .into_iter()
        .map(|m| (m.network_id, m.unit_id))
        .collect::<HashMap<_, _>>();
    let mut models = HashMap::new();
    let records_to_merge = result.perfect_matches;
    for (_, network_rows) in result.data {
        for network_row in network_rows {
            let id = network_row.recording.id;
            let rec = add_network_model(
                &result.models,
                &sigint_network_units,
                network_row,
            );
            if let Some(rec) = rec {
                models.insert(id, rec);
            }
        }
    }

    if let Err(e) =
        merge_all(&db, records_to_merge, models, DataKind::Networks).await
    {
        error!("{:#?}", e);
    }
    Ok(())
}

pub async fn run_merge_network_freq_tui(mode: Mode) -> Result<(), AppError> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let (records_to_merge, details) =
        collect_duplicate_network_freqs(&db).await?;
    if records_to_merge.is_empty() {
        println!("No duplicate network frequencies found.");
        return Ok(());
    }

    if let Err(e) =
        merge_all(&db, records_to_merge, details, DataKind::NetworkFeqs).await
    {
        error!("{:#?}", e);
    }
    Ok(())
}

async fn collect_duplicate_network_freqs(
    db: &DatabaseConnection,
) -> Result<(Vec<Vec<i64>>, HashMap<i64, DataRecDetailed>), AppError> {
    let modulation_map = load_encryption_map(db).await?;
    let network_names = load_network_name_map(db).await?;

    let freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .all(db)
        .await
        .c(h!())?;

    let mut grouped: HashMap<(i64, String), Vec<sigint_network_freq::Model>> =
        HashMap::new();
    for network_freq in freqs {
        grouped
            .entry((network_freq.network_id, network_freq.freq.clone()))
            .or_default()
            .push(network_freq);
    }

    let mut records_to_merge = Vec::new();
    let mut details = HashMap::new();
    for ((network_id, _freq), network_freqs) in grouped {
        if network_freqs.len() < 2 {
            continue;
        }
        records_to_merge
            .push(network_freqs.iter().map(|rec| rec.id).collect::<Vec<_>>());
        let network_name = network_names
            .get(&network_id)
            .cloned()
            .unwrap_or("-".to_string());
        for network_freq in network_freqs {
            let rec = network_freq_details(
                network_freq,
                &network_name,
                &modulation_map,
            );
            details.insert(rec.id, rec);
        }
    }

    Ok((records_to_merge, details))
}

async fn load_encryption_map(
    db: &DatabaseConnection,
) -> Result<HashMap<i32, encryption::Model>, AppError> {
    let map = encryption::Entity::find()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|rec| (rec.id, rec))
        .collect::<HashMap<_, _>>();
    Ok(map)
}

async fn load_network_name_map(
    db: &DatabaseConnection,
) -> Result<HashMap<i64, String>, AppError> {
    let map = sigint_network::Entity::find()
        .select_only()
        .column(sigint_network::Column::Id)
        .column(sigint_network::Column::Name)
        .into_tuple::<(i64, String)>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashMap<_, _>>();
    Ok(map)
}

fn network_freq_details(
    network_freq: sigint_network_freq::Model,
    network_name: &str,
    encryption_map: &HashMap<i32, encryption::Model>,
) -> DataRecDetailed {
    let encryption = network_freq
        .encryption_id
        .and_then(|id| encryption_map.get(&id))
        .map(|rec| rec.name.clone())
        .unwrap_or("-".to_string());
    let full_name = format!("{} {}", network_freq.freq.trim(), network_name);
    let mut details = HashMap::new();
    details.insert("freq".to_string(), network_freq.freq.clone());
    details.insert("network".to_string(), network_name.to_string());
    details.insert("deleted".to_string(), format!("{}", network_freq.deleted));
    details.insert("modulation".to_string(), network_freq.modulation.clone());
    details.insert(
        "network_id".to_string(),
        network_freq.network_id.to_string(),
    );
    details.insert("encryption".to_string(), encryption);
    details.insert(
        "active_from".to_string(),
        format!("{:?}", network_freq.active_from),
    );
    details.insert(
        "active_to".to_string(),
        network_freq
            .active_to
            .map(|n| format!("{n}"))
            .unwrap_or("-".to_string())
            .to_string(),
    );

    DataRecDetailed {
        id: network_freq.id,
        full_name,
        details,
    }
}

pub async fn run_import_unit_tui(
    mode: Mode,
    ps: ImportTuiPs,
) -> Result<(), AppError> {
    info!("loading data from {}...", ps.path);
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut file_read = File::open(ps.path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon_txt = String::from_utf8_lossy(&buffer).to_string();
    let etalon_full: EtalonData =
        serde_json::from_str(&etalon_txt).context(h!())?;
    let units = etalon_full.sigint_unit;
    let data_to_import = load_unit_data(&db, units, true).await.c(h!())?;

    let mut terminal = setup_terminal().c(h!())?;
    let res_data =
        run_import_loop("UNITS", &mut terminal, &data_to_import.data).await;
    restore_terminal(&mut terminal).c(h!())?;
    if let Some(data) = res_data.c(h!())? {
        import_data(data, data_to_import, &db).await.c(h!())?;
    }
    Ok(())
}

pub async fn run_import_network_tui(
    mode: Mode,
    ps: ImportTuiPs,
) -> Result<(), AppError> {
    info!("loading data from {}...", ps.path);
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut file_read = File::open(ps.path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon_txt = String::from_utf8_lossy(&buffer).to_string();
    let etalon_full: EtalonData =
        serde_json::from_str(&etalon_txt).context(h!())?;
    let units = etalon_full.sigint_unit;
    let unit_data = load_unit_data(&db, units, false).await.c(h!())?;
    let imported_network_units: Vec<sigint_network_unit::Model> =
        etalon_full.sigint_network_unit;
    let imported_networks: Vec<sigint_network::Model> =
        etalon_full.sigint_network;
    let network_data = load_network_data(
        &db,
        unit_data,
        imported_network_units,
        imported_networks,
        true,
    )
    .await
    .c(h!())?;

    let mut terminal = setup_terminal().c(h!())?;
    let res_data =
        run_import_loop("NETWORKS", &mut terminal, &network_data.data).await;
    restore_terminal(&mut terminal).c(h!())?;
    if let Some(data) = res_data.c(h!())? {
        import_network_data(data, network_data, &db).await.c(h!())?;
    }
    Ok(())
}

pub async fn oneoff_import_network_details(
    mode: Mode,
    ps: ImportTuiPs,
) -> Result<(), AppError> {
    info!("loading data from {}...", ps.path);
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut file_read = File::open(ps.path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon_txt = String::from_utf8_lossy(&buffer).to_string();
    let etalon_full: EtalonData =
        serde_json::from_str(&etalon_txt).context(h!())?;
    let units = etalon_full.sigint_unit;
    let mut unit_data = load_unit_data(&db, units, false).await.c(h!())?;
    let imported_network_units: Vec<sigint_network_unit::Model> =
        etalon_full.sigint_network_unit;
    let imported_networks: Vec<sigint_network::Model> =
        etalon_full.sigint_network;
    let mut network_data = load_network_data(
        &db,
        unit_data.clone(),
        imported_network_units.clone(),
        imported_networks.clone(),
        true,
    )
    .await
    .c(h!())?;

    let mut network_matches = HashMap::new();
    let matched_networks =
        network_data.data.remove(&Tab::Matched).unwrap_or_default();
    for n in matched_networks {
        let original_id = n.recording.id;
        let Some(target_network_id) = n.target.map(|r| r.id) else {
            continue;
        };
        network_matches.insert(original_id, target_network_id);
    }

    let mut unit_matches = HashMap::new();
    let matched_units =
        unit_data.data.remove(&Tab::Matched).unwrap_or_default();
    for u in matched_units {
        let original_id = u.recording.id;
        let Some(target_unit_id) = u.target.map(|r| r.id) else {
            continue;
        };
        unit_matches.insert(original_id, target_unit_id);
    }

    let matched_by_original_id = add_network_matches_by_original_id(
        &db,
        &mut network_matches,
        &imported_networks,
        &imported_network_units,
    )
    .await
    .c(h!())?;
    if matched_by_original_id > 0 {
        info!(
            "Matched {matched_by_original_id} non-matched network(s) via original_id."
        );
    }

    import_network_freqs(
        network_matches.clone(),
        etalon_full.sigint_network_freq,
        etalon_full.encryption,
        &db,
    )
    .await
    .c(h!())?;

    import_sigint_signals(unit_matches.clone(), etalon_full.sigint_signal, &db)
        .await
        .c(h!())?;

    import_sigint_network_descriptions(
        network_matches.clone(),
        etalon_full.sigint_network_description,
        &db,
    )
    .await
    .c(h!())?;

    import_sigint_network_aors(
        network_matches.clone(),
        etalon_full.sigint_network_aor,
        etalon_full.area_of_responsibility,
        &db,
    )
    .await
    .c(h!())?;

    let matched_sigint_callsigns = import_sigint_callsigns(
        unit_matches.clone(),
        etalon_full.sigint_callsign,
        &db,
    )
    .await
    .c(h!())?;

    import_network_callsigns(
        unit_matches,
        network_matches,
        matched_sigint_callsigns,
        etalon_full.sigint_network_callsign,
        &db,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn add_network_matches_by_original_id(
    db: &DatabaseConnection,
    network_matches: &mut HashMap<i64, i64>,
    imported_networks: &[sigint_network::Model],
    imported_network_units: &[sigint_network_unit::Model],
) -> anyhow::Result<usize> {
    let unmatched_import_network_ids = imported_networks
        .iter()
        .map(|network| network.id)
        .filter(|network_id| !network_matches.contains_key(network_id))
        .collect_vec();
    if unmatched_import_network_ids.is_empty() {
        return Ok(0);
    }

    let mut imported_unit_ids_by_network_id = HashMap::new();
    for imported_network_unit in imported_network_units {
        imported_unit_ids_by_network_id
            .entry(imported_network_unit.network_id)
            .or_insert_with(Vec::new)
            .push(imported_network_unit.unit_id);
    }

    let local_networks = sigint_network::Entity::find()
        .filter(
            sigint_network::Column::OriginalId
                .is_in(unmatched_import_network_ids.clone()),
        )
        .all(db)
        .await
        .c(h!())?;
    let mut local_networks_by_original_id = HashMap::new();
    for local_network in local_networks {
        let Some(original_id) = local_network.original_id else {
            continue;
        };
        local_networks_by_original_id
            .entry(original_id)
            .or_insert_with(Vec::new)
            .push(local_network.id);
    }

    let mut matched_counter = 0;
    for imported_network in imported_networks {
        if network_matches.contains_key(&imported_network.id) {
            continue;
        }
        let local_network_ids = local_networks_by_original_id
            .get(&imported_network.id)
            .cloned()
            .unwrap_or_default();
        if local_network_ids.len() == 1 {
            let local_network_id = local_network_ids[0];
            network_matches.insert(imported_network.id, local_network_id);
            matched_counter += 1;
            continue;
        }
        let unit_ids = imported_unit_ids_by_network_id
            .get(&imported_network.id)
            .cloned()
            .unwrap_or_default();
        let unit_ids_txt = if unit_ids.is_empty() {
            "-".to_string()
        } else {
            unit_ids.iter().join(",")
        };
        let unresolved_reason = if local_network_ids.is_empty() {
            "no_local_original_id_match"
        } else {
            "multiple_local_original_id_matches"
        };
        warn!(
            "Unmatched network: id={}, name=\"{}\", import_unit_ids=[{}], reason={}",
            imported_network.id,
            imported_network.name,
            unit_ids_txt,
            unresolved_reason
        );
    }

    Ok(matched_counter)
}

async fn import_sigint_network_aors(
    network_matches: HashMap<i64, i64>,
    import_sigint_network_aors: Vec<sigint_network_aor::Model>,
    import_aors: Vec<area_of_responsibility::Model>,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let import_aors_by_id = import_aors
        .into_iter()
        .map(|aor| (aor.id, aor))
        .collect::<HashMap<_, _>>();
    let import_aor_original_ids = import_aors_by_id
        .values()
        .filter(|aor| !(aor.is_top_level && aor.is_default))
        .map(|aor| aor.id)
        .collect_vec();
    let local_default_aor = crate::sigint::aor::load_default_aor(db).await?;
    let local_aors = if import_aor_original_ids.is_empty() {
        Vec::new()
    } else {
        area_of_responsibility::Entity::find()
            .filter(
                area_of_responsibility::Column::OriginalId
                    .is_in(import_aor_original_ids),
            )
            .all(db)
            .await
            .c(h!())?
    };
    let local_aors_by_original_id = local_aors
        .into_iter()
        .flat_map(|aor| aor.original_id.map(|id| (id, aor.id)))
        .collect::<HashMap<_, _>>();

    let network_aors_to_import = import_sigint_network_aors
        .into_iter()
        .filter(|rec| network_matches.contains_key(&rec.network_id))
        .collect_vec();
    let local_network_ids = network_matches.values().cloned().collect_vec();
    let existing_network_aors = if local_network_ids.is_empty() {
        HashMap::new()
    } else {
        sigint_network_aor::Entity::find()
            .filter(
                sigint_network_aor::Column::NetworkId.is_in(local_network_ids),
            )
            .all(db)
            .await
            .c(h!())?
            .into_iter()
            .map(|rec| ((rec.network_id, rec.aor_id), rec))
            .collect::<HashMap<_, _>>()
    };

    let mut network_aors_to_create = Vec::new();
    for import_aor in network_aors_to_import {
        let Some(network_id) = network_matches.get(&import_aor.network_id)
        else {
            continue;
        };
        let Some(import_aor_details) =
            import_aors_by_id.get(&import_aor.aor_id)
        else {
            continue;
        };
        let local_aor_id = if import_aor_details.is_top_level
            && import_aor_details.is_default
        {
            local_default_aor.id
        } else {
            let Some(local_aor_id) =
                local_aors_by_original_id.get(&import_aor_details.id)
            else {
                continue;
            };
            *local_aor_id
        };

        if existing_network_aors.contains_key(&(*network_id, local_aor_id)) {
            continue;
        }
        network_aors_to_create.push(sigint_network_aor::ActiveModel {
            id: NotSet,
            network_id: Set(*network_id),
            aor_id: Set(local_aor_id),
            created_at: Set(import_aor.created_at),
            sigint_origin_id: Set(import_aor.sigint_origin_id),
            original_id: Set(import_aor.original_id),
        });
    }
    let new_network_aors_counter = network_aors_to_create.len();
    let txn = db.begin().await.c(h!())?;
    for rec in network_aors_to_create {
        rec.insert(&txn).await.c(h!())?;
    }
    confirm_new_records_and_finish(
        txn,
        new_network_aors_counter,
        "sigint_network_aor",
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn import_network_callsigns(
    unit_matches: HashMap<i64, i64>,
    network_matches: HashMap<i64, i64>,
    sigint_callsign_matches: HashMap<i64, i64>,
    sigint_network_callsigns: Vec<sigint_network_callsign::Model>,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let local_network_ids = network_matches.values().cloned().collect_vec();
    let local_sigint_callsign_ids =
        sigint_callsign_matches.values().cloned().collect_vec();
    let local_unit_ids = unit_matches.values().cloned().collect_vec();
    let mut cond = Condition::any();
    if !local_network_ids.is_empty() {
        cond = cond.add(
            sigint_network_callsign::Column::SigintNetworkId
                .is_in(local_network_ids),
        );
    }
    if !local_unit_ids.is_empty() {
        cond = cond.add(
            sigint_network_callsign::Column::UnitId
                .is_in(local_unit_ids)
                .or(sigint_network_callsign::Column::UnitId.is_null()),
        );
    }
    if !local_sigint_callsign_ids.is_empty() {
        cond =
            cond.add(
                sigint_network_callsign::Column::SigintCallsignId
                    .is_in(local_sigint_callsign_ids)
                    .or(sigint_network_callsign::Column::SigintCallsignId
                        .is_null()),
            );
    }

    let existing_network_callsigns = sigint_network_callsign::Entity::find()
        .filter(cond)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|s| {
            (
                (
                    s.unit_id,
                    s.sigint_callsign_id,
                    s.sigint_network_id,
                    s.sigint_callsign.clone(),
                ),
                s,
            )
        })
        .collect::<HashMap<_, _>>();
    let mut callsign_to_create = Vec::new();
    for import_signal in sigint_network_callsigns {
        let sigint_callsign_id = match import_signal.sigint_callsign_id {
            None => None,
            Some(sigint_callsign_id) => {
                let Some(sigint_callsign_id) =
                    sigint_callsign_matches.get(&sigint_callsign_id)
                else {
                    continue;
                };
                Some(*sigint_callsign_id)
            }
        };
        let unit_id = match import_signal.unit_id {
            None => None,
            Some(unit_id) => {
                let Some(unit_id) = unit_matches.get(&unit_id) else {
                    continue;
                };
                Some(*unit_id)
            }
        };
        let Some(sigint_network_id) =
            network_matches.get(&import_signal.sigint_network_id)
        else {
            continue;
        };
        let already_existing = existing_network_callsigns.get(&(
            unit_id,
            sigint_callsign_id,
            *sigint_network_id,
            import_signal.sigint_callsign.clone(),
        ));
        if already_existing.is_some() {
            continue;
        }
        callsign_to_create.push(sigint_network_callsign::ActiveModel {
            id: NotSet,
            sigint_network_id: Set(*sigint_network_id),
            sigint_callsign: Set(import_signal.sigint_callsign),
            position: Set(import_signal.position),
            comment: Set(import_signal.comment),
            full_name: NotSet,
            sigint_callsign_id: Set(sigint_callsign_id),
            source_id: NotSet,
            radio_freq: Set(import_signal.radio_freq),
            developing: Set(import_signal.developing),
            unit_developing: Set(import_signal.unit_developing),
            unit_id: Set(unit_id),
            main_radio_station: Set(import_signal.main_radio_station),
            command_control: Set(import_signal.command_control),
            deleted: Set(import_signal.deleted),
            created_at: Set(import_signal.created_at),
            sigint_origin_id: Set(import_signal.sigint_origin_id),
            original_id: Set(import_signal.original_id),
        });
    }
    let new_callsigns_counter = callsign_to_create.len();
    let txn = db.begin().await.c(h!())?;
    for rec in callsign_to_create {
        rec.insert(&txn).await.c(h!())?;
    }
    confirm_new_records_and_finish(
        txn,
        new_callsigns_counter,
        "sigint_network_callsign",
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn import_sigint_signals(
    unit_matches: HashMap<i64, i64>,
    import_sigint_signal: Vec<sigint_signal::Model>,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let sigint_signals_to_import = import_sigint_signal
        .into_iter()
        .filter(|s| s.unit.is_none_or(|id| unit_matches.contains_key(&id)))
        .collect_vec();
    let local_unit_ids = unit_matches.values().cloned().collect_vec();
    let include_null_units =
        sigint_signals_to_import.iter().any(|s| s.unit.is_none());
    let existing_sigint_signals = if local_unit_ids.is_empty()
        && !include_null_units
    {
        HashMap::new()
    } else {
        let mut cond = Condition::any();
        if !local_unit_ids.is_empty() {
            cond = cond.add(sigint_signal::Column::Unit.is_in(local_unit_ids));
        }
        if include_null_units {
            cond = cond.add(sigint_signal::Column::Unit.is_null());
        }
        sigint_signal::Entity::find()
            .filter(cond)
            .all(db)
            .await
            .c(h!())?
            .into_iter()
            .map(|s| ((s.unit, s.text.clone()), s))
            .collect::<HashMap<_, _>>()
    };
    let mut signals_to_create = Vec::new();
    for import_signal in sigint_signals_to_import {
        let unit_id = match import_signal.unit {
            None => None,
            Some(unit_id) => {
                let Some(unit_id) = unit_matches.get(&unit_id) else {
                    continue;
                };
                Some(*unit_id)
            }
        };
        let already_existing =
            existing_sigint_signals.get(&(unit_id, import_signal.text.clone()));
        if already_existing.is_some() {
            continue;
        }
        signals_to_create.push(sigint_signal::ActiveModel {
            id: NotSet,
            text: Set(import_signal.text),
            meaning: Set(import_signal.meaning),
            unit: Set(unit_id),
            coordinates: Set(import_signal.coordinates),
            deleted: Set(import_signal.deleted),
            created_at: Set(import_signal.created_at),
            sigint_origin_id: Set(import_signal.sigint_origin_id),
            original_id: Set(import_signal.original_id),
        });
    }
    let new_signals_counter = signals_to_create.len();
    let txn = db.begin().await.c(h!())?;
    for rec in signals_to_create {
        rec.insert(&txn).await.c(h!())?;
    }
    confirm_new_records_and_finish(txn, new_signals_counter, "sigint_signal")
        .await?;
    Ok(())
}

async fn import_sigint_callsigns(
    unit_matches: HashMap<i64, i64>,
    import_sigint_callsign: Vec<sigint_callsign::Model>,
    db: &DatabaseConnection,
) -> anyhow::Result<HashMap<i64, i64>> {
    let mut result = HashMap::new();
    let mut new_result = HashMap::new();
    let callsigns_to_import = import_sigint_callsign
        .into_iter()
        .filter(|c| unit_matches.contains_key(&c.unit_id))
        .collect_vec();
    let local_unit_ids = unit_matches.values().cloned().collect_vec();
    let existing_sigint_callsigns = if local_unit_ids.is_empty() {
        HashMap::new()
    } else {
        sigint_callsign::Entity::find()
            .filter(sigint_callsign::Column::UnitId.is_in(local_unit_ids))
            .all(db)
            .await
            .c(h!())?
            .into_iter()
            .map(|c| ((c.unit_id, c.callsign.clone()), c))
            .collect::<HashMap<_, _>>()
    };
    let mut existing_callsign_keys = existing_sigint_callsigns
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let mut created_callsigns = HashMap::new();
    let txn = db.begin().await.c(h!())?;
    let mut new_callsigns_counter = 0;
    for import_callsign in callsigns_to_import {
        let Some(unit_id) = unit_matches.get(&import_callsign.unit_id) else {
            continue;
        };
        let key = (*unit_id, import_callsign.callsign.clone());
        if let Some(existing) = existing_sigint_callsigns.get(&key) {
            result.insert(import_callsign.id, existing.id);
            continue;
        }
        if let Some(existing_id) = created_callsigns.get(&key) {
            result.insert(import_callsign.id, *existing_id);
            continue;
        }
        if existing_callsign_keys.contains(&key) {
            continue;
        }
        let res_rec = sigint_callsign::ActiveModel {
            id: NotSet,
            callsign: Set(import_callsign.callsign),
            position: Set(import_callsign.position),
            comment: Set(import_callsign.comment),
            full_name: Set(import_callsign.full_name),
            unit_id: Set(*unit_id),
            deleted: Set(import_callsign.deleted),
            created_at: Set(import_callsign.created_at),
            source_id: Set(import_callsign.source_id),
            developing: Set(import_callsign.developing),
            radio_freq: Set(import_callsign.radio_freq),
            sigint_origin_id: Set(import_callsign.sigint_origin_id),
            original_id: Set(import_callsign.original_id),
        }
        .insert(&txn)
        .await
        .c(h!())?;
        existing_callsign_keys.insert(key.clone());
        created_callsigns.insert(key, res_rec.id);
        new_result.insert(import_callsign.id, res_rec.id);
        new_callsigns_counter += 1;
    }
    let confirmed = confirm_new_records_and_finish(
        txn,
        new_callsigns_counter,
        "sigint_callsign",
    )
    .await
    .c(h!())?;
    if confirmed {
        for (id1, id2) in new_result {
            result.insert(id1, id2);
        }
    }
    Ok(result)
}

async fn import_sigint_network_descriptions(
    network_matches: HashMap<i64, i64>,
    import_sigint_network_description: Vec<sigint_network_description::Model>,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let descriptions_to_import = import_sigint_network_description
        .into_iter()
        .filter(|d| network_matches.contains_key(&d.network_id))
        .collect_vec();
    let local_network_ids = network_matches.values().cloned().collect_vec();
    let existing_sigint_network_descriptions = if local_network_ids.is_empty() {
        HashMap::new()
    } else {
        sigint_network_description::Entity::find()
            .filter(
                sigint_network_description::Column::NetworkId
                    .is_in(local_network_ids),
            )
            .all(db)
            .await
            .c(h!())?
            .into_iter()
            .map(|d| ((d.network_id, format!("{:?}", d.r#type)), d))
            .collect::<HashMap<_, _>>()
    };
    let import_freq_ids = descriptions_to_import
        .iter()
        .filter_map(|d| d.sigint_network_freq_id)
        .collect_vec();
    let sigint_network_freq_id_map = if import_freq_ids.is_empty() {
        HashMap::new()
    } else {
        sigint_network_freq::Entity::find()
            .filter(
                sigint_network_freq::Column::OriginalId.is_in(import_freq_ids),
            )
            .all(db)
            .await
            .c(h!())?
            .into_iter()
            .flat_map(|f| f.original_id.map(|id| (id, f.id)))
            .collect::<HashMap<_, _>>()
    };
    let mut descriptions_to_create = Vec::new();
    for import_desc in descriptions_to_import {
        let Some(network_id) = network_matches.get(&import_desc.network_id)
        else {
            continue;
        };
        let already_existing = existing_sigint_network_descriptions
            .get(&(*network_id, format!("{:?}", import_desc.r#type)));
        if already_existing.is_some() {
            continue;
        }
        let sigint_network_freq_id = import_desc
            .sigint_network_freq_id
            .and_then(|id| sigint_network_freq_id_map.get(&id).cloned());
        descriptions_to_create.push(sigint_network_description::ActiveModel {
            id: NotSet,
            network_id: Set(*network_id),
            login_id: Set(crate::users::system_login_id(db).await?),
            r#type: Set(import_desc.r#type),
            topic: Set(import_desc.topic),
            description: Set(import_desc.description),
            comment: Set(import_desc.comment),
            deleted: Set(import_desc.deleted),
            created_at: Set(import_desc.created_at),
            sigint_network_freq_id: Set(sigint_network_freq_id),
            sigint_origin_id: Set(import_desc.sigint_origin_id),
            original_id: Set(import_desc.original_id),
        });
    }
    let new_descriptions_counter = descriptions_to_create.len();
    let txn = db.begin().await.c(h!())?;
    for rec in descriptions_to_create {
        rec.insert(&txn).await.c(h!())?;
    }
    confirm_new_records_and_finish(
        txn,
        new_descriptions_counter,
        "sigint_network_description",
    )
    .await?;
    Ok(())
}

async fn import_network_freqs(
    network_matches: HashMap<i64, i64>,
    import_sigint_network_freqs: Vec<sigint_network_freq::Model>,
    encryption: Vec<encryption::Model>,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let local_encryption_map = encryption::Entity::find()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|m| (m.name.clone(), m))
        .collect::<HashMap<_, _>>();
    let import_to_local_encryption_map: HashMap<i32, encryption::Model> =
        encryption
            .into_iter()
            .flat_map(|m| {
                local_encryption_map
                    .get(&m.name)
                    .map(|m2| (m.id, m2.clone()))
            })
            .collect::<HashMap<_, _>>();

    let sigint_network_freqs_to_import = import_sigint_network_freqs
        .into_iter()
        .filter(|f| network_matches.contains_key(&f.network_id))
        .collect_vec();
    let local_network_ids = network_matches.values().cloned().collect_vec();
    let existing_sigint_network_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.is_in(local_network_ids))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|f| ((f.network_id, f.freq.clone()), f))
        .collect::<HashMap<_, _>>();
    let mut freqs_to_create = Vec::new();
    for import_freq in sigint_network_freqs_to_import {
        let Some(network_id) = network_matches.get(&import_freq.network_id)
        else {
            continue;
        };
        let already_existing = existing_sigint_network_freqs
            .get(&(*network_id, import_freq.freq.clone()))
            .cloned();
        if already_existing.is_some() {
            //TODO update
            continue;
        }
        let encryption_id = import_freq
            .encryption_id
            .and_then(|id| import_to_local_encryption_map.get(&id))
            .map(|m| m.id);
        freqs_to_create.push(sigint_network_freq::ActiveModel {
            id: NotSet,
            network_id: Set(*network_id),
            freq: Set(import_freq.freq),
            created_at: Set(import_freq.created_at),
            last_seen_dt: Set(import_freq.last_seen_dt),
            kind: Set(match import_freq.modulation.as_str() {
                "NFM" | "AM" => SigintNetworkKind::Vhf,
                _ => SigintNetworkKind::Dmr,
            }),
            modulation: Set(import_freq.modulation),
            modulation_id: NotSet,
            encryption_id: Set(encryption_id),
            active_from: Set(import_freq.active_from),
            active_to: Set(import_freq.active_to),
            sigint_origin_id: Set(import_freq.sigint_origin_id),
            deleted: Set(import_freq.deleted),
            original_id: Set(import_freq.original_id),
        });
    }
    let new_freqs_counter = freqs_to_create.len();
    let txn = db.begin().await.c(h!())?;
    for rec in freqs_to_create {
        rec.insert(&txn).await.c(h!())?;
    }
    confirm_new_records_and_finish(
        txn,
        new_freqs_counter,
        "sigint_network_freq",
    )
    .await?;
    Ok(())
}

async fn confirm_new_records_and_finish(
    txn: DatabaseTransaction,
    new_recs_counter: usize,
    entity_name: &str,
) -> anyhow::Result<bool> {
    if new_recs_counter == 0 {
        info!("No new {entity_name} recs to insert.");
        txn.commit().await.c(h!())?;
        return Ok(false);
    }
    let import_confirmed = Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!(
            "Are you sure you want to create {new_recs_counter} new {entity_name} recordings?"
        ))
        .default(true)
        .interact()
        .context(h!())?;
    if !import_confirmed {
        txn.rollback().await.c(h!())?;
        info!("Import aborted.");
        return Ok(false);
    }
    txn.commit().await.c(h!())?;
    info!("inserted {new_recs_counter} new {entity_name} recs!");
    Ok(true)
}

fn setup_terminal() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;
    let backend = CrosstermBackend::new(stdout);
    Terminal::new(backend)
}

fn restore_terminal(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, cursor::Show)?;
    terminal.show_cursor()
}

async fn run_merge_once(
    title: &str,
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    left_item: DataRecDetailed,
    right_item: DataRecDetailed,
    item_id: i64,
    count: usize,
    counter: usize,
    total_count: usize,
    total_counter: usize,
) -> anyhow::Result<MergeKind> {
    let dupes_counter = if count == 1 {
        "".to_string()
    } else {
        format!(" ({counter}/{count})")
    };
    let text = format!(
        "{total_counter}/{total_count}: Merge {title} duplicates of #{item_id}{dupes_counter}? \n - a: Keep A, merge B into A\n - b: Keep B, merge A into B\n - n: skip"
    );
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
    terminal
        .draw(|frame| draw_merge_ui(frame, &text, left_item, right_item))
        .c(h!())?;
    loop {
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let ev = event::read().c(h!())?;
        if matches_quit(&ev) {
            anyhow::bail!("Quitting...");
        }
        if matches_key(&ev, 'a') {
            return Ok(MergeKind::MergeBToA);
        }
        if matches_key(&ev, 'b') {
            return Ok(MergeKind::MergeAToB);
        }
        if matches_key(&ev, 'n') {
            return Ok(MergeKind::Skip);
        }
        if matches_key(&ev, 'A') {
            return Ok(MergeKind::MergeBToA);
        }
        if matches_key(&ev, 'B') {
            return Ok(MergeKind::MergeAToB);
        }
        if matches_key(&ev, 'N') {
            return Ok(MergeKind::Skip);
        }
    }
}

fn draw_merge_ui(
    frame: &mut Frame,
    title: &str,
    rec1: DataRecDetailed,
    rec2: DataRecDetailed,
) {
    let title_lines = title
        .split('\n')
        .map(|line| Line::from(line.to_string()))
        .collect::<Vec<_>>();
    let title_height = title_lines.len().max(1) as u16;
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(title_height), Constraint::Min(1)])
        .split(frame.size());

    let header = Paragraph::new(title_lines);
    frame.render_widget(header, root[0]);

    let rows = build_merge_rows(rec1, rec2);

    let table_block = Block::default().borders(Borders::ALL).title("Diff");
    let table_inner = table_block.inner(root[1]);
    frame.render_widget(table_block, root[1]);

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(20),
            Constraint::Percentage(40),
            Constraint::Percentage(40),
        ])
        .split(table_inner);

    let left_block = Block::default().borders(Borders::RIGHT);
    let middle_block = Block::default().borders(Borders::LEFT | Borders::RIGHT);
    let right_block = Block::default().borders(Borders::LEFT);

    let left_inner = left_block.inner(columns[0]);
    let middle_inner = middle_block.inner(columns[1]);
    let right_inner = right_block.inner(columns[2]);

    frame.render_widget(left_block, columns[0]);
    frame.render_widget(middle_block, columns[1]);
    frame.render_widget(right_block, columns[2]);

    let (left_lines, middle_lines, right_lines) = build_merge_lines(
        &rows,
        left_inner.width as usize,
        middle_inner.width as usize,
        right_inner.width as usize,
    );

    frame.render_widget(
        Paragraph::new(left_lines).wrap(Wrap { trim: false }),
        left_inner,
    );
    frame.render_widget(
        Paragraph::new(middle_lines).wrap(Wrap { trim: false }),
        middle_inner,
    );
    frame.render_widget(
        Paragraph::new(right_lines).wrap(Wrap { trim: false }),
        right_inner,
    );
}

struct MergeRow {
    field: String,
    left: String,
    right: String,
    style: Style,
}

fn build_merge_rows(
    rec1: DataRecDetailed,
    rec2: DataRecDetailed,
) -> Vec<MergeRow> {
    let green = Style::default().fg(Color::Green);
    let yellow = Style::default().fg(Color::Yellow);
    let red = Style::default().fg(Color::Red);
    let header = Style::default().fg(Color::Cyan);

    let mut keys: Vec<String> = rec1
        .details
        .keys()
        .chain(rec2.details.keys())
        .cloned()
        .collect();
    keys.sort();
    keys.dedup();

    let mut rows = Vec::new();
    rows.push(MergeRow {
        field: "Field".to_string(),
        left: "A".to_string(),
        right: "B".to_string(),
        style: header,
    });

    let id_left = rec1.id.to_string();
    let id_right = rec2.id.to_string();
    rows.push(build_merge_row(
        "id",
        Some(&id_left),
        Some(&id_right),
        green,
        yellow,
        red,
    ));
    rows.push(build_merge_row(
        "full_name",
        Some(rec1.full_name.as_str()),
        Some(rec2.full_name.as_str()),
        green,
        yellow,
        red,
    ));

    for key in keys {
        let left = rec1.details.get(&key).map(|v| v.as_str());
        let right = rec2.details.get(&key).map(|v| v.as_str());
        rows.push(build_merge_row(&key, left, right, green, yellow, red));
    }

    rows
}

fn build_merge_row(
    label: &str,
    left: Option<&str>,
    right: Option<&str>,
    green: Style,
    yellow: Style,
    red: Style,
) -> MergeRow {
    let (left_text, right_text, style) = match (left, right) {
        (Some(l), Some(r)) if l == r => (l.to_string(), r.to_string(), green),
        (Some(l), Some(r)) => (l.to_string(), r.to_string(), yellow),
        (Some(l), None) => (l.to_string(), "-".to_string(), red),
        (None, Some(r)) => ("-".to_string(), r.to_string(), red),
        (None, None) => ("-".to_string(), "-".to_string(), red),
    };

    MergeRow {
        field: label.to_string(),
        left: left_text,
        right: right_text,
        style,
    }
}

fn build_merge_lines(
    rows: &[MergeRow],
    field_width: usize,
    left_width: usize,
    right_width: usize,
) -> (Vec<Line<'_>>, Vec<Line<'_>>, Vec<Line<'_>>) {
    let mut field_lines = Vec::new();
    let mut left_lines = Vec::new();
    let mut right_lines = Vec::new();

    for row in rows {
        let field_wrapped = wrap_text_to_width(&row.field, field_width);
        let left_wrapped = wrap_text_to_width(&row.left, left_width);
        let right_wrapped = wrap_text_to_width(&row.right, right_width);
        let max_len = field_wrapped
            .len()
            .max(left_wrapped.len())
            .max(right_wrapped.len());

        for idx in 0..max_len {
            field_lines.push(Line::from(Span::raw(
                field_wrapped.get(idx).cloned().unwrap_or_default(),
            )));
            left_lines.push(Line::from(Span::styled(
                left_wrapped.get(idx).cloned().unwrap_or_default(),
                row.style,
            )));
            right_lines.push(Line::from(Span::styled(
                right_wrapped.get(idx).cloned().unwrap_or_default(),
                row.style,
            )));
        }
    }

    (field_lines, left_lines, right_lines)
}

fn wrap_text_to_width(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }

    let mut lines = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current = String::new();
        for word in raw_line.split_whitespace() {
            let word_len = word.chars().count();
            if current.is_empty() {
                if word_len > width {
                    for chunk in split_long_word(word, width) {
                        lines.push(chunk);
                    }
                } else {
                    current.push_str(word);
                }
                continue;
            }

            let candidate_len = current.chars().count() + 1 + word_len;
            if candidate_len <= width {
                current.push(' ');
                current.push_str(word);
            } else {
                lines.push(current);
                current = String::new();
                if word_len > width {
                    for chunk in split_long_word(word, width) {
                        lines.push(chunk);
                    }
                } else {
                    current.push_str(word);
                }
            }
        }

        if !current.is_empty() {
            lines.push(current);
        }
    }

    if lines.is_empty() {
        lines.push(String::new());
    }

    lines
}

fn split_long_word(word: &str, width: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in word.chars() {
        if current.chars().count() >= width {
            chunks.push(current);
            current = String::new();
        }
        current.push(ch);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

async fn run_import_loop(
    title: &str,
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    tabs_data: &HashMap<Tab, Vec<DataRow>>,
) -> Result<Option<Vec<DataRow>>, AppError> {
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
    let mut current_tab = Tab::New;
    let mut line_num = 0;
    terminal
        .draw(|frame| draw_ui(title, frame, tabs_data, &current_tab, line_num))
        .c(h!())?;
    loop {
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let ev = event::read().c(h!())?;
        if matches_quit(&ev) {
            return Ok(None);
        }
        if matches_confirm(&ev) {
            break;
        }
        let mut redraw = false;
        let tab_len = tabs_data
            .get(&current_tab)
            .map(|rows| rows.len())
            .unwrap_or(0);
        let (first_visible, last_visible) = visible_range(tab_len, line_num);
        if let Some(new_action) = matches_action(&ev) {
            redraw = true;
            match new_action {
                Action::ScrollUp => {
                    if line_num == 0 {
                        redraw = false;
                    } else {
                        line_num -= 1;
                    }
                }
                Action::ScrollDown => {
                    if tab_len == 0 || line_num >= tab_len - 1 {
                        redraw = false;
                    } else {
                        line_num += 1;
                    }
                }
                Action::ScrollLeft => {
                    current_tab = Tab::next_tab(current_tab, false);
                    line_num = 0;
                }
                Action::ScrollRight => {
                    current_tab = Tab::next_tab(current_tab, true);
                    line_num = 0;
                }
                Action::PageUp => {
                    if tab_len == 0 || first_visible == 0 {
                        redraw = false;
                    } else {
                        line_num = first_visible.saturating_sub(
                            NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE,
                        );
                    }
                }
                Action::PageDown => {
                    if tab_len == 0 || last_visible >= tab_len - 1 {
                        redraw = false;
                    } else {
                        line_num = last_visible + 1;
                    }
                }
            }
        }
        if redraw {
            terminal
                .draw(|frame| {
                    draw_ui(title, frame, tabs_data, &current_tab, line_num)
                })
                .c(h!())?;
        }
    }
    Ok(Some(tabs_data.get(&Tab::New).cloned().unwrap_or_default()))
}

async fn import_network_data(
    data: Vec<DataRow>,
    network: NetworkData,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    if data.is_empty() {
        warn!("nothing to import!");
        return Ok(());
    }
    let import_confirmed = Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!(
            "Are you sure you want to import {} networks?",
            data.len()
        ))
        .default(true)
        .interact()
        .context(h!())?;
    if !import_confirmed {
        info!("Import aborted.");
        return Ok(());
    }
    let txn = db.begin().await.c(h!())?;
    let new_logins_created =
        ensure_import_network_logins(&txn, &data, &network.models).await?;
    if new_logins_created > 0 {
        info!("Created {} missing login(s).", new_logins_created);
    }
    for row in data {
        let rec = network.models.get(&row.recording.id).cloned().c(h!())?;
        let unit_id = network
            .model_to_unit_id
            .get(&row.recording.id)
            .cloned()
            .c(h!())?;
        let mut rec = rec.into_active_model();
        rec.id = NotSet;
        rec.created_at = NotSet;
        let new_network = rec.insert(&txn).await.c(h!())?;
        sigint_network_unit::ActiveModel {
            id: NotSet,
            network_id: Set(new_network.id),
            unit_id: Set(unit_id),
            created_at: NotSet,
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    info!("Import completed.");
    Ok(())
}

async fn ensure_import_network_logins<'a, 'async_trait, C>(
    txn: &C,
    data: &[DataRow],
    network_models: &HashMap<i64, sigint_network::Model>,
) -> anyhow::Result<usize>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut required_logins = HashSet::new();
    for row in data {
        let Some(rec) = network_models.get(&row.recording.id) else {
            continue;
        };
        if let Some(login) = rec.updated_by_login_id.as_ref() {
            required_logins.insert(login.to_string());
        }
    }
    if required_logins.is_empty() {
        return Ok(0);
    }

    let existing_logins = login::Entity::find()
        .filter(login::Column::Login.is_in(required_logins.clone()))
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .map(|login| login.login)
        .collect::<HashSet<_>>();

    let missing_logins = required_logins
        .difference(&existing_logins)
        .cloned()
        .collect::<Vec<_>>();
    if missing_logins.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().naive_utc();
    let to_insert = missing_logins
        .into_iter()
        .map(|login| login::ActiveModel {
            id: Set(uuid::Uuid::now_v7()),
            login: Set(login),
            password: Set(None),
            roles: Set(json!([])),
            created_at: Set(now),
            sigint_zone_id: Set(None),
            organism_id: Set(None),
            deleted: Set(true),
            delta_login_id: Set(None),
            last_active_at: Set(None),
            deactivation_reason: Set(None),
            deleted_permanently: Set(false),
            last_release_seen: NotSet,
            description: NotSet,
        })
        .collect::<Vec<_>>();

    let count = to_insert.len();
    login::Entity::insert_many(to_insert)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(count)
}

async fn import_data(
    data: Vec<DataRow>,
    units: UnitData,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    if data.is_empty() {
        warn!("nothing to import!");
        return Ok(());
    }
    let import_confirmed = Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!(
            "Are you sure you want to import {} units?",
            data.len()
        ))
        .default(true)
        .interact()
        .context(h!())?;
    if !import_confirmed {
        info!("Import aborted.");
        return Ok(());
    }
    let txn = db.begin().await.c(h!())?;
    for row in data {
        let rec = units.models.get(&row.recording.id).cloned().c(h!())?;
        let mut rec = rec.into_active_model();
        rec.id = NotSet;
        rec.created_at = NotSet;
        rec.insert(&txn).await.c(h!())?;
    }
    txn.commit().await.c(h!())?;
    info!("Import completed.");
    Ok(())
}

fn draw_ui(
    title: &str,
    frame: &mut Frame,
    data: &HashMap<Tab, Vec<DataRow>>,
    tab: &Tab,
    line_num: usize,
) {
    let tab_meta = data
        .iter()
        .map(|(k, v)| (*k, v.len()))
        .collect::<HashMap<_, _>>();
    let data = data.get(tab).cloned().unwrap_or(vec![]);
    let displayed_data = if data.is_empty() {
        vec![]
    } else {
        let (since_idx, till_idx) = visible_range(data.len(), line_num);
        data[since_idx..=till_idx].to_vec()
    };
    draw_rows(title, frame, displayed_data, tab_meta, tab);
}

fn visible_range(data_len: usize, line_num: usize) -> (usize, usize) {
    if data_len == 0 {
        return (0, 0);
    }
    let max_idx = data_len - 1;
    let since_idx = line_num.min(max_idx);
    let till_idx =
        if max_idx < since_idx + NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE {
            max_idx
        } else {
            since_idx + NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE
        };
    (since_idx, till_idx)
}

fn draw_rows(
    title: &str,
    frame: &mut Frame,
    rows: Vec<DataRow>,
    tab_meta: HashMap<Tab, usize>,
    current_tab: &Tab,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Min(1),
        ])
        .split(frame.size());

    let header = Paragraph::new(Line::from(format!(
        "{title}: Review mode. Press ENTER to confirm or ESCAPE to quit"
    )));
    frame.render_widget(header, root[0]);

    let green = Style::default().fg(Color::Green);
    let tab_labels = [
        format!("new ({})", tab_meta.get(&Tab::New).copied().unwrap_or(0),),
        format!(
            "matched ({})",
            tab_meta.get(&Tab::Matched).copied().unwrap_or(0),
        ),
        format!(
            "ignore ({})",
            tab_meta.get(&Tab::Ignore).copied().unwrap_or(0),
        ),
    ];
    let tab_order = [Tab::New, Tab::Matched, Tab::Ignore];
    let mut tab_spans = Vec::new();
    for (idx, label) in tab_labels.iter().enumerate() {
        if idx > 0 {
            tab_spans.push(Span::raw("  "));
        }
        tab_spans.push(Span::styled(label.clone(), green));
    }
    let mut underline = String::new();
    for (idx, label) in tab_labels.iter().enumerate() {
        if idx > 0 {
            underline.push_str("  ");
        }
        let ch = if current_tab == &tab_order[idx] {
            '_'
        } else {
            '-'
        };
        underline.push_str(
            &std::iter::repeat_n(ch, label.len()).collect::<String>(),
        );
    }
    let tabs_lines = vec![
        Line::from(tab_spans),
        Line::from(Span::styled(underline, green)),
    ];
    frame.render_widget(
        Paragraph::new(tabs_lines).wrap(Wrap { trim: false }),
        root[1],
    );

    let (imported_lines, matched_lines, other_lines) = build_row_lines(&rows);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(33),
            Constraint::Percentage(33),
            Constraint::Percentage(34),
        ])
        .split(root[2]);

    render_column(frame, cols[0], "Imported data", imported_lines);
    render_column(frame, cols[1], "Matched row", matched_lines);
    render_column(frame, cols[2], "Other matches", other_lines);
}

enum ColumnLine {
    Text(String),
    Separator,
}

fn build_row_lines(
    rows: &[DataRow],
) -> (Vec<ColumnLine>, Vec<ColumnLine>, Vec<ColumnLine>) {
    let mut imported_lines = Vec::new();
    let mut matched_lines = Vec::new();
    let mut other_lines = Vec::new();

    for (idx, row) in rows.iter().enumerate() {
        let imported = row.recording.render();
        let matched =
            row.target.as_ref().map(DataRec::render).unwrap_or_default();
        let other = row
            .target_candidates
            .iter()
            .map(DataRec::render)
            .collect::<Vec<_>>();

        let other_count = other.len().max(1);
        imported_lines.push(ColumnLine::Text(imported));
        matched_lines.push(ColumnLine::Text(matched));

        if other.is_empty() {
            other_lines.push(ColumnLine::Text(String::new()));
        } else {
            for line in other {
                other_lines.push(ColumnLine::Text(line));
            }
        }

        for _ in 1..other_count {
            imported_lines.push(ColumnLine::Text(String::new()));
            matched_lines.push(ColumnLine::Text(String::new()));
        }

        if idx + 1 < rows.len() {
            imported_lines.push(ColumnLine::Separator);
            matched_lines.push(ColumnLine::Separator);
            other_lines.push(ColumnLine::Separator);
        }
    }

    (imported_lines, matched_lines, other_lines)
}

fn render_column(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    lines: Vec<ColumnLine>,
) {
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let separator_width = inner.width as usize;
    let separator = if separator_width == 0 {
        String::new()
    } else {
        "-".repeat(separator_width)
    };
    let rendered_lines = lines
        .into_iter()
        .map(|line| match line {
            ColumnLine::Text(value) => Line::from(value),
            ColumnLine::Separator => Line::from(Span::raw(separator.clone())),
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        Paragraph::new(rendered_lines).wrap(Wrap { trim: false }),
        inner,
    );
}

async fn load_network_data(
    db: &DatabaseConnection,
    mut unit_data: UnitData,
    all_imported_network_units: Vec<sigint_network_unit::Model>,
    imported_networks: Vec<sigint_network::Model>,
    include_inactive_networks: bool,
) -> anyhow::Result<NetworkData> {
    let mut perfect_matches = vec![];
    let models = imported_networks
        .clone()
        .into_iter()
        .map(|x| (x.id, x))
        .collect();
    let mut data = HashMap::new();
    let mut model_to_unit_id = HashMap::new();

    let mut local_networks = sigint_network::Entity::find()
        .find_with_related(sigint_network_unit::Entity);
    if !include_inactive_networks {
        local_networks =
            local_networks.filter(sigint_network::Column::Deleted.eq(false));
    }
    let local_networks = local_networks.all(db).await.c(h!())?;

    let mut local_unit_networks = HashMap::new();
    for (local_network, local_network_units) in local_networks {
        for local_network_unit in local_network_units {
            local_unit_networks
                .entry(local_network_unit.unit_id)
                .or_insert_with(Vec::new)
                .push(local_network.clone());
        }
    }

    let mut local_unit_dictionary = HashMap::new();
    let mut imported_unit_id_to_local_unit_id_map = HashMap::new();
    let mut imported_unit_id_to_ignored_local_unit_ids_map = HashMap::new();
    for unit in unit_data.data.remove(&Tab::Matched).unwrap_or_default() {
        let source_unit_id = unit.recording.id;
        for ignored_local_unit in unit.target_candidates {
            imported_unit_id_to_ignored_local_unit_ids_map
                .entry(source_unit_id)
                .or_insert_with(Vec::new)
                .push(ignored_local_unit);
        }
        let Some(target) = unit.target else {
            continue;
        };
        let target_unit_id = target.id;
        local_unit_dictionary.insert(target_unit_id, target);
        imported_unit_id_to_local_unit_id_map
            .insert(source_unit_id, target_unit_id);
    }
    for unit in unit_data.data.remove(&Tab::Ignore).unwrap_or_default() {
        let source_unit_id = unit.recording.id;
        for ignored_local_unit in unit.target_candidates {
            imported_unit_id_to_ignored_local_unit_ids_map
                .entry(source_unit_id)
                .or_insert_with(Vec::new)
                .push(ignored_local_unit);
        }
    }

    for imported_network in imported_networks {
        if imported_network.deleted && !include_inactive_networks {
            continue;
        }
        let mut network_row = DataRow {
            recording: from_network(imported_network.clone(), None),
            target: None,
            target_candidates: vec![],
        };

        let imported_network_units = all_imported_network_units
            .iter()
            .filter(|u| u.network_id.eq(&imported_network.id))
            .collect_vec();
        if imported_network_units.len() > 1 {
            let units = imported_network_units
                .iter()
                .map(|u| {
                    unit_data
                        .models
                        .get(&u.unit_id)
                        .map(|u| u.name.clone())
                        .unwrap_or("НВ".to_string())
                })
                .join(", ");
            network_row.recording.full_name = format!(
                "!! {} MAPPED TO MULTIPLE UNITS: {units}",
                network_row.recording.full_name
            );
            data.entry(Tab::Ignore)
                .or_insert_with(Vec::new)
                .push(network_row);
            continue;
        }
        let imported_unit_id =
            imported_network_units.into_iter().next().map(|x| x.unit_id);
        let ignored_local_units = imported_unit_id
            .and_then(|id| {
                imported_unit_id_to_ignored_local_unit_ids_map
                    .get(&id)
                    .cloned()
            })
            .unwrap_or_default();
        let ignored_matches = collect_matching_unit_networks(
            &local_unit_networks,
            ignored_local_units,
        );
        network_row.target_candidates = ignored_matches;
        let imported_unit = imported_unit_id
            .and_then(|unit_id| unit_data.models.get(&unit_id))
            .and_then(|u| {
                render_unit(u).ok().map(|u2| from_unit(u.clone(), u2))
            });
        network_row.recording =
            from_network(imported_network.clone(), imported_unit);
        let local_unit = imported_unit_id
            .and_then(|unit_id| {
                imported_unit_id_to_local_unit_id_map.get(&unit_id).cloned()
            })
            .and_then(|id| local_unit_dictionary.get(&id).cloned());
        let Some(local_unit) = local_unit else {
            data.entry(Tab::Ignore)
                .or_insert_with(Vec::new)
                .push(network_row);
            continue;
        };
        model_to_unit_id.insert(network_row.recording.id, local_unit.id);
        let matches = collect_matching_unit_networks(
            &local_unit_networks,
            vec![local_unit],
        );
        let tab = if matches.len() == 1 {
            network_row.target = matches.into_iter().next();
            Tab::Matched
        } else if matches.is_empty() {
            network_row.target = None;
            Tab::New
        } else {
            network_row.target = None;
            perfect_matches
                .push(matches.clone().into_iter().map(|x| x.id).collect());
            for m in matches {
                network_row.target_candidates.push(m);
            }
            Tab::Ignore
        };
        data.entry(tab).or_insert_with(Vec::new).push(network_row);
    }
    Ok(NetworkData {
        data,
        models,
        model_to_unit_id,
        perfect_matches,
    })
}

fn collect_matching_unit_networks(
    local_unit_networks: &HashMap<i64, Vec<sigint_network::Model>>,
    local_units: Vec<DataRec>,
) -> Vec<DataRec> {
    let mut matches = vec![];
    let units_dictionary = local_units
        .into_iter()
        .map(|x| (x.id, x))
        .collect::<HashMap<_, _>>();
    for (unit_id, local_unit_networks) in local_unit_networks {
        let Some(unit) = units_dictionary.get(unit_id).cloned() else {
            continue;
        };
        local_unit_networks
            .iter()
            .map(|network| from_network(network.clone(), Some(unit.clone())))
            .for_each(|m| matches.push(m));
    }
    matches
}

async fn load_unit_data(
    db: &DatabaseConnection,
    units: Vec<sigint_unit::Model>,
    exact_match: bool,
) -> anyhow::Result<UnitData> {
    let mut global_perfect_matches = vec![];
    let mut data = HashMap::<Tab, Vec<DataRow>>::new();
    let local_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|u| render_unit(&u).ok().map(|u1| (u, u1)))
        .collect::<Vec<_>>();
    let mut models = HashMap::new();
    for unit in units {
        if unit.deleted {
            continue;
        }
        let dto = render_unit(&unit).c(h!())?;
        let unit_name =
            crate::sigint::unit::unit_name(&dto).trim().to_lowercase();
        if unit_name.is_empty() {
            continue;
        }
        let mut perfect_matches = vec![];
        let mut matches = vec![];
        let mut fuzzy_matches = vec![];
        for l in &local_units {
            let (_, lu) = l;
            let n2 = crate::sigint::unit::unit_name(lu).trim().to_lowercase();
            if n2.is_empty() {
                continue;
            }
            if names_match(&dto, lu) {
                let lu_name =
                    crate::sigint::unit::unit_name(lu).trim().to_lowercase();
                if lu_name.eq(&unit_name) {
                    perfect_matches.push(l.clone());
                } else {
                    matches.push(l.clone());
                }
            } else {
                let n1 = unit_name.trim().to_lowercase();
                if n1.contains(&n2) || n2.contains(&n1) {
                    fuzzy_matches.push(l.clone());
                }
            }
        }
        if !perfect_matches.is_empty() {
            global_perfect_matches.push(
                perfect_matches
                    .clone()
                    .into_iter()
                    .map(|(x, _)| x.id)
                    .collect(),
            );
            for m in matches {
                fuzzy_matches.push(m);
            }
            matches = perfect_matches;
        }
        let fuzzy_target = if matches.len() > 1 {
            matches
                .iter()
                .reduce(|a, b| if a.0.id < b.0.id { a } else { b })
                .cloned()
                .map(|(m, u)| from_unit(m, u))
        } else {
            None
        };
        models.insert(unit.id, unit.clone());
        let mut unit_row = DataRow {
            recording: from_unit(unit, dto),
            target: None,
            target_candidates: vec![],
        };
        let matches = matches
            .into_iter()
            .map(|(u1, u2)| from_unit(u1, u2))
            .collect_vec();
        let fuzzy_matches = fuzzy_matches
            .into_iter()
            .map(|(u1, u2)| from_unit(u1, u2))
            .collect_vec();
        let tab = if matches.len() == 1 {
            unit_row.target = matches.into_iter().next();
            unit_row.target_candidates = fuzzy_matches;
            Tab::Matched
        } else if !exact_match && fuzzy_target.is_some() {
            let fuzzy_target = fuzzy_target.c(h!())?;
            unit_row.target_candidates = matches
                .into_iter()
                .filter(|r| r.id != fuzzy_target.id)
                .collect();
            unit_row.target = Some(fuzzy_target);
            Tab::Matched
        } else if matches.is_empty() {
            unit_row.target = None;
            unit_row.target_candidates = fuzzy_matches;
            Tab::New
        } else {
            unit_row.target = None;
            unit_row.target_candidates = [matches, fuzzy_matches].concat();
            Tab::Ignore
        };
        data.entry(tab).or_default().push(unit_row);
    }
    Ok(UnitData {
        data,
        models,
        perfect_matches: global_perfect_matches,
    })
}

fn names_match(u1: &Unit, u2: &Unit) -> bool {
    fn check_name_segments_match(
        s1: &str,
        s2: &str,
        is_non_strict_match: bool,
    ) -> (bool, bool) {
        let s1 = s1.trim().to_lowercase();
        let s2 = s2.trim().to_lowercase();
        if is_non_strict_match {
            return (
                s1.is_empty() || s2.is_empty() || s1.eq(&s2),
                is_non_strict_match,
            );
        }
        if s1.is_empty() {
            (s2.is_empty(), true)
        } else {
            (s1.eq(&s2), false)
        }
    }
    let mut is_non_strict_match = false;

    let (matches, is_empty) = check_name_segments_match(
        &u1.company,
        &u2.company,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, is_empty) = check_name_segments_match(
        &u1.battalion,
        &u2.battalion,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, is_empty) = check_name_segments_match(
        &u1.regiment,
        &u2.regiment,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, is_empty) = check_name_segments_match(
        &u1.division,
        &u2.division,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, _is_empty) =
        check_name_segments_match(&u1.army, &u2.army, is_non_strict_match);
    matches
}

fn from_unit(model: sigint_unit::Model, unit: Unit) -> DataRec {
    let mut full_name = crate::sigint::unit::unit_name(&unit);
    let comment = model.comment.trim();
    if !comment.is_empty() {
        full_name = format!("{full_name} ({comment})");
    }
    DataRec {
        id: unit.id,
        full_name,
    }
}

async fn merge_all(
    db: &DatabaseConnection,
    records_to_merge: Vec<Vec<i64>>,
    details: HashMap<i64, DataRecDetailed>,
    kind: DataKind,
) -> Result<(), AppError> {
    let title = match kind {
        DataKind::Units => "UNITS",
        DataKind::Networks => "NETWORKS",
        DataKind::NetworkFeqs => "FREQS",
    };
    let records_to_merge = cleanup_ids(records_to_merge);
    let total_count = records_to_merge.len();
    let mut total_counter = 0;
    for mut ids in records_to_merge {
        let mut id_1 = ids.remove(0);
        let count = ids.len();
        let mut counter = 0;
        for mut id_2 in ids {
            let mut terminal = setup_terminal().c(h!())?;
            counter += 1;
            total_counter += 1;
            let rec_1 = details.get(&id_1).cloned().c(h!())?;
            let rec_2 = details.get(&id_2).cloned().c(h!())?;
            let Ok(should_merge) = run_merge_once(
                title,
                &mut terminal,
                rec_1,
                rec_2,
                id_1,
                count,
                counter,
                total_count,
                total_counter,
            )
            .await
            else {
                restore_terminal(&mut terminal).c(h!())?;
                return Ok(());
            };
            if should_merge != MergeKind::Skip {
                (id_1, id_2) = if should_merge == MergeKind::MergeAToB {
                    (id_2, id_1)
                } else {
                    (id_1, id_2)
                };
                match kind {
                    DataKind::Units => {
                        crate::sigint::unit::merge_units(
                            crate::users::system_login_id(db).await?,
                            db,
                            id_2,
                            id_1,
                        )
                        .await
                        .c(h!())?;
                    }
                    DataKind::Networks => {
                        let txn = db.begin().await.c(h!())?;
                        crate::sigint::network::merge::merge_two_networks(
                            &txn,
                            &crate::users::system_login_id(db).await?,
                            false,
                            true,
                            id_2,
                            id_1,
                        )
                        .await
                        .c(h!())?;
                        txn.commit().await.c(h!())?;
                    }
                    DataKind::NetworkFeqs => {
                        let txn = db.begin().await.c(h!())?;
                        crate::sigint::network::merge::merge_two_network_freqs(
                            &txn, "system", id_2, id_1,
                        )
                        .await
                        .c(h!())?;
                        txn.commit().await.c(h!())?;
                    }
                };
            }
            restore_terminal(&mut terminal).c(h!())?;
        }
    }
    Ok(())
}

fn cleanup_ids(records_to_merge: Vec<Vec<i64>>) -> Vec<Vec<i64>> {
    let groups = records_to_merge
        .into_iter()
        .filter(|x| x.len() > 1)
        .sorted_by_key(|a| -(a.len() as i32))
        .collect_vec();
    let mut values = HashSet::new();
    let mut result = vec![];
    for arr in groups {
        let mut add = true;
        for x in &arr {
            if values.contains(x) {
                add = false;
            }
            values.insert(*x);
        }
        if add {
            result.push(arr);
        }
    }
    result
}

fn add_network_model(
    models: &HashMap<i64, sigint_network::Model>,
    sigint_network_units: &HashMap<i64, i64>,
    network_row: DataRow,
) -> Option<DataRecDetailed> {
    let network_recording = network_row.recording;
    let model = models.get(&network_recording.id)?;
    let mut details = HashMap::new();
    let unit_id = sigint_network_units
        .get(&network_recording.id)
        .map(|id| format!("{id}"))
        .unwrap_or("-".to_string());
    details.insert("unit_id".to_string(), unit_id);
    details.insert("deleted".to_string(), format!("{}", model.deleted));
    details.insert("location".to_string(), model.location.to_string());
    details.insert(
        "purpose".to_string(),
        model.purpose.clone().unwrap_or("-".to_string()).to_string(),
    );
    details.insert(
        "radio_station".to_string(),
        model
            .radio_station
            .clone()
            .unwrap_or("-".to_string())
            .to_string(),
    );
    details.insert(
        "operation_mode".to_string(),
        model
            .operation_mode
            .clone()
            .unwrap_or("-".to_string())
            .to_string(),
    );
    details.insert(
        "operation_type".to_string(),
        model
            .operation_type
            .clone()
            .unwrap_or("-".to_string())
            .to_string(),
    );
    details.insert(
        "operation_period".to_string(),
        model
            .operation_period
            .clone()
            .unwrap_or("-".to_string())
            .to_string(),
    );
    details.insert(
        "merged_to".to_string(),
        model
            .merged_to
            .map(|n| format!("{n}"))
            .unwrap_or("-".to_string())
            .to_string(),
    );
    details.insert(
        "active_from".to_string(),
        model
            .active_from
            .map(|n| format!("{n}"))
            .unwrap_or("-".to_string())
            .to_string(),
    );
    details.insert(
        "active_to".to_string(),
        model
            .active_to
            .map(|n| format!("{n}"))
            .unwrap_or("-".to_string())
            .to_string(),
    );

    Some(DataRecDetailed {
        id: network_recording.id,
        full_name: network_recording.full_name,
        details,
    })
}

fn unit_details(unit: Unit, deleted: bool) -> DataRecDetailed {
    let full_name = unit_name(&unit);
    let mut details = HashMap::new();
    details.insert("company".to_string(), unit.company);
    details.insert("battalion".to_string(), unit.battalion);
    details.insert("regiment".to_string(), unit.regiment);
    details.insert("division".to_string(), unit.division);
    details.insert("army".to_string(), unit.army);
    details.insert("comment".to_string(), unit.comment);
    details.insert("deleted".to_string(), format!("{deleted}"));
    DataRecDetailed {
        id: unit.id,
        full_name,
        details,
    }
}

fn from_network(
    network: sigint_network::Model,
    unit: Option<DataRec>,
) -> DataRec {
    let unit_name = unit.map(|unit| unit.full_name).unwrap_or("нв".to_string());
    let network_name = network.name.trim();
    let full_name = format!("{network_name} {unit_name}");
    DataRec {
        id: network.id,
        full_name,
    }
}

fn matches_action(event: &Event) -> Option<Action> {
    if matches_keycode(event, KeyCode::Up) {
        Some(Action::ScrollUp)
    } else if matches_keycode(event, KeyCode::Down) {
        Some(Action::ScrollDown)
    } else if matches_keycode(event, KeyCode::Left) {
        Some(Action::ScrollLeft)
    } else if matches_keycode(event, KeyCode::Right) {
        Some(Action::ScrollRight)
    } else if matches_keycode(event, KeyCode::PageUp) {
        Some(Action::PageUp)
    } else if matches_keycode(event, KeyCode::PageDown) {
        Some(Action::PageDown)
    } else {
        None
    }
}

fn matches_quit(event: &Event) -> bool {
    matches_keycode(event, KeyCode::Esc)
}

fn matches_key(event: &Event, c: char) -> bool {
    matches_keycode(event, KeyCode::Char(c))
}

fn matches_confirm(event: &Event) -> bool {
    matches_keycode(event, KeyCode::Enter)
}

fn matches_keycode(event: &Event, k: KeyCode) -> bool {
    match event {
        Event::Key(e) => e.code.eq(&k),
        _ => false,
    }
}

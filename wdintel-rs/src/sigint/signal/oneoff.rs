use std::collections::HashMap;

use crate::entities::{sigint_callsign, sigint_signal, sigint_unit};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, OneoffImportSignalsCallsignsCsvPs};
use log::{info, warn};
use sea_orm::prelude::*;
use sea_orm::*;
use serde::Deserialize;

#[derive(Deserialize, Debug)]
struct SignalCsvRow {
    pub id: i64,
    pub text: String,
    pub meaning: Option<String>,
    pub unit_name: Option<String>,
    pub coordinates: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize, Debug)]
struct CallsignCsvRow {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub unit_name: String,
    pub source_id: Option<i32>,
    pub developing: bool,
    pub radio_freq: String,
    pub created_at: String,
}

pub async fn oneoff_import_signals_callsigns_csv(
    mode: Mode,
    ps: &OneoffImportSignalsCallsignsCsvPs,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;

    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(&dbx)
        .await
        .c(h!())?;

    let mut unit_mapping: HashMap<String, i64>;
    if let Some(path) = &ps.unit_mapping {
        let file = std::fs::File::open(path).c(h!())?;
        let reader = std::io::BufReader::new(file);
        unit_mapping = serde_json::from_reader(reader).c(h!())?;
    } else {
        unit_mapping = HashMap::new();
    }

    let mut suggested_mapping: HashMap<String, Option<i64>> = HashMap::new();

    let mut signals: Vec<sigint_signal::ActiveModel> = vec![];

    let mut skipped_signals: usize = 0;
    if let Some(signals_path) = &ps.signals {
        let rdr_signals = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_path(signals_path)
            .c(h!())?;
        for signal in rdr_signals.into_deserialize() {
            let SignalCsvRow {
                id,
                text,
                meaning,
                unit_name,
                coordinates,
                created_at,
            } = signal.c(h!())?;

            let unit_id: Option<i64>;
            if let Some(unit_name) = &unit_name {
                unit_id = find_matching_unit(
                    &units,
                    unit_name,
                    &mut unit_mapping,
                    &mut suggested_mapping,
                );
                if unit_id.is_none() {
                    skipped_signals += 1;
                    continue;
                }
            } else {
                unit_id = None;
            }

            let created_at = chrono::NaiveDateTime::parse_from_str(
                &created_at,
                "%Y-%m-%d %H:%M:%S",
            )
            .c(h!())?;

            let model = sigint_signal::ActiveModel {
                text: Set(text),
                meaning: Set(meaning),
                coordinates: Set(coordinates),
                unit: Set(unit_id),
                created_at: Set(created_at),
                original_id: Set(Some(id)),
                ..Default::default()
            };
            signals.push(model);
        }
    }
    let mut skipped_callsigns: usize = 0;
    let mut callsigns: Vec<sigint_callsign::ActiveModel> = vec![];
    if let Some(callsigns_path) = &ps.callsigns {
        let rdr_callsigns = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_path(callsigns_path)
            .c(h!())?;

        for callsign in rdr_callsigns.into_deserialize() {
            let CallsignCsvRow {
                id,
                callsign,
                position,
                comment,
                unit_name,
                source_id,
                developing,
                radio_freq,
                created_at,
            } = callsign.c(h!())?;

            let Some(unit_id) = find_matching_unit(
                &units,
                &unit_name,
                &mut unit_mapping,
                &mut suggested_mapping,
            ) else {
                skipped_callsigns += 1;
                continue;
            };

            let created_at = chrono::NaiveDateTime::parse_from_str(
                &created_at,
                "%Y-%m-%d %H:%M:%S",
            )
            .c(h!())?;

            let model = sigint_callsign::ActiveModel {
                callsign: Set(callsign),
                position: Set(position),
                comment: Set(comment),
                unit_id: Set(unit_id),
                source_id: Set(source_id),
                developing: Set(developing),
                radio_freq: Set(radio_freq),
                created_at: Set(created_at),
                original_id: Set(Some(id)),
                ..Default::default()
            };
            callsigns.push(model);
        }
    }

    if !suggested_mapping.is_empty() {
        warn!("unmapped unit named detected, use --unit-mapping mapping.json, example: ");
        let json = serde_json::to_string_pretty(&suggested_mapping).unwrap();
        println!("{json}")
    }

    info!(
        "importing {} sigint_signal rows, dry_run={}, skipped={}",
        signals.len(),
        ps.dry_run,
        skipped_signals
    );
    info!(
        "importing {} sigint_callsign rows, dry_run={}, skipped={}",
        callsigns.len(),
        ps.dry_run,
        skipped_callsigns
    );
    let txn = dbx.begin().await.c(h!())?;
    if !signals.is_empty() {
        sigint_signal::Entity::insert_many(signals)
            .exec_without_returning(&txn)
            .await
            .c(h!())?;
    }
    if !callsigns.is_empty() {
        sigint_callsign::Entity::insert_many(callsigns)
            .exec_without_returning(&txn)
            .await
            .c(h!())?;
    }
    if ps.dry_run {
        txn.rollback().await.c(h!())?;
    } else {
        txn.commit().await.c(h!())?;
    }

    Ok(())
}

fn find_matching_unit(
    units: &[sigint_unit::Model],
    unit_name: &str,
    unit_mapping: &mut HashMap<String, i64>,
    suggested_mapping: &mut HashMap<String, Option<i64>>,
) -> Option<i64> {
    if let Some(mapped_unit_id) = unit_mapping.get(unit_name) {
        Some(*mapped_unit_id)
    } else {
        let candidate_units: Vec<_> = units
            .iter()
            .filter(|unit| unit.name.as_str() == unit_name)
            .collect();
        match candidate_units.as_slice() {
            [] => {
                if suggested_mapping
                    .insert(unit_name.to_owned(), None)
                    .is_none()
                {
                    warn!("no matching unit for '{unit_name}'");
                }
                None
            }
            [unit] => {
                let id = unit.id;
                info!("found unit '{unit_name}': id={id}");
                unit_mapping.insert(unit_name.to_owned(), id);
                Some(id)
            }
            [head, ..] => {
                if suggested_mapping
                    .insert(unit_name.to_owned(), Some(head.id))
                    .is_none()
                {
                    warn!("multiple matching units for '{unit_name}'");
                    for candidate in &candidate_units {
                        println!("{candidate:?}");
                    }
                }
                None
            }
        }
    }
}

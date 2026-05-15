use std::collections::HashMap;

use crate::entities::{sigint_callsign, sigint_signal, sigint_unit};
use crate::error::AppError;
use crate::types::{info, warn};
use crate::types::{Mode, ShortContext};
use crate::{h, OneoffImportSignalsCallsignsCsvPs};
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
    #[serde(default)]
    pub full_name: String,
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
    let (skipped_signals, signals) = match &ps.signals {
        Some(signals_path) => parse_signals(
            signals_path,
            &units,
            &mut unit_mapping,
            &mut suggested_mapping,
        )
        .c(h!())?,
        None => (0, vec![]),
    };
    let (skipped_callsigns, callsigns) = match &ps.callsigns {
        Some(callsigns_path) => parse_callsigns(
            callsigns_path,
            &units,
            &mut unit_mapping,
            &mut suggested_mapping,
        )
        .c(h!())?,
        None => (0, vec![]),
    };

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

fn parse_signals(
    signals_path: &str,
    units: &[sigint_unit::Model],
    unit_mapping: &mut HashMap<String, i64>,
    suggested_mapping: &mut HashMap<String, Option<i64>>,
) -> Result<(usize, Vec<sigint_signal::ActiveModel>), AppError> {
    let mut skipped_signals: usize = 0;
    let mut signals: Vec<sigint_signal::ActiveModel> = Vec::new();
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
                units,
                unit_name,
                unit_mapping,
                suggested_mapping,
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
    Ok((skipped_signals, signals))
}

fn parse_callsigns(
    callsigns_path: &str,
    units: &[sigint_unit::Model],
    unit_mapping: &mut HashMap<String, i64>,
    suggested_mapping: &mut HashMap<String, Option<i64>>,
) -> Result<(usize, Vec<sigint_callsign::ActiveModel>), AppError> {
    let mut skipped_callsigns: usize = 0;
    let mut callsigns: Vec<sigint_callsign::ActiveModel> = vec![];

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
            full_name,
            unit_name,
            source_id,
            developing,
            radio_freq,
            created_at,
        } = callsign.c(h!())?;

        let Some(unit_id) = find_matching_unit(
            units,
            &unit_name,
            unit_mapping,
            suggested_mapping,
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
            full_name: Set(full_name),
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
    Ok((skipped_callsigns, callsigns))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callsigns_works() {
        let units = vec![sigint_unit::Model {
            id: 1,
            company: Default::default(),
            regiment: Default::default(),
            division: Default::default(),
            army: Default::default(),
            active: Default::default(),
            deleted: Default::default(),
            created_at: Default::default(),
            created_by: Default::default(),
            name: String::from("штурмовий загін 11 отбр 25 А"),
            comment: Default::default(),
            battalion: Default::default(),
            sigint_origin_id: Default::default(),
            original_id: Default::default(),
        }];
        let mut unit_mapping = Default::default();
        let mut suggested_mapping = Default::default();
        let (skipped_callsigns, callsigns) = parse_callsigns(
            "data/callsigns.csv",
            &units,
            &mut unit_mapping,
            &mut suggested_mapping,
        )
        .unwrap();
        assert_eq!(skipped_callsigns, 0);
        assert_eq!(callsigns.len(), 8);
        assert_eq!(callsigns[0].callsign, Set("джони".to_owned()));
        assert_eq!(callsigns[0].position, Set("стрілець шр".to_owned()));
        assert_eq!(callsigns[0].comment, Set("полонений".to_owned()));
        assert_eq!(callsigns[0].unit_id, Set(1));
        assert_eq!(unit_mapping.len(), 1);
    }

    #[test]
    fn parse_signals_works() {
        let units = vec![sigint_unit::Model {
            id: 1,
            company: Default::default(),
            regiment: Default::default(),
            division: Default::default(),
            army: Default::default(),
            active: Default::default(),
            deleted: Default::default(),
            created_at: Default::default(),
            created_by: Default::default(),
            name: String::from("пдб 83 одшбр ПДВ"),
            comment: Default::default(),
            battalion: Default::default(),
            sigint_origin_id: Default::default(),
            original_id: Default::default(),
        }];
        let mut unit_mapping = Default::default();
        let mut suggested_mapping = Default::default();
        let (skipped_signals, signals) = parse_signals(
            "data/signals.csv",
            &units,
            &mut unit_mapping,
            &mut suggested_mapping,
        )
        .unwrap();

        assert_eq!(skipped_signals, 13);
        assert_eq!(signals.len(), 2);
        assert_eq!(signals[0].text, Set("Шторм".to_owned()));
        assert_eq!(signals[0].meaning, Set(Some("робота РЕБ".to_owned())));
        assert_eq!(suggested_mapping.len(), 6);
    }
}

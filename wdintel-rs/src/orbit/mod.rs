use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::orbit::dictionary::DictionaryMaps;
use crate::orbit::persistence::{ExistingUnit, ImportState, ImportUnit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use anyhow::Context;
use chrono::Utc;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use uuid::Uuid;

mod dictionary;
mod hierarchy;
mod matching;
mod persistence;
mod snapshot;
mod tui;
mod types;

pub async fn prepare_import_snapshot(
    mode: Mode,
    source_path: PathBuf,
) -> anyhow::Result<()> {
    let location = snapshot::prepare_snapshot(mode, &source_path)
        .await
        .c(h!())?;
    println!("{location}");
    Ok(())
}

pub async fn run_import_tui(mode: Mode) -> Result<(), AppError> {
    Ok(run_selected_action(mode).await.c(h!())?)
}

async fn run_selected_action(mode: Mode) -> anyhow::Result<()> {
    match tui::prompt_start_action()? {
        Some(tui::StartAction::Import) => run_import(mode).await.c(h!()),
        Some(tui::StartAction::FindMatch) => {
            run_match_search(mode).await.c(h!())
        }
        None => Ok(()),
    }
}

async fn run_import(mode: Mode) -> anyhow::Result<()> {
    let snapshot = snapshot::load_latest_snapshot(mode).await?;
    let db = connect_database(mode).await?;
    dictionary::ensure_dictionary_entries(&db, &snapshot.dictionaries)
        .await
        .c(h!())?;
    let dictionaries = DictionaryMaps::load(&db)
        .await
        .c("failed to load ORBIT dictionaries")?;
    let units = snapshot.units;

    let sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .all(&db)
        .await
        .c("failed to load active SIGINT units for ORBIT matching")?;
    let sigint_unit_ids_by_orbit_unit =
        matching::matching_sigint_unit_ids(&units, &sigint_units);
    let sigint_unit_names_by_orbit_unit = build_sigint_unit_names_by_orbit_unit(
        &sigint_unit_ids_by_orbit_unit,
        &sigint_units,
    );
    log::info!(
        "matched {} ORBIT roots to active SIGINT units",
        sigint_unit_ids_by_orbit_unit.len()
    );
    let selected_ids = sigint_unit_ids_by_orbit_unit
        .keys()
        .copied()
        .collect::<HashSet<_>>();
    let hierarchy = hierarchy::build_import_hierarchy(&units, &selected_ids)
        .context("failed to build the selected ORBIT hierarchy")?;
    let started_at = Utc::now().naive_utc();
    let mut import_units = hierarchy
        .into_iter()
        .map(|unit| ImportUnit::from_hierarchy(unit, &dictionaries))
        .collect::<anyhow::Result<Vec<_>>>()
        .context("failed to resolve dictionaries for the ORBIT hierarchy")?;
    let mut existing = persistence::load_existing(&db)
        .await
        .c("failed to load existing ORBIT units")?;
    for unit in &mut import_units {
        unit.preserve_existing_partial_fields(existing.get(&unit.unit_id));
    }
    let unit_names = build_unit_names(&import_units, &existing);

    let completed = review_import_units(
        &db,
        &dictionaries,
        &import_units,
        &mut existing,
        &unit_names,
        &selected_ids,
        &sigint_unit_names_by_orbit_unit,
        started_at,
    )
    .await
    .context("failed while reviewing or persisting ORBIT units")?;
    if !completed {
        return Ok(());
    }
    review_stale_units(&db, started_at)
        .await
        .context("failed while reviewing stale ORBIT units")?;
    persistence::replace_sigint_unit_links(&db, &sigint_unit_ids_by_orbit_unit)
        .await
        .c("failed to replace ORBIT-to-SIGINT links")?;
    Ok(())
}

async fn run_match_search(mode: Mode) -> anyhow::Result<()> {
    let Some(search_term) = tui::prompt_sigint_unit_name()? else {
        return Ok(());
    };
    let db = connect_database(mode).await?;
    let sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .all(&db)
        .await
        .c("failed to load active SIGINT units for ORBIT search")?;
    let Some(sigint_unit) =
        find_sigint_unit_by_full_name(sigint_units, &search_term)
    else {
        println!("No active SIGINT unit has full name: {search_term}");
        return Ok(());
    };
    let snapshot = snapshot::load_latest_snapshot(mode).await?;
    let units = snapshot.units;
    let candidates = matching::closest_orbit_matches(&units, &sigint_unit);
    if candidates.is_empty() {
        println!("No ORBIT matches found for: {search_term}");
        return Ok(());
    }
    let options = candidates
        .iter()
        .map(|unit| tui::MatchOption {
            unit_id: unit.unit_id,
            operational_full_name: unit
                .operational_unit_name_full
                .clone()
                .unwrap_or_else(|| "-".to_string()),
            generative_full_name: unit
                .generative_unit_name_full
                .clone()
                .unwrap_or_else(|| "-".to_string()),
            original_name: unit
                .unit_name_original
                .clone()
                .unwrap_or_else(|| "-".to_string()),
        })
        .collect::<Vec<_>>();
    let Some(selected) = tui::select_match(&options)? else {
        return Ok(());
    };
    let selected = candidates[selected];
    dictionary::ensure_dictionary_entries(&db, &snapshot.dictionaries)
        .await
        .c(h!())?;
    import_selected_match(&db, &units, selected, sigint_unit.id).await?;
    println!(
        "Linked SIGINT unit {} to ORBIT unit {}",
        sigint_unit.id, selected.unit_id
    );
    Ok(())
}

async fn connect_database(
    mode: Mode,
) -> anyhow::Result<sea_orm::DatabaseConnection> {
    log::info!("connecting ORBIT importer to PostgreSQL in {mode:?} mode");
    new_pg_pool_from_mode(mode).await.c(format!(
        "failed to initialize the ORBIT importer database connection in {mode:?} mode"
    ))
}

fn find_sigint_unit_by_full_name(
    mut units: Vec<sigint_unit::Model>,
    search_term: &str,
) -> Option<sigint_unit::Model> {
    let search_term = normalize_full_name(search_term);
    units.sort_by_key(|unit| unit.id);
    units.into_iter().find(|unit| {
        normalize_full_name(&sigint_unit_full_name(unit)) == search_term
    })
}

fn sigint_unit_full_name(unit: &sigint_unit::Model) -> String {
    [
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.division.as_str(),
        unit.army.as_str(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn normalize_full_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn build_sigint_unit_names_by_orbit_unit(
    sigint_unit_ids_by_orbit_unit: &HashMap<Uuid, BTreeSet<i64>>,
    sigint_units: &[sigint_unit::Model],
) -> HashMap<Uuid, String> {
    let names_by_id = sigint_units
        .iter()
        .map(|unit| (unit.id, sigint_unit_full_name(unit)))
        .collect::<HashMap<_, _>>();
    sigint_unit_ids_by_orbit_unit
        .iter()
        .filter_map(|(orbit_unit_id, sigint_unit_ids)| {
            let names = sigint_unit_ids
                .iter()
                .filter_map(|sigint_unit_id| names_by_id.get(sigint_unit_id))
                .cloned()
                .collect::<Vec<_>>();
            (!names.is_empty()).then(|| (*orbit_unit_id, names.join("; ")))
        })
        .collect()
}

async fn import_selected_match(
    db: &sea_orm::DatabaseConnection,
    units: &[types::SourceUnit],
    selected: &types::SourceUnit,
    sigint_unit_id: i64,
) -> anyhow::Result<()> {
    let dictionaries = DictionaryMaps::load(db)
        .await
        .c("failed to load ORBIT dictionaries")?;
    let hierarchy = hierarchy::build_import_hierarchy(
        units,
        &HashSet::from([selected.unit_id]),
    )
    .with_context(|| {
        format!(
            "failed to build hierarchy for selected ORBIT unit {}",
            selected.unit_id
        )
    })?;
    let mut import_units = hierarchy
        .into_iter()
        .map(|unit| ImportUnit::from_hierarchy(unit, &dictionaries))
        .collect::<anyhow::Result<Vec<_>>>()
        .with_context(|| {
            format!(
                "failed to resolve dictionaries for selected ORBIT unit {}",
                selected.unit_id
            )
        })?;
    let mut existing = persistence::load_existing(db)
        .await
        .c("failed to load existing ORBIT units")?;
    for unit in &mut import_units {
        unit.preserve_existing_partial_fields(existing.get(&unit.unit_id));
    }
    let started_at = Utc::now().naive_utc();
    for unit in &import_units {
        let row = match persistence::classify(unit, existing.get(&unit.unit_id))
        {
            ImportState::New => persistence::insert_unit(db, unit, started_at)
                .await
                .c(format!("failed to insert ORBIT unit {}", unit.unit_id))?,
            ImportState::Unchanged(mut row) => {
                persistence::touch_unit(db, unit.unit_id, started_at)
                    .await
                    .c(format!(
                        "failed to touch ORBIT unit {}",
                        unit.unit_id
                    ))?;
                row.updated_at = started_at;
                row
            }
            ImportState::Changed(row) | ImportState::Deleted(row) => {
                persistence::update_unit(db, row, unit, started_at)
                    .await
                    .c(format!(
                        "failed to update ORBIT unit {}",
                        unit.unit_id
                    ))?
            }
        };
        existing.insert(unit.unit_id, row);
    }
    persistence::replace_sigint_unit_link(db, sigint_unit_id, selected.unit_id)
        .await
        .c(format!(
            "failed to link SIGINT unit {sigint_unit_id} to ORBIT unit {}",
            selected.unit_id
        ))?;
    Ok(())
}

async fn review_import_units(
    db: &sea_orm::DatabaseConnection,
    dictionaries: &DictionaryMaps,
    import_units: &[ImportUnit],
    existing: &mut HashMap<Uuid, ExistingUnit>,
    unit_names: &HashMap<Uuid, String>,
    review_unit_ids: &HashSet<Uuid>,
    sigint_unit_names_by_orbit_unit: &HashMap<Uuid, String>,
    started_at: chrono::NaiveDateTime,
) -> anyhow::Result<bool> {
    let mut rejected = HashSet::new();
    let mut reviewed = 0_usize;
    let needs_terminal = import_units.iter().any(|unit| {
        review_unit_ids.contains(&unit.unit_id)
            && requires_review(unit, existing.get(&unit.unit_id))
    });
    let mut terminal = if needs_terminal {
        Some(tui::setup_terminal()?)
    } else {
        None
    };
    let mut review = ImportReview {
        db,
        dictionaries,
        import_units,
        existing,
        unit_names,
        review_unit_ids,
        sigint_unit_names_by_orbit_unit,
        started_at,
        rejected: &mut rejected,
        reviewed: &mut reviewed,
    };
    let result = review.run(terminal.as_mut()).await;
    if let Some(terminal) = terminal.as_mut() {
        tui::restore_terminal(terminal)?;
    }
    result
}

struct ImportReview<'a> {
    db: &'a sea_orm::DatabaseConnection,
    dictionaries: &'a DictionaryMaps,
    import_units: &'a [ImportUnit],
    existing: &'a mut HashMap<Uuid, ExistingUnit>,
    unit_names: &'a HashMap<Uuid, String>,
    review_unit_ids: &'a HashSet<Uuid>,
    sigint_unit_names_by_orbit_unit: &'a HashMap<Uuid, String>,
    started_at: chrono::NaiveDateTime,
    rejected: &'a mut HashSet<Uuid>,
    reviewed: &'a mut usize,
}

impl ImportReview<'_> {
    async fn run(
        &mut self,
        mut terminal: Option<&mut tui::OrbitTerminal>,
    ) -> anyhow::Result<bool> {
        for (index, unit) in self.import_units.iter().enumerate() {
            if unit.has_rejected_parent(self.rejected) {
                self.rejected.insert(unit.unit_id);
                continue;
            }
            let state =
                persistence::classify(unit, self.existing.get(&unit.unit_id));
            match state {
                ImportState::Unchanged(mut row) => {
                    persistence::touch_unit(
                        self.db,
                        unit.unit_id,
                        self.started_at,
                    )
                    .await?;
                    row.updated_at = self.started_at;
                    self.existing.insert(unit.unit_id, row);
                }
                state => {
                    if !self.review_unit_ids.contains(&unit.unit_id) {
                        apply_import_decision(
                            self.db,
                            unit,
                            state,
                            tui::Decision::Accept,
                            self.started_at,
                            self.existing,
                            self.rejected,
                        )
                        .await?;
                        continue;
                    }
                    let decision = self.review_decision(
                        index,
                        unit,
                        &state,
                        &mut terminal,
                    )?;
                    if decision == tui::Decision::Quit {
                        return Ok(false);
                    }
                    apply_import_decision(
                        self.db,
                        unit,
                        state,
                        decision,
                        self.started_at,
                        self.existing,
                        self.rejected,
                    )
                    .await?;
                    *self.reviewed += 1;
                }
            }
        }
        Ok(true)
    }

    fn review_decision(
        &self,
        index: usize,
        unit: &ImportUnit,
        state: &ImportState,
        terminal: &mut Option<&mut tui::OrbitTerminal>,
    ) -> anyhow::Result<tui::Decision> {
        let remaining = remaining_review_count(
            &self.import_units[index..],
            self.existing,
            self.rejected,
            self.review_unit_ids,
        );
        let progress = format!(
            "Decision {}/{}",
            *self.reviewed + 1,
            *self.reviewed + remaining
        );
        let (title, action, old_row) = review_metadata(unit, state);
        let mut lines = persistence::diff_lines(
            unit,
            old_row,
            self.dictionaries,
            self.unit_names,
        );
        if matches!(state, ImportState::Deleted(_)) {
            lines.insert(0, "deleted: true -> false".to_string());
        }
        let sigint_unit_context = self
            .sigint_unit_names_by_orbit_unit
            .get(&unit.unit_id)
            .map(|name| format!("Corresponding SIGINT unit: {name}"));
        tui::review(
            terminal
                .as_deref_mut()
                .ok_or_else(|| anyhow::anyhow!("terminal is missing"))?,
            &title,
            sigint_unit_context.as_deref(),
            &lines,
            &progress,
            action,
            false,
        )
        .map_err(Into::into)
    }
}

fn review_metadata<'a>(
    unit: &ImportUnit,
    state: &'a ImportState,
) -> (String, tui::Action, Option<&'a ExistingUnit>) {
    let partial = if unit.partial {
        "partial ancestor "
    } else {
        ""
    };
    let unit_name = review_unit_name(unit);
    match state {
        ImportState::New => (
            format!("Create {partial}{unit_name}?"),
            tui::Action::Create,
            None,
        ),
        ImportState::Changed(row) => (
            format!("Update {partial}{unit_name}?"),
            tui::Action::Update,
            Some(row),
        ),
        ImportState::Deleted(row) => (
            format!("Reactivate {partial}{unit_name}?"),
            tui::Action::Reactivate,
            Some(row),
        ),
        ImportState::Unchanged(row) => {
            (unit_name, tui::Action::Update, Some(row))
        }
    }
}

fn review_unit_name(unit: &ImportUnit) -> String {
    unit.generative_unit_name_full
        .as_deref()
        .map(|name| name.split(" / ").collect::<Vec<_>>().join(" "))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| unit.display_name())
}

async fn apply_import_decision(
    db: &sea_orm::DatabaseConnection,
    unit: &ImportUnit,
    state: ImportState,
    decision: tui::Decision,
    started_at: chrono::NaiveDateTime,
    existing: &mut HashMap<Uuid, ExistingUnit>,
    rejected: &mut HashSet<Uuid>,
) -> anyhow::Result<()> {
    match (state, decision) {
        (ImportState::New, tui::Decision::Accept) => {
            let row = persistence::insert_unit(db, unit, started_at).await?;
            existing.insert(unit.unit_id, row);
        }
        (ImportState::Changed(row), tui::Decision::Accept)
        | (ImportState::Deleted(row), tui::Decision::Accept) => {
            let row =
                persistence::update_unit(db, row, unit, started_at).await?;
            existing.insert(unit.unit_id, row);
        }
        (ImportState::Changed(mut row), tui::Decision::Skip) => {
            persistence::touch_unit(db, unit.unit_id, started_at).await?;
            row.updated_at = started_at;
            existing.insert(unit.unit_id, row);
        }
        (ImportState::Deleted(mut row), tui::Decision::Skip) => {
            persistence::touch_unit(db, unit.unit_id, started_at).await?;
            row.updated_at = started_at;
            existing.insert(unit.unit_id, row);
            rejected.insert(unit.unit_id);
        }
        (ImportState::New, tui::Decision::Skip) => {
            rejected.insert(unit.unit_id);
        }
        (_, _) => {}
    }
    Ok(())
}

async fn review_stale_units(
    db: &sea_orm::DatabaseConnection,
    started_at: chrono::NaiveDateTime,
) -> anyhow::Result<()> {
    let stale = persistence::load_stale(db, started_at).await?;
    if stale.is_empty() {
        return Ok(());
    }
    let mut terminal = tui::setup_terminal()?;
    let result =
        review_stale_units_inner(db, &mut terminal, stale, started_at).await;
    tui::restore_terminal(&mut terminal)?;
    result
}

async fn review_stale_units_inner(
    db: &sea_orm::DatabaseConnection,
    terminal: &mut tui::OrbitTerminal,
    stale: Vec<ExistingUnit>,
    started_at: chrono::NaiveDateTime,
) -> anyhow::Result<()> {
    let total = stale.len();
    for (index, unit) in stale.into_iter().enumerate() {
        let name = unit
            .unit_name_short
            .clone()
            .or_else(|| unit.unit_name.clone())
            .or_else(|| unit.unit_name_original.clone())
            .unwrap_or_else(|| unit.unit_id.to_string());
        let lines = serde_json::to_string_pretty(&unit)?
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let decision = tui::review(
            terminal,
            &format!("Delete stale ORBIT unit {name}?"),
            None,
            &lines,
            &format!("Stale unit {}/{}", index + 1, total),
            tui::Action::Delete,
            true,
        )?;
        match decision {
            tui::Decision::Accept => {
                persistence::soft_delete(db, unit, started_at).await?
            }
            tui::Decision::Skip => {}
            tui::Decision::SkipAll | tui::Decision::Quit => break,
        }
    }
    Ok(())
}

fn remaining_review_count(
    units: &[ImportUnit],
    existing: &HashMap<Uuid, ExistingUnit>,
    rejected: &HashSet<Uuid>,
    review_unit_ids: &HashSet<Uuid>,
) -> usize {
    let mut rejected = rejected.clone();
    let mut count = 0;
    for unit in units {
        if unit.has_rejected_parent(&rejected) {
            rejected.insert(unit.unit_id);
        } else if review_unit_ids.contains(&unit.unit_id)
            && requires_review(unit, existing.get(&unit.unit_id))
        {
            count += 1;
        }
    }
    count
}

fn requires_review(unit: &ImportUnit, existing: Option<&ExistingUnit>) -> bool {
    !matches!(
        persistence::classify(unit, existing),
        ImportState::Unchanged(_)
    )
}

fn build_unit_names(
    import_units: &[ImportUnit],
    existing: &HashMap<Uuid, ExistingUnit>,
) -> HashMap<Uuid, String> {
    let mut names = existing
        .values()
        .map(|unit| {
            (
                unit.unit_id,
                unit.unit_name_short
                    .clone()
                    .or_else(|| unit.unit_name.clone())
                    .or_else(|| unit.unit_name_original.clone())
                    .unwrap_or_else(|| "?".to_string()),
            )
        })
        .collect::<HashMap<_, _>>();
    for unit in import_units {
        names.insert(unit.unit_id, unit.display_name());
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_count_excludes_unmatched_ancestors() {
        let parent = import_unit(None);
        let child = import_unit(Some(parent.unit_id));
        let units = vec![parent.clone(), child.clone()];

        assert_eq!(
            remaining_review_count(
                &units,
                &HashMap::new(),
                &HashSet::new(),
                &HashSet::from([child.unit_id]),
            ),
            1
        );
    }

    #[test]
    fn finds_sigint_unit_by_normalized_full_name() {
        let mut higher_id = sigint_unit();
        higher_id.id = 2;
        let mut lower_id = higher_id.clone();
        lower_id.id = 1;
        assert_eq!(
            find_sigint_unit_by_full_name(
                vec![higher_id, lower_id],
                "  1 МСБ   ТрО 4 ОМСБР 3 ЗВА ",
            )
            .map(|unit| unit.id),
            Some(1)
        );
    }

    #[test]
    fn missing_sigint_full_name_is_not_found() {
        assert!(find_sigint_unit_by_full_name(
            vec![sigint_unit()],
            "2 мсб 4 омсбр 3 ЗВА",
        )
        .is_none());
    }

    #[test]
    fn maps_sigint_full_name_to_each_matching_orbit_unit() {
        let first_orbit_unit_id = Uuid::new_v4();
        let second_orbit_unit_id = Uuid::new_v4();
        let links = HashMap::from([
            (first_orbit_unit_id, BTreeSet::from([1])),
            (second_orbit_unit_id, BTreeSet::from([1])),
        ]);

        assert_eq!(
            build_sigint_unit_names_by_orbit_unit(&links, &[sigint_unit()]),
            HashMap::from([
                (first_orbit_unit_id, "1 мсб ТрО 4 омсбр 3 ЗВА".to_string(),),
                (second_orbit_unit_id, "1 мсб ТрО 4 омсбр 3 ЗВА".to_string(),),
            ])
        );
    }

    #[test]
    fn review_name_uses_generative_path_without_splitters() {
        let mut unit = import_unit(None);
        unit.generative_unit_name_full =
            Some("габатр / 392 мсп / 19 мсд / 58 а / ЮВО".to_string());

        assert_eq!(review_unit_name(&unit), "габатр 392 мсп 19 мсд 58 а ЮВО");
    }

    fn sigint_unit() -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            company: String::new(),
            battalion: "1 мсб ТрО".to_string(),
            regiment: "4 омсбр".to_string(),
            division: String::new(),
            army: "3 ЗВА".to_string(),
            active: true,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id: Uuid::new_v4(),
            name: "1 мсб ТрО 4 омсбр 3 ЗВА".to_string(),
            comment: String::new(),
            sigint_origin_id: None,
            original_id: None,
        }
    }

    fn import_unit(operational_parent_unit_id: Option<Uuid>) -> ImportUnit {
        ImportUnit {
            unit_id: Uuid::new_v4(),
            unit_name: Some("unit".to_string()),
            unit_name_original: None,
            unit_name_short: Some("u".to_string()),
            operational_unit_name_full: Some("u".to_string()),
            generative_unit_name_full: None,
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon_id: None,
            combat_unit_type_id: None,
            grouping_of_forces_ids: None,
            generative_parent_unit_id: None,
            operational_parent_unit_id,
            partial: operational_parent_unit_id.is_none(),
        }
    }
}

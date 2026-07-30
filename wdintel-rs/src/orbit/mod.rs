use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::orbit::dictionary::DictionaryMaps;
use crate::orbit::persistence::{ExistingUnit, ImportState, ImportUnit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use chrono::Utc;
use dialoguer::{theme::ColorfulTheme, Confirm};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use std::collections::{HashMap, HashSet};
use tokio::fs;
use uuid::Uuid;

mod dictionary;
mod hierarchy;
mod matching;
mod persistence;
mod tui;
mod types;

pub async fn run_import_tui(mode: Mode) -> Result<(), AppError> {
    Ok(run_import(mode).await.c(h!())?)
}

async fn run_import(mode: Mode) -> anyhow::Result<()> {
    let Some(path) = tui::prompt_path()? else {
        return Ok(());
    };
    let input = fs::read_to_string(&path).await?;
    let (units, unknown_paths) = types::parse_units(&input)?;
    confirm_unknown_paths(&path.display().to_string(), &unknown_paths)?;
    matching::validate_source(&units)?;

    let db = new_pg_pool_from_mode(mode).await?;
    let dictionaries = DictionaryMaps::load(&db).await?;
    let missing = dictionary::missing_dictionary_values(&units, &dictionaries)?;
    if !missing.is_empty() {
        dictionary::print_dictionary_migration(
            &missing,
            Utc::now().naive_utc(),
        );
        return Ok(());
    }

    let sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .all(&db)
        .await?;
    let sigint_unit_ids_by_orbit_unit =
        matching::matching_sigint_unit_ids(&units, &sigint_units);
    let selected_ids = sigint_unit_ids_by_orbit_unit
        .keys()
        .copied()
        .collect::<HashSet<_>>();
    let hierarchy = hierarchy::build_import_hierarchy(&units, &selected_ids)?;
    let started_at = Utc::now().naive_utc();
    let mut import_units = hierarchy
        .into_iter()
        .map(|unit| ImportUnit::from_hierarchy(unit, &dictionaries))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut existing = persistence::load_existing(&db).await?;
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
        started_at,
    )
    .await?;
    if !completed {
        return Ok(());
    }
    review_stale_units(&db, started_at).await?;
    persistence::replace_sigint_unit_links(&db, &sigint_unit_ids_by_orbit_unit)
        .await?;
    Ok(())
}

fn confirm_unknown_paths(
    source_path: &str,
    unknown_paths: &[String],
) -> anyhow::Result<()> {
    if unknown_paths.is_empty() {
        return Ok(());
    }
    println!("WARNING: unknown properties in {source_path}:");
    for path in unknown_paths {
        println!("  - {path}");
    }
    let proceed = Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt("Continue while ignoring these properties?")
        .default(false)
        .interact()?;
    if !proceed {
        anyhow::bail!("ORBIT import cancelled because of unknown properties");
    }
    Ok(())
}

async fn review_import_units(
    db: &sea_orm::DatabaseConnection,
    dictionaries: &DictionaryMaps,
    import_units: &[ImportUnit],
    existing: &mut HashMap<Uuid, ExistingUnit>,
    unit_names: &HashMap<Uuid, String>,
    review_unit_ids: &HashSet<Uuid>,
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
        tui::review(
            terminal
                .as_deref_mut()
                .ok_or_else(|| anyhow::anyhow!("terminal is missing"))?,
            &title,
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
    match state {
        ImportState::New => (
            format!("Create {partial}{}?", unit.display_name()),
            tui::Action::Create,
            None,
        ),
        ImportState::Changed(row) => (
            format!("Update {partial}{}?", unit.display_name()),
            tui::Action::Update,
            Some(row),
        ),
        ImportState::Deleted(row) => (
            format!("Reactivate {partial}{}?", unit.display_name()),
            tui::Action::Reactivate,
            Some(row),
        ),
        ImportState::Unchanged(row) => {
            (unit.display_name(), tui::Action::Update, Some(row))
        }
    }
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

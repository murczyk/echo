use crate::entities::sigint_saved_filter;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use anyhow::Context;
use dialoguer::{theme::ColorfulTheme, Select};
use sea_orm::{
    ActiveModelTrait, DatabaseConnection, EntityTrait, IntoActiveModel,
    QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde_json::{Map, Value};
use similar::TextDiff;
use std::collections::BTreeSet;

const UNIT_ID_PREFIX: &str = "unit-id:";
const UNIT_FILTER_FIELDS: [(&str, &str); 4] = [
    ("selected_units", "selected_unit_ids"),
    ("denied_units", "denied_unit_ids"),
    ("units_selected", "selected_unit_ids"),
    ("units_denied", "denied_unit_ids"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConvertedValue {
    field: &'static str,
    value: String,
    unit_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq)]
struct MigrationPlan {
    before: Value,
    after: Value,
    converted: Vec<ConvertedValue>,
    preserved: Vec<(&'static str, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyOutcome {
    Applied,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewDecision {
    Apply,
    Skip,
    Quit,
}

pub async fn run(mode: Mode) -> Result<(), AppError> {
    Ok(run_inner(mode).await.c(h!())?)
}

async fn run_inner(mode: Mode) -> anyhow::Result<()> {
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    let saved_filters = sigint_saved_filter::Entity::find()
        .order_by_asc(sigint_saved_filter::Column::Id)
        .all(&dbx)
        .await
        .context(h!())?;

    let mut reviewed = 0;
    let mut applied = 0;
    let mut skipped = 0;
    let mut stale = 0;
    let mut unchanged = 0;

    for saved_filter in saved_filters {
        let Some(plan) = build_migration_plan(&saved_filter.req) else {
            continue;
        };
        print_plan(&saved_filter, &plan).context(h!())?;
        if plan.before == plan.after {
            unchanged += 1;
            println!("No automatic change is available; leaving this filter unchanged.\n");
            continue;
        }

        reviewed += 1;
        match review_decision().context(h!())? {
            ReviewDecision::Apply => {
                match apply_plan(&dbx, saved_filter.id, &plan)
                    .await
                    .context(h!())?
                {
                    ApplyOutcome::Applied => {
                        applied += 1;
                        println!("Applied.\n");
                    }
                    ApplyOutcome::Stale => {
                        stale += 1;
                        println!(
                            "Skipped because the saved filter changed during review.\n"
                        );
                    }
                }
            }
            ReviewDecision::Skip => {
                skipped += 1;
                println!("Skipped.\n");
            }
            ReviewDecision::Quit => {
                println!("Stopped; remaining filters were not reviewed.");
                break;
            }
        }
    }

    println!(
        "done! reviewed={reviewed} applied={applied} skipped={skipped} stale={stale} unchanged={unchanged}"
    );
    Ok(())
}

fn build_migration_plan(req: &Value) -> Option<MigrationPlan> {
    let before = req.clone();
    let mut after = req.clone();
    let req = after.as_object_mut()?;
    let mut converted = Vec::new();
    let mut preserved = Vec::new();
    let mut has_legacy_value = false;

    for (legacy_field, id_field) in UNIT_FILTER_FIELDS {
        migrate_field(
            req,
            legacy_field,
            id_field,
            &mut converted,
            &mut preserved,
            &mut has_legacy_value,
        );
    }

    has_legacy_value.then_some(MigrationPlan {
        before,
        after,
        converted,
        preserved,
    })
}

fn migrate_field(
    req: &mut Map<String, Value>,
    legacy_field: &'static str,
    id_field: &'static str,
    converted: &mut Vec<ConvertedValue>,
    preserved: &mut Vec<(&'static str, String)>,
    has_legacy_value: &mut bool,
) {
    let Some(values) = req.get(legacy_field).and_then(Value::as_array).cloned()
    else {
        return;
    };
    let mut retained = Vec::new();
    let mut new_unit_ids = Vec::new();

    for value in values {
        let Some(value_str) = value.as_str() else {
            retained.push(value);
            continue;
        };
        if is_undefined_unit_value(value_str) {
            retained.push(value);
            continue;
        }
        *has_legacy_value = true;
        let Some(matched_ids) =
            parse_unit_id_value(value_str).map(|unit_id| vec![unit_id])
        else {
            preserved.push((legacy_field, value_str.to_string()));
            retained.push(value);
            continue;
        };
        for unit_id in &matched_ids {
            let canonical_value =
                Value::String(format!("{UNIT_ID_PREFIX}{unit_id}"));
            if !retained.contains(&canonical_value) {
                retained.push(canonical_value);
            }
        }
        new_unit_ids.extend(matched_ids.iter().copied());
        converted.push(ConvertedValue {
            field: legacy_field,
            value: value_str.to_string(),
            unit_ids: matched_ids,
        });
    }

    if new_unit_ids.is_empty() {
        return;
    }
    req.insert(
        legacy_field.to_string(),
        if retained.is_empty() {
            Value::Null
        } else {
            Value::Array(retained)
        },
    );
    append_unit_ids(req, id_field, new_unit_ids);
}

fn append_unit_ids(
    req: &mut Map<String, Value>,
    id_field: &'static str,
    unit_ids: Vec<i64>,
) {
    let mut values = req
        .get(id_field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut existing_ids = values
        .iter()
        .filter_map(Value::as_i64)
        .collect::<BTreeSet<_>>();
    for unit_id in unit_ids {
        if existing_ids.insert(unit_id) {
            values.push(Value::from(unit_id));
        }
    }
    req.insert(id_field.to_string(), Value::Array(values));
}

fn parse_unit_id_value(value: &str) -> Option<i64> {
    let unit_id = value.strip_prefix(UNIT_ID_PREFIX)?.parse::<i64>().ok()?;
    (unit_id > 0 && format!("{UNIT_ID_PREFIX}{unit_id}") == value)
        .then_some(unit_id)
}

fn is_undefined_unit_value(value: &str) -> bool {
    value.is_empty() || value == "Не визначено"
}

fn print_plan(
    saved_filter: &sigint_saved_filter::Model,
    plan: &MigrationPlan,
) -> anyhow::Result<()> {
    println!(
        "Saved filter #{} | type={:?} | login_id={:?} | name={}",
        saved_filter.id,
        saved_filter.r#type,
        saved_filter.login_id,
        saved_filter.name
    );
    for conversion in &plan.converted {
        println!(
            "  {}: {:?} -> {:?}",
            conversion.field, conversion.value, conversion.unit_ids
        );
    }
    for (field, value) in &plan.preserved {
        println!(
            "  preserved {field}: {value:?} (legacy label matching semantics)"
        );
    }
    if plan.before != plan.after {
        let before =
            serde_json::to_string_pretty(&plan.before).context(h!())?;
        let after = serde_json::to_string_pretty(&plan.after).context(h!())?;
        print!(
            "{}",
            TextDiff::from_lines(&before, &after)
                .unified_diff()
                .header("before.json", "after.json")
        );
    }
    Ok(())
}

fn review_decision() -> anyhow::Result<ReviewDecision> {
    let choices = ["Apply", "Skip", "Quit"];
    let selected = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("Apply this saved-filter migration?")
        .items(&choices)
        .default(1)
        .interact()
        .context(h!())?;
    Ok(match selected {
        0 => ReviewDecision::Apply,
        1 => ReviewDecision::Skip,
        _ => ReviewDecision::Quit,
    })
}

async fn apply_plan(
    dbx: &DatabaseConnection,
    saved_filter_id: i64,
    plan: &MigrationPlan,
) -> anyhow::Result<ApplyOutcome> {
    let txn = dbx.begin().await.context(h!())?;
    let saved_filter = sigint_saved_filter::Entity::find_by_id(saved_filter_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .context(h!())?;
    let Some(saved_filter) = saved_filter else {
        txn.rollback().await.context(h!())?;
        return Ok(ApplyOutcome::Stale);
    };
    if saved_filter.req != plan.before {
        txn.rollback().await.context(h!())?;
        return Ok(ApplyOutcome::Stale);
    }
    let mut saved_filter = saved_filter.into_active_model();
    saved_filter.req = Set(plan.after.clone());
    saved_filter.update(&txn).await.context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(ApplyOutcome::Applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_exact_match_labels_and_migrates_tagged_ids() {
        let req = json!({
            "selected_units": ["Alpha", "unit-id:20", "58 А", "Missing", "Не визначено"],
            "selected_unit_ids": [5],
            "units_exact_match_only": true
        });

        let plan = build_migration_plan(&req).unwrap();

        assert_eq!(plan.before, req);
        assert_eq!(
            plan.after,
            json!({
                "selected_units": ["Alpha", "unit-id:20", "58 А", "Missing", "Не визначено"],
                "selected_unit_ids": [5, 20],
                "units_exact_match_only": true
            })
        );
        assert_eq!(
            plan.preserved,
            vec![
                ("selected_units", "Alpha".to_string()),
                ("selected_units", "58 А".to_string()),
                ("selected_units", "Missing".to_string())
            ]
        );
    }

    #[test]
    fn preserves_labels_when_exact_match_is_absent() {
        let req = json!({
            "units_selected": ["unit-id:10", "Bravo"],
            "units_denied": ["Alpha"]
        });

        let plan = build_migration_plan(&req).unwrap();

        assert_eq!(
            plan.after,
            json!({
                "units_selected": ["unit-id:10", "Bravo"],
                "units_denied": ["Alpha"],
                "selected_unit_ids": [10]
            })
        );
        assert_eq!(
            plan.preserved,
            vec![
                ("units_selected", "Bravo".to_string()),
                ("units_denied", "Alpha".to_string())
            ]
        );
    }

    #[test]
    fn preserves_labels_when_exact_match_is_false() {
        let req = json!({
            "selected_units": ["Alpha"],
            "units_exact_match_only": false
        });

        let plan = build_migration_plan(&req).unwrap();

        assert_eq!(plan.after, req);
        assert_eq!(
            plan.preserved,
            vec![("selected_units", "Alpha".to_string())]
        );
    }

    #[test]
    fn fully_migrated_filter_is_not_proposed_again() {
        let req = json!({
            "selected_units": null,
            "selected_unit_ids": [10]
        });

        assert!(build_migration_plan(&req).is_none());
    }
}

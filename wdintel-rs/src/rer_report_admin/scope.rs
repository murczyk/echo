use crate::config::RER_REPORT_HIERARCHY_COLUMNS;
use crate::entities::{sigint_unit, sigint_unit_rer_report_metadata};
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    sea_query::{Expr, SimpleExpr},
    AccessMode, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    IsolationLevel, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReportTarget {
    pub report_name: String,
    pub parent_name: String,
    pub parent_path: Vec<String>,
    pub locations: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScopedUnit {
    pub echelon: usize,
    pub target: ReportTarget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RerReportScope {
    pub units: BTreeMap<i64, ScopedUnit>,
}

pub fn hierarchy(unit: &sigint_unit::Model) -> Vec<String> {
    [
        &unit.army_region,
        &unit.military_district,
        &unit.army,
        &unit.corps,
        &unit.division,
        &unit.brigade,
        &unit.regiment,
        &unit.battalion,
        &unit.company,
        &unit.platoon,
        &unit.squad,
        &unit.section,
        &unit.team_or_crew,
        &unit.other,
    ]
    .into_iter()
    .map(|value| value.trim().to_string())
    .collect()
}

pub fn parent(unit: &sigint_unit::Model) -> (Vec<String>, String) {
    parent_for_path(&hierarchy(unit), &unit.name)
}

fn parent_for_path(path: &[String], name: &str) -> (Vec<String>, String) {
    let level = crate::config::RER_REPORT_PARENT_LEVELS
        .into_iter()
        .find(|&i| !path[i].is_empty())
        .or_else(|| path.iter().position(|value| !value.is_empty()));
    match level {
        Some(level) => (path[..=level].to_vec(), path[level].clone()),
        None => (Vec::new(), name.trim().to_string()),
    }
}

pub async fn validate_parent<C: ConnectionTrait>(
    db: &C,
    unit_id: i64,
    report_name: &str,
    except_id: Option<i64>,
) -> anyhow::Result<()> {
    db.execute_unprepared("select pg_advisory_xact_lock(hashtextextended('rer-report-metadata', 0))")
        .await.c(h!())?;
    let unit = sigint_unit::Entity::find_by_id(unit_id)
        .one(db)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    if unit.deleted {
        return Ok(());
    }
    let context = parent(&unit).0;
    if context.is_empty() {
        return Ok(());
    }
    let rows = sigint_unit_rer_report_metadata::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .all(db)
        .await
        .c(h!())?;
    for (row, unit) in rows {
        if Some(row.id) == except_id
            || row.report_name.as_deref().map(str::trim) != Some(report_name)
        {
            continue;
        }
        if unit.as_ref().is_some_and(|unit| {
            !unit.deleted
                && !parent(unit).0.is_empty()
                && parent(unit).0 != context
        }) {
            return Err(crate::error::AppError::BL { msg: format!("Назва для звіту «{report_name}» вже використовується підрозділом з іншою ієрархією. Оберіть іншу назву.") }.into());
        }
    }
    Ok(())
}

pub async fn capture(
    db: &DatabaseConnection,
) -> anyhow::Result<RerReportScope> {
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    let scope = load(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(scope)
}

pub async fn load<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<RerReportScope> {
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::Id)
        .select_only()
        .column(sigint_unit::Column::Id)
        .column(sigint_unit::Column::Name)
        .column_as(
            Expr::cust(format!(
                "ARRAY[{}]",
                RER_REPORT_HIERARCHY_COLUMNS
                    .iter()
                    .map(|column| format!("sigint_unit.{column}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )),
            "hierarchy",
        )
        .into_tuple::<(i64, String, Vec<String>)>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|(id, name, path)| CatalogUnit {
            id,
            name,
            path: path
                .into_iter()
                .map(|value| value.trim().to_string())
                .collect(),
        })
        .collect::<Vec<_>>();
    let configured = load_configuration(db, &units).await.c(h!())?;
    expand_units(&units, &configured).c(h!())
}

struct CatalogUnit {
    id: i64,
    name: String,
    path: Vec<String>,
}

struct ConfiguredUnit {
    unit_id: i64,
    path: Vec<String>,
    depth: Option<usize>,
    target: ReportTarget,
}

async fn load_configuration<C: ConnectionTrait>(
    db: &C,
    units: &[CatalogUnit],
) -> anyhow::Result<Vec<ConfiguredUnit>> {
    let rows = sigint_unit_rer_report_metadata::Entity::find()
        .order_by_asc(sigint_unit_rer_report_metadata::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    let mut configured = Vec::new();
    let mut parents = BTreeMap::new();
    for row in rows {
        let Some(unit) =
            units.iter().find(|unit| unit.id == row.sigint_unit_id)
        else {
            continue;
        };
        let name = row.report_name.as_deref().unwrap_or_default().trim();
        if name.is_empty() || name.contains(['\r', '\n']) {
            return Err(crate::error::AppError::BL { msg: format!("Вкажіть коректну назву для звіту для підрозділу «{}» у налаштуваннях звітів", unit.name) }.into());
        }
        let (parent_path, parent_name) =
            parent_for_path(&unit.path, &unit.name);
        if !parent_path.is_empty()
            && parents
                .insert(
                    name.to_string(),
                    (parent_path.clone(), parent_name.clone()),
                )
                .is_some_and(|previous| previous.0 != parent_path)
        {
            return Err(crate::error::AppError::BL { msg: format!("Назва для звіту «{name}» використовується підрозділами з різною ієрархією") }.into());
        }
        let path = unit.path.clone();
        let depth = path.iter().rposition(|value| !value.is_empty());
        configured.push(ConfiguredUnit {
            unit_id: unit.id,
            path,
            depth,
            target: ReportTarget {
                report_name: name.to_string(),
                parent_name,
                parent_path,
                locations: serde_json::from_value(row.locations).c(h!())?,
            },
        });
    }
    for unit in &mut configured {
        if unit.target.parent_path.is_empty() {
            let (path, name) = parents
                .get(&unit.target.report_name)
                .cloned()
                .unwrap_or_else(|| {
                    (
                        vec![format!("report:{}", unit.target.report_name)],
                        unit.target.report_name.clone(),
                    )
                });
            unit.target.parent_path = path;
            unit.target.parent_name = name;
        }
    }
    Ok(configured)
}

fn expand_units(
    units: &[CatalogUnit],
    configured: &[ConfiguredUnit],
) -> anyhow::Result<RerReportScope> {
    let mut scope = RerReportScope {
        units: BTreeMap::new(),
    };
    for unit in units {
        let path = &unit.path;
        let unit_depth = path.iter().rposition(|value| !value.is_empty());
        let mut matching = configured
            .iter()
            .filter(|candidate| {
                candidate.unit_id == unit.id
                    || candidate.depth.is_some_and(|depth| {
                        unit_depth > Some(depth)
                            && candidate.path[..=depth] == path[..=depth]
                    })
            })
            .collect::<Vec<_>>();
        matching.sort_by_key(|candidate| {
            (candidate.unit_id == unit.id, candidate.depth)
        });
        let Some(selected) = matching.last() else {
            continue;
        };
        if matching.iter().any(|other| {
            other.unit_id != selected.unit_id
                && other.depth == selected.depth
                && other.target.report_name != selected.target.report_name
        }) {
            return Err(crate::error::AppError::BL {
                msg: format!(
                    "Неоднозначні налаштування звіту для підрозділу «{}»",
                    unit.name
                ),
            }
            .into());
        }
        scope.units.insert(
            unit.id,
            ScopedUnit {
                echelon: path
                    .iter()
                    .rposition(|value| !value.is_empty())
                    .unwrap_or(RER_REPORT_HIERARCHY_COLUMNS.len()),
                target: selected.target.clone(),
            },
        );
    }
    Ok(scope)
}

fn eligible_link_sql() -> String {
    "rer_link.kind in ('parsed', 'network')".to_string()
}

pub fn membership_expr(unit_ids: impl IntoIterator<Item = i64>) -> SimpleExpr {
    let ids = unit_ids
        .into_iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Expr::cust("FALSE");
    }
    Expr::cust(format!("exists (select 1 from sigint_inbox_item_unit rer_link join sigint_unit rer_unit on rer_unit.id = rer_link.unit_id and not rer_unit.deleted where rer_link.item_id = signal_message.id and rer_link.unit_id in ({}) and {})", ids.join(","), eligible_link_sql()))
}

pub fn configured_membership_expr() -> SimpleExpr {
    let depth = format!(
        "case {} else -1 end",
        RER_REPORT_HIERARCHY_COLUMNS
            .iter()
            .enumerate()
            .rev()
            .map(|(i, column)| format!(
                "when {} <> '' then {i}",
                hierarchy_value_sql("rer_ancestor", column)
            ))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let unit_depth = depth.replace("rer_ancestor.", "rer_unit.");
    let matches = RER_REPORT_HIERARCHY_COLUMNS
        .iter()
        .enumerate()
        .map(|(i, column)| {
            format!(
                "(({depth}) < {i} or {} = {})",
                hierarchy_value_sql("rer_ancestor", column),
                hierarchy_value_sql("rer_unit", column)
            )
        })
        .collect::<Vec<_>>()
        .join(" and ");
    Expr::cust(format!("exists (select 1 from sigint_inbox_item_unit rer_link join sigint_unit rer_unit on rer_unit.id = rer_link.unit_id and not rer_unit.deleted where rer_link.item_id = signal_message.id and {} and exists (select 1 from sigint_unit_rer_report_metadata rer_metadata join sigint_unit rer_ancestor on rer_ancestor.id = rer_metadata.sigint_unit_id and not rer_ancestor.deleted where rer_ancestor.id = rer_unit.id or (({depth}) >= 0 and ({unit_depth}) > ({depth}) and {matches})))", eligible_link_sql()))
}

fn hierarchy_value_sql(alias: &str, column: &str) -> String {
    format!(
        "btrim({alias}.{column}, '{}')",
        crate::config::RER_REPORT_HIERARCHY_WHITESPACE
    )
}

pub fn filter_query<Q: QueryFilter>(query: Q, enabled: Option<bool>) -> Q {
    if enabled == Some(true) {
        query.filter(configured_membership_expr())
    } else {
        query
    }
}

pub fn eligible_unit_link_expr() -> SimpleExpr {
    Expr::cust(
        eligible_link_sql().replace("rer_link.", "sigint_inbox_item_unit."),
    )
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;

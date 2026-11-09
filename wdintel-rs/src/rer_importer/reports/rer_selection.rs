use super::rer::{ResolvedItemUnit, UnitIdentity, UnitPath};
use crate::entities::{sigint_inbox_item_unit, sigint_unit};
use crate::h;
use crate::rer_report_admin::scope::RerReportScope;
use crate::types::ShortContext;
use rand::prelude::IndexedRandom;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) async fn load_report_unit_links(
    db: &DatabaseConnection,
    item_ids: &[i64],
    scope: &RerReportScope,
) -> anyhow::Result<BTreeMap<i64, BTreeSet<i64>>> {
    let mut links = BTreeMap::<i64, BTreeSet<i64>>::new();
    for ids in item_ids.chunks(crate::config::RER_REPORT_HYDRATION_BATCH_SIZE) {
        let rows = sigint_inbox_item_unit::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_unit::Relation::SigintUnit.def(),
            )
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_inbox_item_unit::Column::ItemId.is_in(ids.to_vec()))
            .filter(crate::rer_report_admin::scope::eligible_unit_link_expr())
            .select_only()
            .column(sigint_inbox_item_unit::Column::ItemId)
            .column(sigint_inbox_item_unit::Column::UnitId)
            .into_tuple::<(i64, i64)>()
            .all(db)
            .await
            .c(h!())?;
        for (item_id, unit_id) in rows {
            if scope.units.contains_key(&unit_id) {
                links.entry(item_id).or_default().insert(unit_id);
            }
        }
    }
    Ok(links)
}

pub(super) async fn resolve_configured_item_unit(
    db: &DatabaseConnection,
    bgtask_id: Option<i64>,
    item_id: i64,
    unit_ids: Option<&BTreeSet<i64>>,
    scope: &RerReportScope,
) -> anyhow::Result<Option<ResolvedItemUnit>> {
    let candidates = unit_ids
        .into_iter()
        .flatten()
        .filter_map(|id| scope.units.get(id))
        .collect::<Vec<_>>();
    let Some(first) = candidates.first() else {
        return Ok(None);
    };
    let names = candidates
        .iter()
        .map(|unit| unit.target.report_name.as_str())
        .collect::<BTreeSet<_>>();
    let selected = if names.len() > 1 {
        let highest = candidates.iter().map(|unit| unit.echelon).min().unwrap();
        let choices = candidates
            .iter()
            .filter(|unit| unit.echelon == highest)
            .collect::<Vec<_>>();
        let selected = **choices.choose(&mut rand::rng()).unwrap();
        let message = format!("РЕР Звіт: перехоплення #{item_id} відповідає кільком назвам: {}; обрано «{}» серед підрозділів найвищого ешелону", names.into_iter().collect::<Vec<_>>().join("; "), selected.target.report_name);
        log::error!("{message}");
        crate::delta::bgtask_log(bgtask_id, &message, db)
            .await
            .c(h!())?;
        selected
    } else {
        *first
    };
    let target = &selected.target;
    let locations = candidates
        .iter()
        .filter(|unit| unit.target.report_name == target.report_name)
        .flat_map(|unit| unit.target.locations.iter())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    Ok(Some(ResolvedItemUnit {
        identity: UnitIdentity {
            path: UnitPath(vec![
                serde_json::to_string(&target.parent_path).c(h!())?,
                target.report_name.clone(),
            ]),
            parent_name: target.parent_name.clone(),
            unit_name: target.report_name.clone(),
        },
        locations,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use sea_orm::{ActiveModelTrait, Set};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn issue_3940_conflicts_select_only_highest_echelon_candidates() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let mut units = BTreeSet::new();
        for index in 0..5 {
            let unit = mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    army: Set("1 А".into()),
                    division: Set(if index < 2 {
                        format!("{index} мсд")
                    } else {
                        String::new()
                    }),
                    company: Set(if index >= 2 {
                        format!("{index} рота")
                    } else {
                        String::new()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            crate::entities::sigint_unit_rer_report_metadata::ActiveModel {
                sigint_unit_id: Set(unit.id),
                report_name: Set(Some(format!("Назва {index}"))),
                locations: Set(serde_json::json!([])),
                labels: Set(serde_json::json!([])),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            units.insert(unit.id);
        }
        let scope = crate::rer_report_admin::scope::capture(&env.dbx)
            .await
            .unwrap();
        let resolved = resolve_configured_item_unit(
            &env.dbx,
            None,
            3940,
            Some(&units),
            &scope,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(["Назва 0", "Назва 1"]
            .contains(&resolved.identity.unit_name.as_str()));
    }
}

use super::{date_range, filters, DailyMessageStatsReq};
use crate::config::{
    ANALYSIS_STATS_UNDEFINED_UNIT_ID, ANALYSIS_STATS_UNDEFINED_UNIT_NAME,
};
use crate::h;
use crate::rer_importer::types::UnitStatsOption;
use crate::sigint::unit::types::UnitHierarchyRsp;
use crate::types::ShortContext;
use sea_orm::{DatabaseConnection, DbBackend, FromQueryResult, Statement};
use std::collections::BTreeMap;

type Scope = (String, Vec<i64>);

fn scopes(
    hierarchy: &UnitHierarchyRsp,
    include_children: bool,
) -> anyhow::Result<BTreeMap<String, Scope>> {
    let mut scopes = BTreeMap::new();
    let mut direct = vec![vec![]; hierarchy.groups.len()];
    let mut children = vec![false; hierarchy.groups.len()];
    for unit in &hierarchy.units {
        scopes.insert(
            format!("unit-id:{}", unit.id),
            (unit.name.clone(), vec![unit.id]),
        );
        if let Some(index) = unit.group_index {
            direct.get_mut(index as usize).c(h!())?.push(unit);
        }
    }
    let mut descendants = direct
        .iter()
        .map(|units| units.iter().map(|unit| unit.id).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    for (index, group) in hierarchy.groups.iter().enumerate().rev() {
        if let Some(parent) = group.parent_index {
            let ids = descendants[index].clone();
            descendants.get_mut(parent as usize).c(h!())?.extend(ids);
            *children.get_mut(parent as usize).c(h!())? = true;
        }
    }
    for (index, group) in hierarchy.groups.iter().enumerate() {
        if include_children {
            for unit in &direct[index] {
                scopes.insert(
                    format!("unit-id:{}", unit.id),
                    (unit.name.clone(), descendants[index].clone()),
                );
            }
        }
        if group.level < 2 || (!children[index] && direct[index].len() <= 1) {
            continue;
        }
        let (value, label) = if direct[index].len() == 1 {
            let unit = direct[index][0];
            (format!("unit-id:{}", unit.id), unit.name.clone())
        } else {
            (format!("unit-parent:{}", group.id), group.label.clone())
        };
        let ids = if include_children {
            descendants[index].clone()
        } else {
            direct[index].iter().map(|unit| unit.id).collect()
        };
        scopes.insert(value, (label, ids));
    }
    scopes.insert(
        format!("unit-id:{ANALYSIS_STATS_UNDEFINED_UNIT_ID}"),
        (ANALYSIS_STATS_UNDEFINED_UNIT_NAME.to_string(), vec![]),
    );
    Ok(scopes)
}

#[derive(FromQueryResult)]
struct Count {
    value: String,
    label: String,
    count: i64,
}

pub(crate) async fn load(
    db: &DatabaseConnection,
    filter: &DailyMessageStatsReq,
    allowed: impl Into<filters::Access>,
    hierarchy: &UnitHierarchyRsp,
    include_children: bool,
) -> anyhow::Result<Vec<UnitStatsOption>> {
    let allowed = allowed.into();
    date_range(filter).c(h!())?;
    let scopes = scopes(hierarchy, include_children).c(h!())?;
    let groups = filters::groups(filter, &allowed.groups);
    let mut filter = filter.clone();
    filter.selected_unit_ids = None;
    if filters::empty(&filter, &groups) {
        return Ok(scopes
            .into_iter()
            .map(|(value, (label, _))| UnitStatsOption {
                value,
                label,
                count: 0,
            })
            .collect());
    }
    let mut scope =
        filters::Scope::new(&filter, allowed.with_groups(groups)).c(h!())?;
    let mut keys = vec![];
    let mut labels = vec![];
    let mut scope_keys = vec![];
    let mut unit_ids = vec![];
    for (value, (label, ids)) in scopes {
        keys.push(value.clone());
        labels.push(label);
        for unit_id in ids {
            scope_keys.push(value.clone());
            unit_ids.push(unit_id);
        }
    }
    let keys = scope.bind(keys);
    let labels = scope.bind(labels);
    let scope_keys = scope.bind(scope_keys);
    let unit_ids = scope.bind(unit_ids);
    let eligible = scope.messages();
    let sql = format!(
        r#"with eligible as materialized ({eligible}), options as (
        select value,label,ordinality as scope_id from unnest({keys}::text[], {labels}::text[]) with ordinality o(value,label,ordinality)
    ), mapping as (
        select o.scope_id,m.unit_id from unnest({scope_keys}::text[],{unit_ids}::bigint[]) m(value,unit_id)
        join options o on o.value=m.value
    ), links as materialized (
        select distinct iu.item_id,iu.unit_id from sigint_inbox_item_unit iu
        join sigint_unit u on u.id=iu.unit_id and not u.deleted
        where iu.item_id in (select id from eligible)
    ), scope_messages as (
        select distinct m.scope_id,l.item_id from links l join mapping m on m.unit_id=l.unit_id
    ), counts as (
        select scope_id,count(*)::bigint as count from scope_messages group by scope_id
        union all select (select scope_id from options where value='unit-id:{ANALYSIS_STATS_UNDEFINED_UNIT_ID}'),count(*)::bigint
        from eligible e where not exists(select 1 from links l where l.item_id=e.id)
    ) select o.value,o.label,coalesce(c.count,0)::bigint as count
      from options o left join counts c on c.scope_id=o.scope_id order by o.value"#
    );
    let rows = Count::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        scope.values,
    ))
    .all(&crate::read_query::connection(db))
    .await
    .c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| UnitStatsOption {
            value: row.value,
            label: row.label,
            count: row.count,
        })
        .collect())
}

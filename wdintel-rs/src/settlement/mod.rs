use crate::config::{
    SETTLEMENT_LOOKUP_BATCH_SIZE, SETTLEMENT_SEARCH_LIMIT,
    SETTLEMENT_SEARCH_MIN_CHARS,
};
use crate::h;
use crate::types::ShortContext;
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};

mod resolution;
mod scope;

pub(crate) use resolution::resolve_candidates;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SettlementRecord {
    pub id: i32,
    pub name: String,
    pub district: Option<String>,
    pub region: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

#[derive(FromQueryResult)]
struct IndexedSettlementRow {
    location_index: i64,
    id: i32,
    name: String,
    district: Option<String>,
    region: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
}

impl IndexedSettlementRow {
    fn into_settlement(self) -> SettlementRecord {
        SettlementRecord {
            id: self.id,
            name: self.name,
            district: self.district,
            region: self.region,
            lat: self.lat,
            lon: self.lon,
        }
    }
}

pub(crate) fn normalize_name(name: &str) -> String {
    name.trim()
        .chars()
        .map(|character| {
            let mut uppercase = character.to_uppercase();
            let first = uppercase.next().unwrap_or(character);
            if uppercase.next().is_some() {
                character
            } else {
                first
            }
        })
        .collect::<String>()
        .replace(['\'', 'ʼ', '`'], "’")
}

pub(crate) async fn search_by_name<C: ConnectionTrait>(
    dbx: &C,
    query: &str,
) -> anyhow::Result<Vec<SettlementRecord>> {
    let query = query.trim();
    if query.chars().count() < SETTLEMENT_SEARCH_MIN_CHARS {
        return Ok(vec![]);
    }
    let query = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Ok(load_name_matches(
        dbx,
        vec![format!("%{query}%")],
        "like",
        Some(SETTLEMENT_SEARCH_LIMIT),
    )
    .await
    .c(h!())?
    .into_iter()
    .map(IndexedSettlementRow::into_settlement)
    .collect())
}

pub(crate) async fn find_by_names<C: ConnectionTrait>(
    dbx: &C,
    names: &[String],
) -> anyhow::Result<Vec<Vec<SettlementRecord>>> {
    let mut settlements = vec![vec![]; names.len()];
    for (batch_index, names) in
        names.chunks(SETTLEMENT_LOOKUP_BATCH_SIZE).enumerate()
    {
        let rows = load_name_matches(dbx, names.to_vec(), "=", None)
            .await
            .c(h!())?;
        append_rows(
            &mut settlements[batch_index * SETTLEMENT_LOOKUP_BATCH_SIZE..],
            rows,
        )
        .c(h!())?;
    }
    Ok(settlements)
}

async fn load_name_matches<C: ConnectionTrait>(
    dbx: &C,
    names: Vec<String>,
    comparison: &str,
    limit: Option<i64>,
) -> anyhow::Result<Vec<IndexedSettlementRow>> {
    IndexedSettlementRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            r#"
with requested as (
    select ordinality - 1 as location_index,
        upper(translate(btrim(name), chr(39) || 'ʼ`', '’’’')) as name
    from unnest($1::text[]) with ordinality as request(name, ordinality)
    where btrim(name) <> ''
)
select requested.location_index, settlement.id, settlement.name,
    settlement.district, settlement.region, settlement.lat, settlement.lon
from requested
cross join lateral (
    select id
    from settlement
    where upper(translate(btrim(name), chr(39) || 'ʼ`', '’’’')) {comparison} requested.name
    union
    select settlement_id as id
    from settlement_alias
    where upper(translate(btrim(text), chr(39) || 'ʼ`', '’’’')) {comparison} requested.name
) matched
join settlement on settlement.id = matched.id
order by requested.location_index, settlement.name, settlement.id
limit $2
            "#
        ),
        [names.into(), limit.into()],
    ))
    .all(dbx)
    .await
    .c(h!())
}

fn append_rows(
    settlements: &mut [Vec<SettlementRecord>],
    rows: Vec<IndexedSettlementRow>,
) -> anyhow::Result<()> {
    for row in rows {
        let location_index = usize::try_from(row.location_index).c(h!())?;
        let settlements = settlements.get_mut(location_index).c(h!())?;
        if !settlements.iter().any(|settlement| settlement.id == row.id) {
            settlements.push(row.into_settlement());
        }
    }
    Ok(())
}

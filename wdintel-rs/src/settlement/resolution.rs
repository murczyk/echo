use super::scope::SettlementScope;
use super::{
    append_rows, find_by_names, normalize_name, IndexedSettlementRow,
    SettlementRecord,
};
use crate::config::SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS;
use crate::h;
use crate::location::types::SettlementDetails;
use crate::location::SettlementsDataConfig;
use crate::types::ShortContext;
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};
use std::sync::{Arc, RwLock};

pub(crate) async fn resolve_candidates<C: ConnectionTrait>(
    dbx: &C,
    config: Arc<RwLock<SettlementsDataConfig>>,
    locations: &[String],
    aor_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<Vec<SettlementRecord>>> {
    let scope = {
        let config = config
            .read()
            .map_err(|error| anyhow::anyhow!("{error:?}"))
            .c(h!())?;
        SettlementScope::new(&config, aor_ids)
    };
    let mut settlements = find_by_names(dbx, locations).await.c(h!())?;
    for settlements in &mut settlements {
        settlements.retain(|settlement| {
            settlement
                .lat
                .zip(settlement.lon)
                .is_some_and(|(lat, lon)| scope.contains(lat, lon))
        });
    }
    let coordinates =
        dictionary_coordinates(config, locations, &settlements, aor_ids)
            .c(h!())?;
    let rows = find_by_coordinates(dbx, &coordinates).await.c(h!())?;
    append_rows(&mut settlements, rows).c(h!())?;
    Ok(settlements)
}

fn dictionary_coordinates(
    config: Arc<RwLock<SettlementsDataConfig>>,
    locations: &[String],
    settlements: &[Vec<SettlementRecord>],
    aor_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<(usize, (f64, f64))>> {
    let mut coordinates = vec![];
    for (location_index, location) in locations.iter().enumerate() {
        if !settlements[location_index].is_empty()
            || normalize_name(location).is_empty()
        {
            continue;
        }
        let matches = crate::location::find_settlements_by_name_scope(
            config.clone(),
            location.clone(),
            None,
            None,
            aor_ids,
        )
        .c(h!())?;
        coordinates.extend(
            prefer_exact_names(location, matches)
                .into_iter()
                .filter_map(|settlement| {
                    settlement
                        .coords
                        .map(|coordinate| (location_index, coordinate))
                }),
        );
    }
    Ok(coordinates)
}

fn prefer_exact_names(
    location: &str,
    mut settlements: Vec<SettlementDetails>,
) -> Vec<SettlementDetails> {
    let location = normalize_name(location);
    if settlements
        .iter()
        .any(|settlement| normalize_name(&settlement.name) == location)
    {
        settlements
            .retain(|settlement| normalize_name(&settlement.name) == location);
    }
    settlements
}

async fn find_by_coordinates<C: ConnectionTrait>(
    dbx: &C,
    coordinates: &[(usize, (f64, f64))],
) -> anyhow::Result<Vec<IndexedSettlementRow>> {
    if coordinates.is_empty() {
        return Ok(vec![]);
    }
    let location_indices = coordinates
        .iter()
        .map(|(location_index, _)| i64::try_from(*location_index).c(h!()))
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let latitudes = coordinates
        .iter()
        .map(|(_, (lat, _))| *lat)
        .collect::<Vec<_>>();
    let longitudes = coordinates
        .iter()
        .map(|(_, (_, lon))| *lon)
        .collect::<Vec<_>>();
    IndexedSettlementRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
with candidates as (
    select
        ordinality as candidate_index,
        location_index,
        latitude,
        longitude
    from unnest($1::bigint[], $2::double precision[], $3::double precision[])
        with ordinality as candidate(location_index, latitude, longitude, ordinality)
)
select
    candidate.location_index,
    matched.id as id,
    matched.name,
    matched.district,
    matched.region,
    matched.lat,
    matched.lon
from candidates candidate
cross join lateral (
    select settlement.id, settlement.name, settlement.district,
        settlement.region, settlement.lat, settlement.lon
    from settlement
    where settlement.lat is not null
      and settlement.lon is not null
      and ST_DWithin(
          ST_SetSRID(ST_MakePoint(settlement.lon, settlement.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(candidate.longitude, candidate.latitude), 4326)::geography,
          $4
      )
    order by
        ST_DistanceSphere(
            ST_SetSRID(ST_MakePoint(settlement.lon, settlement.lat), 4326),
            ST_SetSRID(ST_MakePoint(candidate.longitude, candidate.latitude), 4326)
        ),
        settlement.id
    limit 1
) matched
order by candidate.candidate_index
            "#,
        [
            location_indices.into(), latitudes.into(), longitudes.into(),
            SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS.into(),
        ],
    ))
    .all(dbx)
    .await
    .c(h!())
}

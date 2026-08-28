use crate::battle_line::active_battle_line_id;
use crate::config::{
    BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MAX,
    BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MIN,
    BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MAX,
    BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MIN,
};
use crate::h;
use crate::types::ShortContext;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};

pub async fn fill_new_peleng_distances<C>(
    dbx: &C,
    peleng_ids: &[i64],
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let Some(battle_line_version_id) =
        active_battle_line_id(dbx).await.c(h!())?
    else {
        return Ok(0);
    };
    fill_peleng_distances(dbx, battle_line_version_id, peleng_ids).await
}

pub(super) async fn fill_peleng_distances<C>(
    dbx: &C,
    battle_line_version_id: i64,
    peleng_ids: &[i64],
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    if peleng_ids.is_empty() {
        return Ok(0);
    }
    let updated = dbx
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with peleng_distances as (
    select
        peleng.id,
        min(ST_Distance(
            ST_SetSRID(ST_MakePoint(peleng.lng, peleng.lat), 4326)::geography,
            component.geom::geography
        )) as distance_m
    from sigint_peleng peleng
    join battle_line_version battle_line
        on battle_line.id = $2
    cross join lateral ST_Dump(
        ST_CollectionExtract(battle_line.geometry, 2)
    ) component
    where peleng.id = any($1::bigint[])
      and peleng.battle_line_distance is null
      and not peleng.deleted
      and peleng.lat between $3 and $4
      and peleng.lng between $5 and $6
    group by peleng.id
), updated as (
    update sigint_peleng peleng
    set
        battle_line_distance = ceil(peleng_distances.distance_m)::integer,
        updated_at = now() at time zone 'utc'
    from peleng_distances
    where peleng.id = peleng_distances.id
      and peleng.battle_line_distance is null
    returning peleng.id
)
select id from updated
            "#,
            [
                peleng_ids.to_vec().into(),
                battle_line_version_id.into(),
                BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MIN.into(),
                BATTLE_LINE_PELENG_DISTANCE_LATITUDE_MAX.into(),
                BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MIN.into(),
                BATTLE_LINE_PELENG_DISTANCE_LONGITUDE_MAX.into(),
            ],
        ))
        .await
        .c(h!())?;
    Ok(updated.len() as u64)
}

use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        recalculate(manager, ANCHOR_RAY_SECTORS_SQL).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        recalculate(manager, PERPENDICULAR_STRIPS_SQL).await
    }
}

async fn recalculate(
    manager: &SchemaManager<'_>,
    insert_sql: &str,
) -> Result<(), DbErr> {
    manager
        .get_connection()
        .execute_unprepared(
            r#"
select pg_advisory_xact_lock(2287);
delete from battle_line_aor_geometry;
update sigint_inbox_item_settlement
set settlement_id = null,
    is_undefined = null
where settlement_id is not null
   or is_undefined is not null;
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
    manager
        .get_connection()
        .execute_unprepared(insert_sql)
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
    Ok(())
}

const ANCHOR_RAY_SECTORS_SQL: &str = r#"
with input as (
    select
        bl.id as version_id,
        a.id as aor_id,
        ST_Transform(bl.geometry, 3857) as full_geometry,
        ST_Transform(ST_SetSRID(ST_MakePoint(a.left_lon, a.left_lat), 4326), 3857) as start_hint,
        ST_Transform(ST_SetSRID(ST_MakePoint(a.right_lon, a.right_lat), 4326), 3857) as end_hint,
        ST_Transform(ST_SetSRID(ST_MakePoint(32.225445087959685, 48.51054861269846), 4326), 3857) as anchor
    from battle_line_version bl
    cross join area_of_responsibility a
    where bl.retired_at is null
      and not a.deleted
      and a.left_lat is not null
      and a.left_lon is not null
      and a.right_lat is not null
      and a.right_lon is not null
), snapped as (
    select
        version_id,
        aor_id,
        full_geometry,
        start_hint,
        end_hint,
        anchor,
        ST_ClosestPoint(full_geometry, start_hint) as snapped_start,
        ST_ClosestPoint(full_geometry, end_hint) as snapped_end
    from input
), directed as (
    select *,
        ST_X(start_hint) - ST_X(anchor) as start_dx,
        ST_Y(start_hint) - ST_Y(anchor) as start_dy,
        ST_X(end_hint) - ST_X(anchor) as end_dx,
        ST_Y(end_hint) - ST_Y(anchor) as end_dy,
        ST_Distance(anchor, start_hint) as start_length,
        ST_Distance(anchor, end_hint) as end_length,
        ST_Distance(snapped_start, snapped_end) as guide_length
    from snapped
), clipped as (
    select *, ST_SetSRID(ST_MakePolygon(ST_MakeLine(array[
        ST_MakePoint(ST_X(anchor), ST_Y(anchor)),
        ST_MakePoint(
            ST_X(anchor) + start_dx / start_length * 50000000.0,
            ST_Y(anchor) + start_dy / start_length * 50000000.0
        ),
        ST_MakePoint(
            ST_X(anchor) + end_dx / end_length * 50000000.0,
            ST_Y(anchor) + end_dy / end_length * 50000000.0
        ),
        ST_MakePoint(ST_X(anchor), ST_Y(anchor))
    ])), 3857) as span
    from directed
    where guide_length > 0.01
      and start_length > 0.01
      and end_length > 0.01
), geometry_parts as (
    select *,
        ST_Intersection(ST_CollectionExtract(full_geometry, 1), span) as clipped_points,
        ST_CollectionExtract(
            ST_Intersection(ST_CollectionExtract(full_geometry, 2), span),
            2
        ) as clipped_lines
    from clipped
), result as (
    select *, ST_ForceCollection(
        ST_Transform(ST_Collect(clipped_points, clipped_lines), 4326)
    ) as geometry
    from geometry_parts
)
insert into battle_line_aor_geometry
    (version_id, aor_id, geometry, snapped_start, snapped_end)
select
    version_id,
    aor_id,
    geometry,
    ST_Transform(snapped_start, 4326),
    ST_Transform(snapped_end, 4326)
from result
where not ST_IsEmpty(geometry)
"#;

const PERPENDICULAR_STRIPS_SQL: &str = r#"
with input as (
    select
        bl.id as version_id,
        a.id as aor_id,
        ST_Transform(bl.geometry, 3857) as full_geometry,
        ST_Transform(ST_SetSRID(ST_MakePoint(a.left_lon, a.left_lat), 4326), 3857) as start_hint,
        ST_Transform(ST_SetSRID(ST_MakePoint(a.right_lon, a.right_lat), 4326), 3857) as end_hint
    from battle_line_version bl
    cross join area_of_responsibility a
    where bl.retired_at is null
      and not a.deleted
      and a.left_lat is not null
      and a.left_lon is not null
      and a.right_lat is not null
      and a.right_lon is not null
), snapped as (
    select
        version_id,
        aor_id,
        full_geometry,
        ST_ClosestPoint(full_geometry, start_hint) as snapped_start,
        ST_ClosestPoint(full_geometry, end_hint) as snapped_end
    from input
), directed as (
    select *,
        ST_X(snapped_end) - ST_X(snapped_start) as dx,
        ST_Y(snapped_end) - ST_Y(snapped_start) as dy,
        ST_Distance(snapped_start, snapped_end) as guide_length
    from snapped
), clipped as (
    select *, ST_SetSRID(ST_MakePolygon(ST_MakeLine(array[
        ST_MakePoint(ST_X(snapped_start) - dy / guide_length * 50000000.0, ST_Y(snapped_start) + dx / guide_length * 50000000.0),
        ST_MakePoint(ST_X(snapped_end) - dy / guide_length * 50000000.0, ST_Y(snapped_end) + dx / guide_length * 50000000.0),
        ST_MakePoint(ST_X(snapped_end) + dy / guide_length * 50000000.0, ST_Y(snapped_end) - dx / guide_length * 50000000.0),
        ST_MakePoint(ST_X(snapped_start) + dy / guide_length * 50000000.0, ST_Y(snapped_start) - dx / guide_length * 50000000.0),
        ST_MakePoint(ST_X(snapped_start) - dy / guide_length * 50000000.0, ST_Y(snapped_start) + dx / guide_length * 50000000.0)
    ])), 3857) as span
    from directed
    where guide_length > 0.01
), geometry_parts as (
    select *,
        ST_Intersection(ST_CollectionExtract(full_geometry, 1), span) as clipped_points,
        ST_CollectionExtract(
            ST_Intersection(ST_CollectionExtract(full_geometry, 2), span),
            2
        ) as clipped_lines
    from clipped
), result as (
    select *, ST_ForceCollection(
        ST_Transform(ST_Collect(clipped_points, clipped_lines), 4326)
    ) as geometry
    from geometry_parts
)
insert into battle_line_aor_geometry
    (version_id, aor_id, geometry, snapped_start, snapped_end)
select
    version_id,
    aor_id,
    geometry,
    ST_Transform(snapped_start, 4326),
    ST_Transform(snapped_end, 4326)
from result
where not ST_IsEmpty(geometry)
"#;

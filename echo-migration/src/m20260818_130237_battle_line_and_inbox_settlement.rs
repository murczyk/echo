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
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create table battle_line_version (
    id bigserial primary key,
    geometry geometry(GeometryCollection, 4326) not null,
    source_file_name text not null,
    uploaded_by_login_id uuid not null references login(id) on delete restrict,
    uploaded_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    retired_at timestamp without time zone,
    check (not ST_IsEmpty(geometry)),
    check (ST_IsValid(geometry))
);

create unique index battle_line_version_active_uq
    on battle_line_version ((true))
    where retired_at is null;

create index battle_line_version_uploaded_at_idx
    on battle_line_version (uploaded_at desc, id desc);

create index battle_line_version_geometry_gix
    on battle_line_version using gist (geometry);

create table battle_line_aor_geometry (
    id bigserial primary key,
    version_id bigint not null references battle_line_version(id) on delete cascade,
    aor_id bigint not null references area_of_responsibility(id) on delete cascade,
    geometry geometry(GeometryCollection, 4326) not null,
    snapped_start geometry(Point, 4326) not null,
    snapped_end geometry(Point, 4326) not null,
    calculated_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    unique (version_id, aor_id),
    check (not ST_IsEmpty(geometry)),
    check (ST_IsValid(geometry)),
    check (not ST_Equals(snapped_start, snapped_end))
);

create index battle_line_aor_geometry_aor_version_idx
    on battle_line_aor_geometry (aor_id, version_id);

create index battle_line_aor_geometry_geometry_gix
    on battle_line_aor_geometry using gist (geometry);

create table sigint_inbox_item_settlement (
    id bigserial primary key,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    item_id bigint not null references sigint_inbox_item(id) on delete cascade,
    settlement_text text not null,
    settlement_id integer references settlement(id) on delete set null,
    is_undefined boolean,
    unique (item_id, settlement_text),
    check (is_undefined is null or (is_undefined and settlement_id is null))
);

create index sigint_inbox_item_settlement_settlement_item_idx
    on sigint_inbox_item_settlement (settlement_id, item_id)
    where settlement_id is not null;

create index sigint_inbox_item_settlement_pending_idx
    on sigint_inbox_item_settlement (id)
    where settlement_id is null and is_undefined is null;

create index sigint_inbox_item_settlement_unresolved_text_item_idx
    on sigint_inbox_item_settlement (settlement_text, item_id)
    where is_undefined is true;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table if exists sigint_inbox_item_settlement;
drop table if exists battle_line_aor_geometry;
drop table if exists battle_line_version;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

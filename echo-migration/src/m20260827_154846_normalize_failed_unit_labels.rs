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
create table failed_unit_label (
    id bigserial primary key,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    unit_txt text not null check (btrim(unit_txt) <> ''),
    is_bad_data boolean default false not null,
    note text default '' not null
);

create unique index failed_unit_label_normalized_uq
    on failed_unit_label (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))
    );

create table sigint_inbox_item_failed_unit_label (
    id bigserial primary key,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
    failed_unit_label_id bigint not null references failed_unit_label(id) on delete cascade,
    deleted boolean default false not null,
    deleted_at timestamp without time zone
);

create unique index sigint_inbox_item_failed_unit_label_relation_uq
    on sigint_inbox_item_failed_unit_label (
        inbox_item_id,
        failed_unit_label_id
    );

create index sigint_inbox_item_failed_unit_label_active_label_idx
    on sigint_inbox_item_failed_unit_label (
        failed_unit_label_id,
        inbox_item_id
    )
    where deleted = false;

create index sigint_inbox_item_failed_unit_label_active_item_idx
    on sigint_inbox_item_failed_unit_label (
        inbox_item_id,
        failed_unit_label_id
    )
    where deleted = false;

create index sigint_inbox_item_failed_unit_label_pending_idx
    on sigint_inbox_item_failed_unit_label (deleted_at, id)
    where deleted = true;

drop table failed_inbox_unit;
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
create table failed_inbox_unit (
    id bigserial primary key,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    deleted boolean default false not null,
    is_bad_data boolean default false not null,
    inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
    unit_txt text not null check (btrim(unit_txt) <> ''),
    deleted_at timestamp without time zone,
    note text default '' not null
);

create unique index failed_inbox_unit_inbox_item_text_uq
    on failed_inbox_unit (
        inbox_item_id,
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))
    );

create index failed_inbox_unit_active_text_idx
    on failed_inbox_unit (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g')),
        id
    )
    where deleted = false and is_bad_data = false;

create index failed_inbox_unit_bad_text_idx
    on failed_inbox_unit (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))
    )
    where deleted = false and is_bad_data = true;

create index failed_inbox_unit_pending_idx
    on failed_inbox_unit (deleted_at, id)
    where deleted = true;

create index failed_inbox_unit_active_text_metadata_idx
    on failed_inbox_unit (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g')),
        is_bad_data desc,
        id desc
    )
    where deleted = false;

drop table sigint_inbox_item_failed_unit_label;
drop table failed_unit_label;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

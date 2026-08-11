use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index if exists sigint_inbox_item_sigint_unit_id_idx;

alter table sigint_inbox_item
    drop column if exists sigint_unit_id;

create type sigint_inbox_item_unit_kind as enum ('parsed', 'network');

create table sigint_inbox_item_unit (
    id bigserial primary key,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    item_id bigint not null references sigint_inbox_item(id) on delete cascade,
    unit_id bigint not null references sigint_unit(id) on delete cascade,
    kind sigint_inbox_item_unit_kind not null,
    unique (item_id, unit_id, kind)
);

create unique index sigint_inbox_item_unit_parsed_item_id_uq
    on sigint_inbox_item_unit (item_id)
    where kind = 'parsed';

create index sigint_inbox_item_unit_unit_id_kind_item_id_idx
    on sigint_inbox_item_unit (unit_id, kind, item_id);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table if exists sigint_inbox_item_unit;
drop type if exists sigint_inbox_item_unit_kind;

alter table sigint_inbox_item
    add column sigint_unit_id bigint
        references sigint_unit(id) on delete set null;

create index sigint_inbox_item_sigint_unit_id_idx
    on sigint_inbox_item (sigint_unit_id)
    where sigint_unit_id is not null;
                "#,
            )
            .await?;
        Ok(())
    }
}

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
create type sigint_inbox_item_callsign_source as enum ('primary', 'alg2');

create table sigint_inbox_item_callsign (
    id bigserial primary key,
    sigint_inbox_item_id bigint not null
        references sigint_inbox_item(id) on delete cascade,
    callsign text not null,
    source sigint_inbox_item_callsign_source not null,
    ordering float8 not null check (ordering >= 0),
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    deleted_at timestamp without time zone,
    deleted boolean default false not null,
    created_by_id uuid not null references login(id),
    deleted_by_id uuid references login(id),
    unique (sigint_inbox_item_id, source, callsign)
);

create index sigint_inbox_item_callsign_active_callsign_idx
    on sigint_inbox_item_callsign (callsign, sigint_inbox_item_id)
    where not deleted;
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
drop table if exists sigint_inbox_item_callsign;
drop type if exists sigint_inbox_item_callsign_source;
                "#,
            )
            .await?;
        Ok(())
    }
}

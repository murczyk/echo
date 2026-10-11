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
create table settlement_alias (
    id uuid primary key,
    settlement_id integer not null references settlement(id) on delete cascade,
    text text not null check (btrim(text) <> '')
);

create unique index settlement_alias_settlement_text_idx
    on settlement_alias (settlement_id, lower(btrim(text)));

create extension if not exists pg_trgm;
create index settlement_name_trgm_idx on settlement using gin (name gin_trgm_ops);
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
drop index if exists settlement_name_trgm_idx;
drop table if exists settlement_alias;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

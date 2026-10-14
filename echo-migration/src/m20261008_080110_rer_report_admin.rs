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
create table rer_report_access_login (
    id bigserial primary key,
    login_id uuid not null references login(id) on delete cascade,
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    unique (login_id)
);

create table sigint_unit_rer_report_metadata (
    id bigserial primary key,
    sigint_unit_id bigint not null references sigint_unit(id) on delete cascade,
    locations jsonb not null default '[]'::jsonb
        check (jsonb_typeof(locations) = 'array'),
    labels jsonb not null default '[]'::jsonb
        check (jsonb_typeof(labels) = 'array'),
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    unique (sigint_unit_id)
);
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
drop table if exists sigint_unit_rer_report_metadata;
drop table if exists rer_report_access_login;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

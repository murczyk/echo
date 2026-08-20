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
create table ai_intel_report_settings (
    id smallint primary key check (id = 1),
    quick_suggestion_enabled boolean default false not null,
    quick_ai_engine_id uuid references ai_engine(id) on delete set null,
    legacy_comment_cutoff timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    check (not quick_suggestion_enabled or quick_ai_engine_id is not null)
);

insert into ai_intel_report_settings (id) values (1);

create index sigint_comment_ai_intel_examples_idx
    on sigint_comment (login_id, created_at desc, signal_message_id)
    where comment <> '';

create index intel_product_ai_intel_examples_idx
    on intel_product (created_at desc, source_message_id, intel_message_id)
    where relation_kind = 'report';
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
drop index if exists sigint_comment_ai_intel_examples_idx;
drop index if exists intel_product_ai_intel_examples_idx;
drop table if exists ai_intel_report_settings;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

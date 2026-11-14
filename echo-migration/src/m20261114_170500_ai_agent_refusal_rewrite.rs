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
-- Refusal rewrite layer for OpenAI-family chat engines: when the model
-- declines an operational request, the ask is rewritten to evidence-inventory
-- form by a second engine and retried once. The engine is configurable and
-- defaults to gpt-6-luna when the column stays null.
alter table ai_agent_settings
    add column if not exists refusal_rewrite_enabled boolean not null default false,
    add column if not exists refusal_rewrite_ai_engine_id uuid
        references ai_engine(id) on delete set null;
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
alter table ai_agent_settings
    drop column if exists refusal_rewrite_ai_engine_id,
    drop column if exists refusal_rewrite_enabled;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

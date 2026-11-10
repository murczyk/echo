use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
alter table ai_engine
    add column unhealthy boolean not null default false,
    add column health_message text,
    add column health_updated_at timestamp,
    add column health_updated_by_login_id uuid references login(id) on delete set null;

alter table ai_agent_allowed_engine add column position integer not null default 0;
"#).await.map_err(|error| DbErr::Migration(format!("at {} line {}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table ai_agent_allowed_engine drop column position;
alter table ai_engine
    drop column health_updated_by_login_id,
    drop column health_updated_at,
    drop column health_message,
    drop column unhealthy;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!(
                    "at {} line {}: {error}",
                    file!(),
                    line!()
                ))
            })?;
        Ok(())
    }
}

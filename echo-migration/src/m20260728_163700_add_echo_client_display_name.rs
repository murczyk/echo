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
                alter table echo_client
                    add column if not exists display_name text;

                update echo_client
                set display_name = regexp_replace(name, '^echo-swapp-', '')
                where name like 'echo-swapp-%'
                    and display_name is null;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "alter table echo_client drop column if exists display_name;",
            )
            .await?;
        Ok(())
    }
}

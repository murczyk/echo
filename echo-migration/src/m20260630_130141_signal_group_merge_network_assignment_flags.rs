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
                update signal_group
                   set disable_network_assignment = disable_network_assignment or not fills_etalonka;

                alter table signal_group
                    drop column if exists fills_etalonka;
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
                alter table signal_group
                    add column if not exists fills_etalonka boolean not null default true;

                update signal_group
                   set fills_etalonka = not disable_network_assignment;
                "#,
            )
            .await?;
        Ok(())
    }
}

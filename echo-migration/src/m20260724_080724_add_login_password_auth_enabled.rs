use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "
                alter table login
                    add column password_auth_enabled boolean;

                update login
                set password_auth_enabled = password is not null;

                alter table login
                    alter column password_auth_enabled set not null,
                    alter column password_auth_enabled set default false;
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "
                alter table login
                    drop column password_auth_enabled;
                ",
            )
            .await?;
        Ok(())
    }
}

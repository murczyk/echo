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
                    do $$
                    begin
                        if exists (
                            select 1
                            from information_schema.columns
                            where table_name = 'knowledge'
                                and column_name = 'deleted'
                        ) then
                            delete from knowledge
                            where deleted = true;
                        end if;
                    end $$;

                    alter table knowledge
                        drop column if exists deleted;
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
                    alter table knowledge
                        add column if not exists deleted bool not null default false;
                "#,
            )
            .await?;
        Ok(())
    }
}

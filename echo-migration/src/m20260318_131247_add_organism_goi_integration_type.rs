use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table organism
                    add column goi_integration_type text not null default 'full';

                update organism
                set goi_integration_type = 'full'
                where goi_integration_type <> 'full';

                alter table organism
                    add constraint organism_goi_integration_type_chk
                    check (goi_integration_type in ('simple', 'full'));
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table organism
                    drop constraint if exists organism_goi_integration_type_chk,
                    drop column goi_integration_type;
            "#,
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table signal_message drop column datasource_id;
                alter table signal_message drop column group_master_key;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table signal_message add column group_master_key text references signal_group(master_key);
                alter table signal_message add column datasource_id bigint references datasource(id);
            "#,
        )
            .await?;
        Ok(())
    }
}

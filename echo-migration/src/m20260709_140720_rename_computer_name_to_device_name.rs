use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table if exists computer_name rename to device_name;

                alter table sigint_inbox_item
                    rename column computer_name_id to device_name_id;

                alter index if exists idx_sii_computer_name_id
                    rename to idx_sii_device_name_id;

                alter index if exists computer_name_search_tsv_idx
                    rename to device_name_search_tsv_idx;

                alter index if exists computer_name_name_trgm_idx
                    rename to device_name_name_trgm_idx;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter index if exists device_name_name_trgm_idx
                    rename to computer_name_name_trgm_idx;

                alter index if exists device_name_search_tsv_idx
                    rename to computer_name_search_tsv_idx;

                alter index if exists idx_sii_device_name_id
                    rename to idx_sii_computer_name_id;

                alter table sigint_inbox_item
                    rename column device_name_id to computer_name_id;

                alter table if exists device_name rename to computer_name;
            "#,
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table sigint_inbox_item_metadata
                add column if not exists color_code_start_index integer,
                add column if not exists color_code_end_index integer,
                add column if not exists call_group_id_start_index integer,
                add column if not exists call_group_id_end_index integer,
                add column if not exists call_group_name_start_index integer,
                add column if not exists call_group_name_end_index integer,
                add column if not exists sender_id_start_index integer,
                add column if not exists sender_id_end_index integer,
                add column if not exists sender_name_start_index integer,
                add column if not exists sender_name_end_index integer,
                add column if not exists hash_id_start_index integer,
                add column if not exists hash_id_end_index integer;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table sigint_inbox_item_metadata
                drop column if exists hash_id_end_index,
                drop column if exists hash_id_start_index,
                drop column if exists sender_name_end_index,
                drop column if exists sender_name_start_index,
                drop column if exists sender_id_end_index,
                drop column if exists sender_id_start_index,
                drop column if exists call_group_name_end_index,
                drop column if exists call_group_name_start_index,
                drop column if exists call_group_id_end_index,
                drop column if exists call_group_id_start_index,
                drop column if exists color_code_end_index,
                drop column if exists color_code_start_index;
            "#,
        )
        .await?;
        Ok(())
    }
}

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
                alter table device rename column custom_fields to tags;
                alter table device rename column deleted to archived;
                alter table device rename column deleted_at to archived_at;
                alter table device rename constraint device_custom_fields_array_check
                    to device_tags_array_check;
                alter table device rename constraint device_deleted_deleted_at_check
                    to device_archived_archived_at_check;
                alter index device_deleted_updated_at_id_idx
                    rename to device_archived_updated_at_id_idx;
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
                alter index device_archived_updated_at_id_idx
                    rename to device_deleted_updated_at_id_idx;
                alter table device rename constraint device_archived_archived_at_check
                    to device_deleted_deleted_at_check;
                alter table device rename constraint device_tags_array_check
                    to device_custom_fields_array_check;
                alter table device rename column archived_at to deleted_at;
                alter table device rename column archived to deleted;
                alter table device rename column tags to custom_fields;
                "#,
            )
            .await?;
        Ok(())
    }
}

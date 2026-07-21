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
                create index if not exists goi_association_message_uid_null_id_idx
                    on goi_association (id)
                    where message_uid is null;

                create index if not exists signal_message_timestamp_id_idx
                    on signal_message (timestamp, id);
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
                drop index if exists signal_message_timestamp_id_idx;
                drop index if exists goi_association_message_uid_null_id_idx;
                "#,
            )
            .await?;
        Ok(())
    }
}

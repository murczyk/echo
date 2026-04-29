use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            create index if not exists signal_message_group_signal_message_id_group_master_key_idx
                on signal_message_group (signal_message_id, group_master_key);

            drop index if exists signal_message_group_signal_message_id_idx;
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            create index if not exists signal_message_group_signal_message_id_idx
                on signal_message_group (signal_message_id);

            drop index if exists signal_message_group_signal_message_id_group_master_key_idx;
            "#,
        )
        .await?;

        Ok(())
    }
}

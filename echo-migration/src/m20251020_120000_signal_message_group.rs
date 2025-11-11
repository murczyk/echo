use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                CREATE TABLE signal_message_group (
                    id BIGSERIAL PRIMARY KEY,
                    signal_message_id BIGINT NOT NULL REFERENCES signal_message (id) ON DELETE CASCADE,
                    group_master_key TEXT,
                    sender TEXT,
                    message_uid TEXT,
                    datasource_group_id BIGINT REFERENCES datasource_group (id) ON DELETE SET NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT now()
                );

                CREATE INDEX signal_message_group_signal_message_id_idx
                    ON signal_message_group (signal_message_id);
                CREATE INDEX signal_message_group_group_master_key_idx
                    ON signal_message_group (group_master_key);

                INSERT INTO signal_message_group (
                    signal_message_id,
                    group_master_key,
                    sender,
                    message_uid,
                    datasource_group_id,
                    created_at
                )
                SELECT
                    COALESCE(sm.duplicate_of, sm.id) AS signal_message_id,
                    dg.group_master_key,
                    sm.sender,
                    sm.message_uid,
                    sm.datasource_group_id,
                    sm.created_at
                FROM signal_message sm
                LEFT JOIN datasource_group dg ON dg.id = sm.datasource_group_id
                where sm.created_at > '2025-09-09';

                UPDATE signal_message
                SET deleted = true
                WHERE duplicate_of IS NOT NULL
                    AND deleted = false
                and created_at > '2025-09-09';

                DROP INDEX IF EXISTS signal_message_duplicate_of_idx;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                ALTER TABLE signal_message
                    ADD COLUMN IF NOT EXISTS duplicate_of BIGINT;
                CREATE INDEX IF NOT EXISTS signal_message_duplicate_of_idx
                    ON signal_message ((duplicate_of::BIGINT));

                DROP TABLE IF EXISTS signal_message_group;
            "#,
        )
        .await?;
        Ok(())
    }
}

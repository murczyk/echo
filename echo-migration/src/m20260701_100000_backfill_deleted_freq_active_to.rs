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
                UPDATE sigint_network_freq AS nf
                SET active_to = COALESCE(
                    nf.last_seen_dt,
                    (
                        SELECT MAX(COALESCE(sii.datetime, sm.timestamp, sm.created_at))
                        FROM sigint_inbox_item_network AS siin
                        JOIN sigint_inbox_item AS sii ON sii.id = siin.sigint_inbox_item_id
                        JOIN signal_message AS sm ON sm.id = sii.id
                        WHERE siin.sigint_network_id = nf.network_id
                          AND sii.freq = nf.freq
                          AND sm.deleted = false
                          AND COALESCE(sii.datetime, sm.timestamp, sm.created_at) >= nf.active_from
                    ),
                    nf.active_from
                )
                WHERE nf.deleted = true AND nf.active_to IS NULL;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

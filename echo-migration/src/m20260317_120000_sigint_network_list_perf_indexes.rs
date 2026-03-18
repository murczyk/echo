use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index if not exists sigint_network_freq_active_lookup_idx
                on sigint_network_freq (network_id, freq, active_from, active_to, id)
                where deleted = false;

            create index if not exists sigint_network_callsign_active_lookup_idx
                on sigint_network_callsign (sigint_network_id, sigint_callsign)
                where deleted = false;

            create index if not exists sigint_inbox_item_network_network_inbox_idx
                on sigint_inbox_item_network (sigint_network_id, sigint_inbox_item_id);

            create index if not exists stats_group_network_freq_day_network_batch_freq_dt_idx
                on stats_group_network_freq_day (network_id, signal_group_batch_id, frequency, dt);

            create index if not exists sigint_inbox_item_callsigns_gin_idx
                on sigint_inbox_item using gin (callsigns)
                where callsigns is not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists sigint_inbox_item_callsigns_gin_idx;
            drop index if exists stats_group_network_freq_day_network_batch_freq_dt_idx;
            drop index if exists sigint_inbox_item_network_network_inbox_idx;
            drop index if exists sigint_network_callsign_active_lookup_idx;
            drop index if exists sigint_network_freq_active_lookup_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}

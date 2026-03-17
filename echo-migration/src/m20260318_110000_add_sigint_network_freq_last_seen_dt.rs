use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table sigint_network_freq
                add column last_seen_dt timestamp without time zone;

            update sigint_network_freq nf
            set last_seen_dt = sub.last_seen_dt
            from (
                select
                    nf_inner.id as network_freq_id,
                    max(coalesce(sii.datetime, sm.timestamp, sm.created_at)) as last_seen_dt
                from sigint_network_freq nf_inner
                join sigint_inbox_item_network siin
                    on siin.sigint_network_id = nf_inner.network_id
                join sigint_inbox_item sii
                    on sii.id = siin.sigint_inbox_item_id
                join signal_message sm
                    on sm.id = sii.id
                where nf_inner.deleted = false
                  and sm.deleted = false
                  and sii.freq = nf_inner.freq
                  and coalesce(sii.datetime, sm.timestamp, sm.created_at) >= nf_inner.active_from
                  and coalesce(sii.datetime, sm.timestamp, sm.created_at) <= coalesce(nf_inner.active_to, current_timestamp at time zone 'utc')
                group by nf_inner.id
            ) sub
            where nf.id = sub.network_freq_id;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table sigint_network_freq
                drop column if exists last_seen_dt;
            "#,
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table sigint_network_encryption_key
                add column sigint_network_id int8 references sigint_network(id),
                add column description text;

            update sigint_network_encryption_key
                set sigint_network_id = sigint_network_freq.network_id
                from sigint_network_freq
                where sigint_network_encryption_key.sigint_network_freq_id = sigint_network_freq.id
                and sigint_network_encryption_key.sigint_network_id is null;

            create index sigint_network_encryption_key_sigint_network_id_idx
                on sigint_network_encryption_key(sigint_network_id);

            create index sigint_network_encryption_key_sigint_network_freq_id_idx
                on sigint_network_encryption_key(sigint_network_freq_id);
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index if exists sigint_network_encryption_key_sigint_network_freq_id_idx;
            drop index if exists sigint_network_encryption_key_sigint_network_id_idx;
            alter table sigint_network_encryption_key
                drop column if exists sigint_network_id,
                drop column if exists description;
            ",
        )
        .await?;
        Ok(())
    }
}

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
                add column modulation_id int8 references modulation(id);

            create table sigint_network_encryption_key_freq (
                id bigserial primary key,
                sigint_network_encryption_key_id int8 references sigint_network_encryption_key(id) not null,
                sigint_network_freq_id int8 references sigint_network_freq(id) not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create unique index sigint_network_encryption_key_freq_key_freq_uq
                on sigint_network_encryption_key_freq(sigint_network_encryption_key_id, sigint_network_freq_id);
            create index sigint_network_encryption_key_freq_key_idx
                on sigint_network_encryption_key_freq(sigint_network_encryption_key_id);
            create index sigint_network_encryption_key_freq_freq_idx
                on sigint_network_encryption_key_freq(sigint_network_freq_id);

            insert into sigint_network_encryption_key_freq (sigint_network_encryption_key_id, sigint_network_freq_id)
                select id, sigint_network_freq_id
                from sigint_network_encryption_key
                where sigint_network_freq_id is not null;

            update sigint_network_encryption_key
                set modulation_id = snf.modulation_id
                from sigint_network_freq snf
                where sigint_network_encryption_key.sigint_network_freq_id = snf.id
                and sigint_network_encryption_key.modulation_id is null;
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index if exists sigint_network_encryption_key_freq_freq_idx;
            drop index if exists sigint_network_encryption_key_freq_key_idx;
            drop index if exists sigint_network_encryption_key_freq_key_freq_uq;
            drop table if exists sigint_network_encryption_key_freq;

            alter table sigint_network_encryption_key
                drop column if exists modulation_id;
            ",
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("
            create table sigint_network_encryption_key (
                id bigserial primary key,
                key text not null,
                sigint_network_freq_id int8 references sigint_network_freq(id),
                organism_id int8 references organism(id) not null,
                deleted boolean not null default false,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            "
        ).await?;
        db.execute_unprepared(
            "create index sigint_network_encryption_key_key_idx on sigint_network_encryption_key(key);",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_network_encryption_key")
            .await?;

        Ok(())
    }
}

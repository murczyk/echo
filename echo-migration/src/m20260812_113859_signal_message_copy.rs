use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table if not exists intel_prod (
                signal_message_id bigint not null
                    references signal_message(id) on delete cascade,
                parent_signal_message_id bigint not null
                    references signal_message(id) on delete cascade,
                created_at timestamp not null default now(),
                primary key (signal_message_id, parent_signal_message_id)
            );

            create index if not exists idx_intel_prod_parent_signal_message_id
                on intel_prod(parent_signal_message_id);

            alter table signal_message_media
                add column if not exists storage_key text;

            update signal_message_media
            set storage_key = case
                when is_encrypted then substr(id::text, 1, 5) || '/' || id::text
                else substr(id::text, 1, 5) || '/' || id::text || '.plaintext'
            end
            where storage_key is null;
            
            create index if not exists idx_signal_message_media_storage_key
                on signal_message_media(storage_key);
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists idx_signal_message_media_storage_key;
            alter table signal_message_media drop column if exists storage_key;
            drop index if exists idx_intel_prod_parent_signal_message_id;
            drop table if exists intel_prod;
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

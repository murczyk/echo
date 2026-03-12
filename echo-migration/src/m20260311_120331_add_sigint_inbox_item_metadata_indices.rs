use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index if not exists sigint_inbox_item_metadata_created_at_desc_idx
                on sigint_inbox_item_metadata (created_at desc);

            create index if not exists sigint_inbox_item_metadata_inbox_item_id_idx
                on sigint_inbox_item_metadata (sigint_inbox_item_id);

            do $$
            begin
                if exists (
                    select 1
                    from information_schema.columns
                    where table_name = 'sigint_inbox_item_metadata'
                      and column_name = 'call_group_id'
                ) then
                    execute 'create index if not exists sigint_inbox_item_metadata_call_group_id_idx on sigint_inbox_item_metadata (call_group_id)';
                end if;

                if exists (
                    select 1
                    from information_schema.columns
                    where table_name = 'sigint_inbox_item_metadata'
                      and column_name = 'identifier_id'
                ) then
                    execute 'create index if not exists sigint_inbox_item_metadata_identifier_id_idx on sigint_inbox_item_metadata (identifier_id)';
                end if;

                if exists (
                    select 1
                    from information_schema.columns
                    where table_name = 'sigint_inbox_item_metadata'
                      and column_name = 'sender_id'
                ) then
                    execute 'create index if not exists sigint_inbox_item_metadata_sender_id_idx on sigint_inbox_item_metadata (sender_id)';
                end if;
            end $$;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists sigint_inbox_item_metadata_sender_id_idx;
            drop index if exists sigint_inbox_item_metadata_identifier_id_idx;
            drop index if exists sigint_inbox_item_metadata_call_group_id_idx;
            drop index if exists sigint_inbox_item_metadata_inbox_item_id_idx;
            drop index if exists sigint_inbox_item_metadata_created_at_desc_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table datasource add constraint datasource_api_login_uniq unique (api_login);
            create index if not exists signal_message_message_uid_idx on signal_message(message_uid);
            create table if not exists signal_message_metadata (
                id bigserial not null primary key,
                message_uid text not null,
                instance_id text not null,
                dmr_sender_id text null,
                dmr_call_group_id text null,
                dmr_color_code text null
            );
            create index if not exists signal_message_metadata_message_uid_idx on signal_message_metadata(message_uid);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table datasource drop constraint datasource_api_login_uniq;
            drop index signal_message_message_uid_idx;
            drop table if exists signal_message_metadata;
            "#,
        )
        .await?;
        Ok(())
    }
}

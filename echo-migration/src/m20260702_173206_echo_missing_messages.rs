use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table system_settings
                    add column if not exists autofix_echoim_missing_messages boolean not null default false;

                alter table system_settings
                    add column if not exists echo_im_sync_since_inbox_message_id integer not null default 0;

                do $$
                begin
                    if not exists (
                        select 1 from pg_type where typname = 'echo_missing_message_status'
                    ) then
                        create type echo_missing_message_status as enum (
                            'pending',
                            'scheduled',
                            'error',
                            'resolved'
                        );
                    end if;
                end
                $$;

                create table if not exists echo_missing_message (
                    id bigserial primary key,
                    message_id integer not null,
                    created_at timestamp without time zone not null default (now() at time zone 'utc'),
                    is_resolved boolean not null default false,
                    resolved_at timestamp without time zone,
                    scheduled_by text,
                    status echo_missing_message_status not null default 'pending',
                    error text
                );

                create unique index if not exists echo_missing_message_message_id_uidx
                    on echo_missing_message (message_id);

                create index if not exists echo_missing_message_status_idx
                    on echo_missing_message (status);

                create index if not exists echo_missing_message_unresolved_idx
                    on echo_missing_message (created_at, id)
                    where is_resolved = false;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists echo_missing_message_unresolved_idx;
                drop index if exists echo_missing_message_status_idx;
                drop index if exists echo_missing_message_message_id_uidx;
                drop table if exists echo_missing_message;
                drop type if exists echo_missing_message_status;

                alter table system_settings
                    drop column if exists echo_im_sync_since_inbox_message_id;

                alter table system_settings
                    drop column if exists autofix_echoim_missing_messages;
            "#,
        )
        .await?;
        Ok(())
    }
}

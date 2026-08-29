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
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                create table echo_client_settings (
                    client_id integer primary key references echo_client(id) on delete cascade,
                    hide_private boolean not null default false,
                    hide_groups boolean not null default false,
                    private_webhook_url text,
                    group_webhook_url text,
                    store_data_30_days boolean not null default false,
                    created_at timestamp without time zone not null default (now() at time zone 'utc'),
                    updated_at timestamp without time zone not null default (now() at time zone 'utc')
                );

                create table echo_chat_filter (
                    id bigserial primary key,
                    client_id integer not null references echo_client(id) on delete cascade,
                    account_id integer not null references echo_account(id) on delete cascade,
                    chat_kind text not null check (chat_kind in ('private', 'group')),
                    participant_key text,
                    group_id integer references echo_group(id) on delete cascade,
                    created_at timestamp without time zone not null default (now() at time zone 'utc'),
                    check (
                        (chat_kind = 'private' and participant_key is not null and group_id is null)
                        or (chat_kind = 'group' and participant_key is null and group_id is not null)
                    )
                );

                create unique index echo_chat_filter_private_uq
                    on echo_chat_filter (client_id, account_id, participant_key)
                    where chat_kind = 'private';
                create unique index echo_chat_filter_group_uq
                    on echo_chat_filter (client_id, account_id, group_id)
                    where chat_kind = 'group';

                create table echo_chat_ingestion_state (
                    client_id integer not null references echo_client(id) on delete cascade,
                    account_id integer not null references echo_account(id) on delete cascade,
                    linked_at timestamp without time zone,
                    last_inbox_message_id integer not null,
                    updated_at timestamp without time zone not null default (now() at time zone 'utc'),
                    primary key (client_id, account_id)
                );

                create table echo_chat_webhook_delivery (
                    id bigserial primary key,
                    event_id text not null unique,
                    client_id integer not null references echo_client(id) on delete cascade,
                    inbox_message_id integer not null,
                    endpoint_url text not null,
                    payload jsonb not null,
                    attempts integer not null default 0,
                    next_attempt_at timestamp without time zone not null default (now() at time zone 'utc'),
                    delivered_at timestamp without time zone,
                    failed_at timestamp without time zone,
                    last_error text,
                    created_at timestamp without time zone not null default (now() at time zone 'utc'),
                    updated_at timestamp without time zone not null default (now() at time zone 'utc'),
                    unique (client_id, inbox_message_id),
                    check (attempts >= 0),
                    check (delivered_at is null or failed_at is null)
                );
                create index echo_chat_webhook_delivery_pending_idx
                    on echo_chat_webhook_delivery (next_attempt_at, id)
                    where delivered_at is null and failed_at is null;
                create index echo_chat_webhook_delivery_terminal_idx
                    on echo_chat_webhook_delivery (
                        (coalesce(delivered_at, failed_at)), id
                    )
                    where delivered_at is not null or failed_at is not null;

                create index echo_chat_inbox_ingestion_idx
                    on echo_inbox_message (client_id, account_id, id);

                insert into echo_chat_ingestion_state (
                    client_id, account_id, linked_at, last_inbox_message_id
                )
                select c.id, a.id, a.linked_at, coalesce(latest.id, 0)
                from echo_client c
                join echo_client_lock l
                    on l.client_id = c.id and not l.remove_requested
                join echo_account a on a.id = l.account_id and a.is_linked
                left join lateral (
                    select m.id
                    from echo_inbox_message m
                    where m.client_id = c.id and m.account_id = a.id
                    order by m.id desc
                    limit 1
                ) latest on true
                where not c.deleted and c.show_chats_admin_panel = true;

                create index echo_chat_inbox_group_history_idx
                    on echo_inbox_message (
                        client_id, account_id, group_id,
                        (coalesce(timestamp, created_at)) desc, id desc
                    )
                    where deleted = false and group_id is not null;
                create index echo_chat_inbox_private_history_idx
                    on echo_inbox_message (
                        client_id, account_id, sender_id,
                        (coalesce(timestamp, created_at)) desc, id desc
                    )
                    where deleted = false and group_id is null;
                create index echo_chat_outbox_instance_group_history_idx
                    on echo_outbox_message_instance (
                        account_id, group_id,
                        (coalesce(sent_at, created_at)) desc, id desc
                    )
                    where group_id is not null;
                create index echo_chat_outbox_instance_private_history_idx
                    on echo_outbox_message_instance (
                        account_id, recipient_id,
                        (coalesce(sent_at, created_at)) desc, id desc
                    )
                    where recipient_id is not null;
                create index echo_chat_outbox_instance_reply_history_idx
                    on echo_outbox_message_instance (
                        account_id, reply_to_inbox_message_id,
                        (coalesce(sent_at, created_at)) desc, id desc
                    )
                    where reply_to_inbox_message_id is not null;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop index if exists echo_chat_outbox_instance_reply_history_idx;
                drop index if exists echo_chat_outbox_instance_private_history_idx;
                drop index if exists echo_chat_outbox_instance_group_history_idx;
                drop index if exists echo_chat_inbox_private_history_idx;
                drop index if exists echo_chat_inbox_group_history_idx;
                drop index if exists echo_chat_inbox_ingestion_idx;
                drop table if exists echo_chat_webhook_delivery;
                drop table if exists echo_chat_ingestion_state;
                drop table if exists echo_chat_filter;
                drop table if exists echo_client_settings;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

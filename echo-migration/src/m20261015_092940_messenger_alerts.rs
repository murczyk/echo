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
        manager.get_connection().execute_unprepared(r#"
alter table login add column signal_profile_id text references signal_profile(uuid) on delete set null;
alter table datasource add column can_read_messages boolean;
alter table datasource add column can_send_messages boolean;
alter table user_settings add column receive_alerts_in_messenger boolean;
create index signal_profile_name_prefix_idx on signal_profile
    (lower(coalesce(given_name, '') || ' ' || coalesce(family_name, '')) text_pattern_ops);
create index signal_profile_uuid_prefix_idx on signal_profile (uuid text_pattern_ops);

create table messenger_alert_settings (
    id smallint primary key check (id = 1),
    enabled boolean not null default false,
    sender_datasource_ids bigint[] not null default '{}'
);
insert into messenger_alert_settings (id) values (1);

create table messenger_alert_delivery (
    id uuid primary key,
    receipt_id uuid not null unique references notification_receipt(id) on delete restrict,
    recipient_login_id uuid not null references login(id) on delete restrict,
    recipient_profile_id text not null,
    message_url text not null,
    status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
    sender_datasource_id bigint references datasource(id) on delete set null,
    outbox_instance_id integer,
    attempted_sender_ids bigint[] not null default '{}',
    error text,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    next_attempt_at timestamp not null default now(),
    sent_at timestamp
);
create index messenger_alert_delivery_pending_idx
    on messenger_alert_delivery (next_attempt_at, id) where status in ('queued', 'sending');
        "#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
drop table messenger_alert_delivery;
drop table messenger_alert_settings;
drop index signal_profile_name_prefix_idx;
drop index signal_profile_uuid_prefix_idx;
alter table user_settings drop column receive_alerts_in_messenger;
alter table datasource drop column can_send_messages, drop column can_read_messages;
alter table login drop column signal_profile_id;
        "#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", line!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table notification_event (
    id uuid primary key,
    operation_id uuid not null unique,
    actor_login_id uuid not null references login(id) on delete restrict,
    signal_message_id bigint not null references signal_message(id) on delete cascade,
    sigint_important_id bigint not null unique references sigint_important(id) on delete cascade,
    signal_message_uuid uuid,
    group_master_key text not null,
    actor_login_snapshot text,
    group_name_snapshot text,
    created_at timestamp not null default now()
);
create index notification_event_message_group_idx
    on notification_event (signal_message_id, group_master_key);
create table importance_operation (
    operation_id uuid primary key,
    actor_login_id uuid not null references login(id) on delete restrict,
    signal_message_id bigint not null references signal_message(id) on delete cascade,
    notify_group boolean not null,
    group_master_key text,
    result_important boolean,
    created_at timestamp not null default now(),
    check (
        (notify_group and group_master_key is not null)
        or (not notify_group and group_master_key is null)
    )
);
with duplicate_importants as (
    select id,
           row_number() over (
               partition by login_id, signal_message_id
               order by created_at, id
           ) as position
    from sigint_important
    where deleted = false and login_id is not null
)
update sigint_important
set deleted = true
where id in (
    select id from duplicate_importants where position > 1
);
create unique index sigint_important_live_login_message_idx
    on sigint_important (login_id, signal_message_id)
    where deleted = false and login_id is not null;

create table notification_receipt (
    id uuid primary key,
    event_id uuid not null references notification_event(id) on delete restrict,
    recipient_login_id uuid not null references login(id) on delete restrict,
    read_at timestamp,
    created_at timestamp not null default now(),
    unique (event_id, recipient_login_id)
);
create index notification_receipt_recipient_created_idx
    on notification_receipt (recipient_login_id, created_at desc, event_id desc);
create index notification_receipt_recipient_unread_idx
    on notification_receipt (recipient_login_id, id) where read_at is null;

create table notification_read_boundary (
    id uuid primary key,
    recipient_login_id uuid not null references login(id) on delete cascade,
    panel_id uuid not null,
    created_at timestamp not null default now()
);
create unique index notification_read_boundary_recipient_panel_idx
    on notification_read_boundary (recipient_login_id, panel_id);
create index notification_read_boundary_created_at_idx
    on notification_read_boundary (created_at);
create table notification_read_boundary_receipt (
    boundary_id uuid not null references notification_read_boundary(id) on delete cascade,
    receipt_id uuid not null references notification_receipt(id) on delete cascade,
    primary key (boundary_id, receipt_id)
);
create table notification_read_boundary_completed (
    boundary_id uuid primary key,
    recipient_login_id uuid not null references login(id) on delete cascade,
    unread_count bigint not null,
    receipt_ids uuid[] not null,
    created_at timestamp not null default now()
);
create index notification_read_boundary_completed_created_at_idx
    on notification_read_boundary_completed (created_at);
"#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table if exists notification_read_boundary_receipt;
drop table if exists notification_read_boundary_completed;
drop table if exists notification_read_boundary;
drop table if exists notification_receipt;
drop table if exists notification_event;
drop table if exists importance_operation;
drop index if exists sigint_important_live_login_message_idx;
"#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

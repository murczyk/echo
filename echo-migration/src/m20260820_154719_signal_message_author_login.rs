use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table signal_message
    add column login_id uuid;

alter table signal_message_group
    add column login_id uuid;

update signal_message
set login_id = login.id
from login
where signal_message.sender = login.id::text;

update signal_message_group group_link
set login_id = login.id
from login
where group_link.sender = login.id::text;

update signal_message_group
set sender = null
where login_id is not null;

update signal_message
set sender = null
where login_id is not null;

alter table signal_message
    add constraint signal_message_login_id_fk
    foreign key (login_id) references login(id) on delete set null;

create index signal_message_login_id_idx
    on signal_message (login_id)
    where login_id is not null;

alter table signal_message_group
    add constraint signal_message_group_login_id_fk
    foreign key (login_id) references login(id) on delete set null;

create index signal_message_group_login_id_idx
    on signal_message_group (login_id)
    where login_id is not null;
                "#,
            )
            .await
            .map(|_| ())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
update signal_message
set sender = login_id::text
where sender is null
  and login_id is not null;

update signal_message_group
set sender = login_id::text
where sender is null
  and login_id is not null;

drop index if exists signal_message_login_id_idx;
drop index if exists signal_message_group_login_id_idx;

alter table signal_message
    drop constraint if exists signal_message_login_id_fk;

alter table signal_message_group
    drop constraint if exists signal_message_group_login_id_fk;

alter table signal_message
    drop column if exists login_id;

alter table signal_message_group
    drop column if exists login_id;
                "#,
            )
            .await
            .map(|_| ())
    }
}

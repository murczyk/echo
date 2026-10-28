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
                create unique index datasource_echo_native_singleton
                    on datasource (kind) where kind = 'echo_native';
                alter table datasource add constraint datasource_echo_native_configuration
                    check (kind <> 'echo_native' or (
                        enabled is true and deleted is false and status = 'active'
                        and can_read_messages is false and can_send_messages is false
                        and signal_phone is null and api_endpoint is null
                        and api_login_id is null and echo_client_lock_id is null
                        and group_master_key is null and sender_uuid is null
                        and default_aor_id is null
                    ));
                insert into datasource (
                    kind, display_name, enabled, deleted, status,
                    can_read_messages, can_send_messages
                ) values ('echo_native', 'Echo Native', true, false, 'active', false, false);
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
                do $$
                begin
                    if exists (
                        select 1 from signal_group g
                        join datasource d on d.id = g.datasource_id
                        where d.kind = 'echo_native'
                    ) or exists (
                        select 1 from datasource_group g
                        join datasource d on d.id = g.datasource_id
                        where d.kind = 'echo_native'
                    ) then
                        raise exception 'Cannot remove Echo Native while groups reference it';
                    end if;
                end $$;
                delete from datasource where kind = 'echo_native';
                alter table datasource drop constraint datasource_echo_native_configuration;
                drop index datasource_echo_native_singleton;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

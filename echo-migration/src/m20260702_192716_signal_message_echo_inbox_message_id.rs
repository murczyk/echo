use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table signal_message
                    add column if not exists echo_inbox_message_id bigint;

                update signal_message sm
                set
                    echo_inbox_message_id = sm.external_id,
                    external_id = null
                from echo_inbox_message eim
                join echo_group eg
                    on eg.id = eim.group_id
                join echo_client_lock ecl
                    on ecl.account_id = eim.account_id
                join datasource d
                    on d.echo_client_lock_id = ecl.id
                join datasource_group dg
                    on dg.datasource_id = d.id
                    and dg.group_master_key = eg.group_id
                where sm.external_id = eim.id
                    and sm.datasource_group_id = dg.id
                    and sm.echo_inbox_message_id is null
                    and replace(sm.body, E'\r\n', E'\n') = replace(eim.body, E'\r\n', E'\n')
                    and (sm.timestamp is null
                        or eim.timestamp is null
                        or sm.timestamp = eim.timestamp);

                create index if not exists signal_message_echo_inbox_message_id_idx
                    on signal_message (echo_inbox_message_id)
                    where echo_inbox_message_id is not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists signal_message_echo_inbox_message_id_idx;

                update signal_message
                set external_id = echo_inbox_message_id
                where external_id is null
                    and echo_inbox_message_id is not null;

                alter table signal_message
                    drop column if exists echo_inbox_message_id;
            "#,
        )
        .await?;
        Ok(())
    }
}

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
                    create table if not exists echo_automation_send_log (
                        id bigserial primary key,
                        automation_id bigint not null,
                        source_inbox_message_id integer not null,
                        source_internal_id text,
                        source_group_id integer not null,
                        target_group_id integer not null,
                        planned_at timestamp without time zone default (now() at time zone 'utc') not null,
                        sent_at timestamp without time zone,
                        created_at timestamp without time zone default (now() at time zone 'utc') not null
                    );

                    create unique index if not exists echo_automation_send_log_route_message_uq
                        on echo_automation_send_log (
                            source_group_id,
                            target_group_id,
                            source_inbox_message_id
                        );

                    create unique index if not exists echo_automation_send_log_route_internal_uq
                        on echo_automation_send_log (
                            source_group_id,
                            target_group_id,
                            source_internal_id
                        )
                        where source_internal_id is not null;

                    create index if not exists echo_automation_send_log_created_at_idx
                        on echo_automation_send_log (created_at desc);

                    do $migration$
                    begin
                        if to_regclass('public.echo_automation_delivery') is not null
                            and to_regclass('public.echo_automation') is not null
                            and to_regclass('public.echo_inbox_message') is not null
                            and exists (
                                select 1
                                from pg_attribute
                                where attrelid = to_regclass('public.echo_automation_delivery')
                                    and attname = 'created_at'
                                    and not attisdropped
                            )
                        then
                            execute $backfill$
                                insert into echo_automation_send_log (
                                    automation_id,
                                    source_inbox_message_id,
                                    source_internal_id,
                                    source_group_id,
                                    target_group_id,
                                    planned_at,
                                    sent_at,
                                    created_at
                                )
                                select
                                    delivery.automation_id,
                                    delivery.source_inbox_message_id,
                                    message.internal_id,
                                    automation.source_group_id,
                                    automation.target_group_id,
                                    delivery.created_at,
                                    delivery.sent_at,
                                    delivery.sent_at
                                from echo_automation_delivery delivery
                                join echo_automation automation
                                    on automation.id = delivery.automation_id
                                join echo_inbox_message message
                                    on message.id = delivery.source_inbox_message_id
                                where delivery.status = 'sent'
                                    and delivery.sent_at >= (now() at time zone 'utc') - interval '30 days'
                                order by delivery.sent_at, delivery.id
                                on conflict do nothing
                            $backfill$;
                        end if;
                    end
                    $migration$;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    drop table if exists echo_automation_send_log;
                "#,
            )
            .await?;
        Ok(())
    }
}

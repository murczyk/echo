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
                create type network_recalculation_task_kind as enum (
                    'network_freq_last_seen',
                    'network_freq_last_datetime_in_aor'
                );

                create table network_recalculation_task (
                    id bigserial primary key,
                    task_kind network_recalculation_task_kind not null,
                    network_freq_id bigint not null references sigint_network_freq(id) on delete cascade,
                    login_id uuid references login(id) on delete cascade,
                    started_at timestamp without time zone,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    constraint network_recalculation_task_login_check check (
                        (task_kind = 'network_freq_last_seen' and login_id is null)
                        or
                        (task_kind = 'network_freq_last_datetime_in_aor' and login_id is not null)
                    )
                );

                create unique index network_recalculation_task_pending_unique_idx
                    on network_recalculation_task (
                        task_kind,
                        network_freq_id,
                        coalesce(login_id, '00000000-0000-0000-0000-000000000000'::uuid)
                    )
                    where started_at is null;

                create index network_recalculation_task_pickup_idx
                    on network_recalculation_task (created_at, id)
                    where started_at is null;

                create index network_recalculation_task_stale_idx
                    on network_recalculation_task (started_at)
                    where started_at is not null;

                create table network_freq_last_datetime_in_aor (
                    network_freq_id bigint not null references sigint_network_freq(id) on delete cascade,
                    login_id uuid not null references login(id) on delete cascade,
                    last_datetime_in_aor timestamp without time zone,
                    calculated_at timestamp without time zone not null,
                    primary key (network_freq_id, login_id)
                );

                create index network_freq_last_datetime_in_aor_login_idx
                    on network_freq_last_datetime_in_aor (login_id, network_freq_id);

                create index network_freq_last_datetime_in_aor_calculated_at_idx
                    on network_freq_last_datetime_in_aor (calculated_at);
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
                drop table if exists network_freq_last_datetime_in_aor;
                drop table if exists network_recalculation_task;
                drop type if exists network_recalculation_task_kind;
                "#,
            )
            .await?;
        Ok(())
    }
}

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
create table sigint_activity_decision_changelog (
    id bigserial primary key,
    target_kind text not null check (target_kind in ('network', 'frequency')),
    network_id bigint not null references sigint_network(id),
    network_freq_id bigint references sigint_network_freq(id),
    freq text,
    decision text not null check (decision in ('activate', 'deactivate')),
    actor_kind text not null check (actor_kind in ('user', 'worker', 'import', 'merge', 'system')),
    actor_login_id uuid references login(id),
    worker_name text,
    reason text not null,
    old_active_from timestamp without time zone,
    old_active_to timestamp without time zone,
    new_active_from timestamp without time zone,
    new_active_to timestamp without time zone,
    lookback_since timestamp without time zone,
    lookback_till timestamp without time zone,
    interception_count bigint,
    threshold_count bigint,
    last_interception_at timestamp without time zone,
    metadata jsonb,
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    check (
        (target_kind = 'network' and network_freq_id is null and freq is null)
        or
        (target_kind = 'frequency' and network_freq_id is not null and freq is not null)
    ),
    check (
        (decision = 'activate' and old_active_to is not null and new_active_to is null)
        or
        (decision = 'deactivate' and old_active_to is null and new_active_to is not null)
    )
);

create index sigint_activity_decision_changelog_network_created_idx
    on sigint_activity_decision_changelog (network_id, created_at desc, id desc);
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
                "drop table sigint_activity_decision_changelog;",
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

/// Message replay session state, plus indexes on the remaining unindexed
/// foreign keys to `signal_message`, so hard-deleting replayed messages does
/// not sequentially scan those tables once per deleted row.
///
/// Runs without a transaction because of `create index concurrently`, which
/// also cannot share a multi-statement query (an implicit transaction), so
/// each concurrent index is executed separately.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
create table if not exists message_replay_session (
    id bigserial primary key,
    state text not null check (state in ('running', 'paused', 'stopping')),
    on_end text not null check (on_end in ('loop', 'pause')),
    window_from timestamp without time zone not null,
    window_to timestamp without time zone not null,
    -- Replay time mapping (UTC): source instant t is shown at
    -- anchor_at + (t - anchor_ts) * 100 / speed_pct.
    speed_pct integer not null check (speed_pct > 0),
    anchor_ts timestamp without time zone not null,
    anchor_at timestamp without time zone not null,
    paused_at timestamp without time zone,
    cursor_ts timestamp without time zone not null,
    cursor_id bigint not null default 0,
    replayed_count bigint not null default 0,
    completed_cycles bigint not null default 0,
    -- Sources to replay in the current cycle (counted at start and rewind)
    -- and those already passed by the cursor, so status polls need no count.
    cycle_source_count bigint not null default 0,
    cycle_processed_count bigint not null default 0,
    created_by_login_id uuid not null references login(id),
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    check (window_from < window_to)
);

create unique index if not exists message_replay_session_singleton_idx
    on message_replay_session ((true));

drop index if exists sigint_comment_rer_duty_test_replay_idx;
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        db.execute_unprepared(
            r#"
create index concurrently if not exists importance_operation_signal_message_id_idx
    on importance_operation (signal_message_id);
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        db.execute_unprepared(
            r#"
create index concurrently if not exists signal_message_media_conversion_job_signal_message_id_idx
    on signal_message_media_conversion_job (signal_message_id);
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        db.execute_unprepared(
            r#"
create index concurrently if not exists device_audio_forwarding_delivery_signal_message_id_idx
    on device_audio_forwarding_delivery (signal_message_id);
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
drop index concurrently if exists device_audio_forwarding_delivery_signal_message_id_idx;
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        db.execute_unprepared(
            r#"
drop index concurrently if exists signal_message_media_conversion_job_signal_message_id_idx;
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        db.execute_unprepared(
            r#"
drop index concurrently if exists importance_operation_signal_message_id_idx;
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        db.execute_unprepared(
            r#"
drop table if exists message_replay_session;

create index if not exists sigint_comment_rer_duty_test_replay_idx
    on sigint_comment (created_at desc, signal_message_id)
    where comment = '[duplicate]';
            "#,
        )
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}

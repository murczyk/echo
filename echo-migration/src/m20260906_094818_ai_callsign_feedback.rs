use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table ai_callsign_feedback (
    id bigserial primary key,
    action_id uuid not null,
    callsign text not null check (callsign <> ''),
    inbox_item_id bigint references sigint_inbox_item(id) on delete set null,
    inbox_item_uuid uuid,
    actor_id uuid references login(id) on delete set null,
    body text not null,
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    unique (action_id, callsign)
);
create index ai_callsign_feedback_lookup_idx on ai_callsign_feedback (callsign, id desc);
create index ai_callsign_feedback_message_idx on ai_callsign_feedback (inbox_item_id) where inbox_item_id is not null;
create table ai_callsign_feedback_summary (
    callsign text primary key,
    removal_count bigint not null,
    scheduled_count bigint not null default 0,
    updated_at timestamp without time zone not null default (now() at time zone 'utc')
);
create index ai_callsign_feedback_prefix_idx on ai_callsign_feedback_summary (callsign text_pattern_ops);
create index ai_callsign_feedback_pending_idx on ai_callsign_feedback_summary (callsign) where removal_count > scheduled_count;
create table ai_callsign_override (
    inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
    callsign text not null,
    included boolean not null,
    actor_id uuid not null references login(id),
    action_id uuid not null,
    primary key (inbox_item_id, callsign)
);
create table ai_callsign_action (
    id uuid primary key,
    actor_id uuid not null references login(id),
    inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade
);
create index ai_callsign_action_message_idx on ai_callsign_action (inbox_item_id);
create table ai_callsign_reparse_run (
    id uuid primary key,
    actor_id uuid references login(id) on delete set null,
    automatic boolean not null,
    state text not null check (state in ('enumerating', 'running', 'completed', 'failed', 'cancelled')),
    since_ts timestamp without time zone not null,
    until_ts timestamp without time zone not null,
    cursor_callsign text not null default '',
    cursor_item_id bigint not null default 0,
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    cleanup_complete boolean not null default false,
    total bigint not null default 0,
    changed bigint not null default 0,
    unchanged bigint not null default 0,
    skipped bigint not null default 0,
    failed bigint not null default 0,
    completed_at timestamp without time zone
);
create unique index ai_callsign_reparse_active_idx on ai_callsign_reparse_run ((true))
    where state in ('enumerating', 'running');
create index ai_callsign_reparse_history_idx on ai_callsign_reparse_run (created_at desc);
create index ai_callsign_reparse_cleanup_idx on ai_callsign_reparse_run (created_at) where state in ('completed', 'failed') and not cleanup_complete;
create table ai_callsign_reparse_target (
    run_id uuid not null references ai_callsign_reparse_run(id) on delete cascade,
    callsign text not null,
    removal_count bigint not null,
    primary key (run_id, callsign)
);
create table ai_callsign_reparse_job (
    run_id uuid not null references ai_callsign_reparse_run(id) on delete cascade,
    inbox_item_id bigint not null,
    state text not null default 'pending' check (state in ('pending', 'changed', 'unchanged', 'skipped', 'failed')),
    attempts integer not null default 0,
    next_attempt_at timestamp without time zone not null default (now() at time zone 'utc'),
    last_error text,
    primary key (run_id, inbox_item_id)
);
create index ai_callsign_reparse_job_success_idx on ai_callsign_reparse_job (run_id, inbox_item_id) where state in ('changed', 'unchanged', 'skipped');
create index ai_callsign_reparse_job_pending_idx on ai_callsign_reparse_job (run_id, next_attempt_at, inbox_item_id) where state = 'pending';
"#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table ai_callsign_reparse_job;
drop table ai_callsign_reparse_target;
drop table ai_callsign_reparse_run;
drop table ai_callsign_action;
drop table ai_callsign_override;
drop table ai_callsign_feedback_summary;
drop table ai_callsign_feedback;
"#,
            )
            .await?;
        Ok(())
    }
}

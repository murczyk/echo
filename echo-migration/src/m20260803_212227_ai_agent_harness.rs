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
create table ai_agent_settings (
    id smallint primary key check (id = 1),
    feature_enabled boolean default false not null,
    template_login_id uuid references login(id) on delete restrict,
    default_ai_engine_id uuid references ai_engine(id) on delete set null,
    reviewer_ai_engine_id uuid references ai_engine(id) on delete set null,
    security_review_enabled boolean default true not null,
    mattermost_webhook_url text,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

insert into ai_agent_settings (id) values (1);

create table ai_agent_allowed_engine (
    ai_engine_id uuid primary key references ai_engine(id) on delete cascade,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_agent_echo_proxy (
    id uuid primary key,
    hostname text not null unique,
    upstream_host text not null,
    upstream_port integer not null check (upstream_port between 1 and 65535),
    enabled boolean default true not null,
    last_tested_at timestamp without time zone,
    last_test_error text,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_agent_user_link (
    id uuid primary key,
    human_login_id uuid not null unique references login(id) on delete restrict,
    agent_login_id uuid not null unique references login(id) on delete restrict,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_agent_container (
    ai_agent_user_link_id uuid primary key references ai_agent_user_link(id) on delete cascade,
    instance_name text not null unique,
    state text not null check (state in ('absent', 'creating', 'stopped', 'starting', 'running', 'stopping', 'error')),
    last_error text,
    stats jsonb,
    started_at timestamp without time zone,
    stopped_at timestamp without time zone,
    last_activity_at timestamp without time zone,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create index ai_agent_container_state_activity_idx
    on ai_agent_container (state, last_activity_at);

create table ai_agent_conversation (
    id uuid primary key,
    human_login_id uuid not null references login(id) on delete restrict,
    ai_engine_id uuid not null references ai_engine(id) on delete restrict,
    title text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    deleted_at timestamp without time zone
);

create index ai_agent_conversation_login_updated_idx
    on ai_agent_conversation (human_login_id, updated_at desc)
    where deleted_at is null;

create table ai_agent_request (
    id uuid primary key,
    conversation_id uuid not null references ai_agent_conversation(id) on delete restrict,
    human_login_id uuid not null references login(id) on delete restrict,
    agent_login_id uuid references login(id) on delete restrict,
    ai_engine_id uuid not null references ai_engine(id) on delete restrict,
    prompt text not null,
    response text,
    state text not null check (state in ('queued', 'running', 'completed', 'failed', 'cancelled')),
    cancellation_requested boolean default false not null,
    error text,
    correlation_id uuid,
    queued_at timestamp without time zone default (now() at time zone 'utc') not null,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create unique index ai_agent_request_one_running_per_user_idx
    on ai_agent_request (human_login_id)
    where state = 'running';

create index ai_agent_request_queue_idx
    on ai_agent_request (queued_at, id)
    where state = 'queued';

create index ai_agent_request_conversation_idx
    on ai_agent_request (conversation_id, queued_at, id);

create index ai_agent_request_admin_idx
    on ai_agent_request (state, queued_at desc);

create table ai_agent_request_event (
    request_id uuid not null references ai_agent_request(id) on delete cascade,
    sequence bigint not null check (sequence > 0),
    event_type text not null check (event_type in (
        'request_start', 'progress', 'assistant_delta', 'tool_start',
        'tool_update', 'tool_end', 'source', 'completion',
        'cancellation', 'error'
    )),
    payload jsonb not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    primary key (request_id, sequence)
);

create table ai_agent_security_review (
    request_id uuid primary key references ai_agent_request(id) on delete cascade,
    reviewer_ai_engine_id uuid references ai_engine(id) on delete set null,
    state text not null check (state in ('pending', 'safe', 'suspicious', 'failed')),
    suspicious boolean,
    severity text check (severity in ('low', 'medium', 'high', 'critical')),
    categories jsonb not null default '[]'::jsonb,
    summary text,
    attempt_count integer default 0 not null,
    next_attempt_at timestamp without time zone default (now() at time zone 'utc') not null,
    last_error text,
    alert_state text check (alert_state in ('pending', 'sent', 'failed')),
    alert_attempt_count integer default 0 not null,
    alert_next_attempt_at timestamp without time zone,
    alert_last_error text,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create index ai_agent_security_review_pending_idx
    on ai_agent_security_review (next_attempt_at, request_id)
    where state in ('pending', 'failed');

create index ai_agent_security_alert_pending_idx
    on ai_agent_security_review (alert_next_attempt_at, request_id)
    where state = 'suspicious' and alert_state in ('pending', 'failed');
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
drop table if exists ai_agent_security_review;
drop table if exists ai_agent_request_event;
drop table if exists ai_agent_request;
drop table if exists ai_agent_conversation;
drop table if exists ai_agent_container;
drop table if exists ai_agent_user_link;
drop table if exists ai_agent_echo_proxy;
drop table if exists ai_agent_allowed_engine;
drop table if exists ai_agent_settings;
                "#,
            )
            .await?;
        Ok(())
    }
}

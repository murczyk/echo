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
create table ai_position_settings (
    id smallint primary key check (id = 1),
    prompt text not null,
    worker_enabled boolean default false not null,
    worker_ai_engine_id uuid references ai_engine(id) on delete set null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_position_worker_job (
    id bigserial primary key,
    sigint_inbox_item_id bigint
        references sigint_inbox_item(id) on delete cascade,
    media_id uuid references signal_message_media(id) on delete cascade,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    check ((sigint_inbox_item_id is null) <> (media_id is null))
);

create unique index ai_position_worker_job_item_idx
    on ai_position_worker_job (sigint_inbox_item_id)
    where sigint_inbox_item_id is not null;

create unique index ai_position_worker_job_media_idx
    on ai_position_worker_job (media_id)
    where media_id is not null;

create index ai_position_worker_job_next_attempt_idx
    on ai_position_worker_job (next_attempt_at, created_at, id);

create table ai_position_mention (
    id bigserial primary key,
    sigint_inbox_item_id bigint
        references sigint_inbox_item(id) on delete cascade,
    media_id uuid references signal_message_media(id) on delete cascade,
    name text not null,
    name_key text not null,
    begin_char integer not null,
    end_char integer not null,
    message_at timestamp without time zone not null,
    group_master_key text,
    group_is_secret boolean default false not null,
    aor_ids bigint[] default '{}' not null,
    ai_engine_id uuid references ai_engine(id) on delete set null,
    model_name text not null,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    check ((sigint_inbox_item_id is null) <> (media_id is null)),
    check (begin_char >= 0 and end_char > begin_char)
);

create index ai_position_mention_item_idx
    on ai_position_mention (sigint_inbox_item_id)
    where sigint_inbox_item_id is not null;

create index ai_position_mention_media_idx
    on ai_position_mention (media_id)
    where media_id is not null;

create index ai_position_mention_name_key_idx
    on ai_position_mention (name_key, message_at desc);

create index ai_position_mention_message_at_idx
    on ai_position_mention (message_at desc, id desc);

create table ai_position_coordinate (
    id bigserial primary key,
    mention_id bigint not null
        references ai_position_mention(id) on delete cascade,
    coordinate_text text not null,
    coordinate_system text not null
        check (coordinate_system in ('mgrs', 'sk42', 'usk2000', 'wgs84')),
    mgrs text not null,
    lat double precision not null,
    lng double precision not null,
    certainty text not null check (certainty in ('high', 'medium', 'low')),
    evidence text not null,
    coord_begin_char integer,
    coord_end_char integer,
    message_at timestamp without time zone not null,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

create index ai_position_coordinate_mention_idx
    on ai_position_coordinate (mention_id);

create index ai_position_mention_group_idx
    on ai_position_mention (group_master_key, name_key);

create index ai_position_mention_aor_idx
    on ai_position_mention using gin (aor_ids);

-- Where a position is, per scope: an area of responsibility (facts from its
-- non-private groups) or a single group (private groups never leave it).
create table ai_position_knowledge (
    id bigserial primary key,
    scope_kind text not null check (scope_kind in ('aor', 'group')),
    scope_key text not null,
    name_key text not null,
    name text not null,
    mgrs text not null,
    lat double precision not null,
    lng double precision not null,
    certainty text not null check (certainty in ('high', 'medium', 'low')),
    fact_count integer not null,
    conflicting boolean not null,
    first_fact_at timestamp without time zone not null,
    last_fact_at timestamp without time zone not null,
    source_group_keys text[] not null,
    updated_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    unique (scope_kind, scope_key, name_key)
);

create index ai_position_knowledge_last_fact_idx
    on ai_position_knowledge (last_fact_at desc, id desc);

create table ai_position_knowledge_job (
    scope_kind text not null check (scope_kind in ('aor', 'group')),
    scope_key text not null,
    name_key text not null,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    primary key (scope_kind, scope_key, name_key)
);

create index ai_position_knowledge_job_next_attempt_idx
    on ai_position_knowledge_job (next_attempt_at, created_at);
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
drop table if exists ai_position_knowledge_job;
drop table if exists ai_position_knowledge;
drop table if exists ai_position_coordinate;
drop table if exists ai_position_mention;
drop table if exists ai_position_worker_job;
drop table if exists ai_position_settings;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

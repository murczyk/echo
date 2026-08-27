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
create table ai_agent_engine_runtime_profile (
    ai_engine_id uuid primary key references ai_engine(id) on delete cascade,
    context_window_tokens integer not null check (
        context_window_tokens between 4096 and 2000000
    ),
    max_output_tokens integer not null check (
        max_output_tokens between 256 and 131072
        and max_output_tokens + 1024 < context_window_tokens
    ),
    compaction_reserve_tokens integer not null check (
        compaction_reserve_tokens >= max_output_tokens
        and compaction_reserve_tokens < context_window_tokens
    ),
    compaction_keep_recent_tokens integer not null check (
        compaction_keep_recent_tokens >= 1024
        and compaction_keep_recent_tokens + compaction_reserve_tokens
            < context_window_tokens
    ),
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

insert into ai_agent_engine_runtime_profile (
    ai_engine_id,
    context_window_tokens,
    max_output_tokens,
    compaction_reserve_tokens,
    compaction_keep_recent_tokens
)
select
    id,
    1050000,
    65536,
    98304,
    49152
from ai_engine
where lower(model_name) = 'gpt-5.6-sol';

insert into ai_agent_engine_runtime_profile (
    ai_engine_id,
    context_window_tokens,
    max_output_tokens,
    compaction_reserve_tokens,
    compaction_keep_recent_tokens
)
select
    id,
    1050000,
    32768,
    65536,
    32768
from ai_engine
where lower(model_name) = 'gpt-5.6-luna';

insert into ai_agent_engine_runtime_profile (
    ai_engine_id,
    context_window_tokens,
    max_output_tokens,
    compaction_reserve_tokens,
    compaction_keep_recent_tokens
)
select
    id,
    262144,
    16384,
    32768,
    16384
from ai_engine
where lower(model_name) = 'google/gemma-4-26b-a4b-it';
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
drop table if exists ai_agent_engine_runtime_profile;
                "#,
            )
            .await?;
        Ok(())
    }
}

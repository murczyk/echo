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
-- Reviewer verdicts on extracted mentions and consolidated locations. Each
-- row snapshots the case (text, span, coordinates, model) so it survives
-- reparsing and can be exported to the evaluation set.
create table ai_position_feedback (
    id uuid primary key,
    target_kind text not null check (target_kind in ('mention', 'knowledge')),
    mention_id uuid references ai_position_mention(id) on delete set null,
    scope_kind text check (scope_kind in ('aor', 'group')),
    scope_key text,
    sigint_inbox_item_id bigint,
    media_id uuid,
    group_master_key text,
    name text not null,
    name_key text not null,
    source_text text,
    begin_char integer,
    end_char integer,
    coordinates jsonb not null default '[]'::jsonb,
    known_location jsonb,
    model_name text,
    verdict text not null check (verdict in (
        'correct', 'not_position', 'wrong_name', 'wrong_coordinates', 'missed', 'other'
    )),
    expected text not null default '',
    comment text not null default '',
    created_by_id uuid references login(id) on delete set null,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    reparsed_at timestamp without time zone,
    check (
        (target_kind = 'mention' and scope_kind is null)
        or (target_kind = 'knowledge' and scope_kind is not null and scope_key is not null)
    )
);

do $$
declare
    id_generator text;
begin
    if to_regprocedure('uuidv7()') is not null then
        id_generator := 'uuidv7()';
    elsif to_regprocedure('uuid_generate_v7()') is not null then
        id_generator := 'uuid_generate_v7()';
    else
        raise exception 'UUIDv7 generator is unavailable: use PostgreSQL 18+ or enable the pg_uuidv7 extension';
    end if;
    execute format('alter table ai_position_feedback alter column id set default %s', id_generator);
end
$$;

create index ai_position_feedback_created_idx
    on ai_position_feedback (created_at desc, id desc);

create index ai_position_feedback_mention_idx
    on ai_position_feedback (mention_id)
    where mention_id is not null;

create index ai_position_feedback_position_idx
    on ai_position_feedback (name_key, scope_kind, scope_key);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop table if exists ai_position_feedback;")
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

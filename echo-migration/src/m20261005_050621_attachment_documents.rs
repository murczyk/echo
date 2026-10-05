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
create table attachment_settings (
 id smallint primary key check(id=1),
 enabled boolean not null default false,
 positions_enabled boolean not null default false,
 summaries_enabled boolean not null default true,
 ai_engine_id uuid references ai_engine(id) on delete set null,
 position_engine_id uuid references ai_engine(id) on delete set null,
 backfill_cursor uuid,
 backfill_complete boolean not null default false
);
insert into attachment_settings(id) values(1);
create table attachment_document (
 media_id uuid primary key references signal_message_media(id) on delete cascade,
 revision uuid,
 generation uuid not null default gen_random_uuid(),
 state text not null default 'queued',
 quality text,
 complete boolean not null default false,
 warnings jsonb not null default '[]',
 artifact_key text,
 summary text,
 summary_state text not null default 'queued',
 position_state text not null default 'queued',
 extractor_job_id text,
 source_digest text,
 chunk_count integer not null default 0,
 last_error text,
 created_at timestamp not null default (now() at time zone 'utc'),
 updated_at timestamp not null default (now() at time zone 'utc')
);
create index attachment_document_state_idx on attachment_document(state, updated_at, media_id);
create table attachment_chunk (
 id uuid primary key,
 media_id uuid not null references attachment_document(media_id) on delete cascade,
 revision uuid not null,
 ordinal integer not null,
 member text not null,
 locator text not null,
 text text not null,
 markdown text not null,
 html text not null,
 summary text,
 positions_done boolean not null default false,
 coordinates jsonb not null default '[]',
 search_tsv tsvector generated always as
   (to_tsvector('russian', member || ' ' || text || ' ' || coalesce(summary,''))) stored,
 unique(media_id, revision, ordinal)
);
create index attachment_chunk_search_idx on attachment_chunk using gin(search_tsv);
create index attachment_chunk_text_idx on attachment_chunk using gin(text gin_trgm_ops);
create index attachment_chunk_member_idx on attachment_chunk using gin(member gin_trgm_ops);
create index attachment_media_name_idx on signal_message_media using gin(file_name gin_trgm_ops);
create table attachment_job (
 id uuid primary key,
 media_id uuid not null references attachment_document(media_id) on delete cascade,
 generation uuid not null,
 kind text not null check(kind in ('extract','summary','positions','inspect')),
 state text not null default 'queued',
 attempts integer not null default 0,
 lease uuid,
 lease_until timestamp,
 next_attempt_at timestamp not null default (now() at time zone 'utc'),
 created_at timestamp not null default (now() at time zone 'utc'),
 updated_at timestamp not null default (now() at time zone 'utc'),
 payload jsonb not null default '{}',
 result jsonb,
 last_error text
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
 execute format('alter table attachment_chunk alter column id set default %s', id_generator);
 execute format('alter table attachment_job alter column id set default %s', id_generator);
end $$;
create index attachment_job_due_idx on attachment_job(kind,next_attempt_at,created_at,id)
 where state in ('queued','retry_wait','running');
create unique index attachment_job_generation_idx on attachment_job(media_id,generation,kind)
 where kind <> 'inspect';
alter table ai_position_mention add column attachment_chunk_id uuid references attachment_chunk(id) on delete cascade;
create index ai_position_mention_attachment_chunk_idx on ai_position_mention(attachment_chunk_id)
 where attachment_chunk_id is not null;
create function attachment_media_changed() returns trigger language plpgsql as $$
begin
 if TG_OP = 'UPDATE' and new.storage_key is not distinct from old.storage_key
   and new.size_bytes = old.size_bytes and new.content_type = old.content_type then
   return new;
 end if;
 insert into attachment_document(media_id) values(new.id)
 on conflict(media_id) do update set generation=gen_random_uuid(), revision=null,
 state='queued', summary=null, summary_state='queued', position_state='queued',
 artifact_key=null, complete=false, extractor_job_id=null, updated_at=now() at time zone 'utc';
 update attachment_job set state='superseded',lease=null,lease_until=null where media_id=new.id and state<>'completed';
 if TG_OP='UPDATE' then
   delete from ocr_job where media_id=new.id;
   delete from media_summary where media_id=new.id;
 end if;
 delete from attachment_chunk where media_id=new.id;
 insert into attachment_job(media_id,generation,kind)
 select media_id,generation,'extract' from attachment_document where media_id=new.id
 on conflict do nothing;
 return new;
end $$;
create trigger attachment_media_changed after insert or update of storage_key,size_bytes,content_type
 on signal_message_media for each row execute function attachment_media_changed();
create function attachment_ocr_changed() returns trigger language plpgsql as $$
begin
 if new.state='completed' and new.quality_status in ('accepted','degraded') then
   insert into attachment_document(media_id) values(new.media_id)
   on conflict(media_id) do update set generation=gen_random_uuid(),state='queued',
     updated_at=now() at time zone 'utc';
   update attachment_job set state='superseded',lease=null,lease_until=null where media_id=new.media_id and state<>'completed';
   insert into attachment_job(media_id,generation,kind)
   select media_id,generation,'extract' from attachment_document where media_id=new.media_id
   on conflict do nothing;
 end if;
 return new;
end $$;
create trigger attachment_ocr_changed after insert or update of completed_at on ocr_job
 for each row execute function attachment_ocr_changed();
create or replace function ai_position_media_summary_invalidate() returns trigger language plpgsql as $$
begin
 delete from ai_position_mention where media_id=new.media_id and attachment_chunk_id is null;
 return new;
end $$;
create or replace function ai_position_media_summary_deleted() returns trigger language plpgsql as $$
begin
 delete from ai_position_mention where media_id=old.media_id and attachment_chunk_id is null;
 return old;
end $$;
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
drop trigger if exists attachment_ocr_changed on ocr_job;
drop function if exists attachment_ocr_changed();
drop trigger if exists attachment_media_changed on signal_message_media;
drop function if exists attachment_media_changed();
create or replace function ai_position_media_summary_invalidate() returns trigger language plpgsql as $$
begin delete from ai_position_mention where media_id=new.media_id; return new; end $$;
create or replace function ai_position_media_summary_deleted() returns trigger language plpgsql as $$
begin delete from ai_position_mention where media_id=old.media_id; return old; end $$;
alter table ai_position_mention drop column attachment_chunk_id;
drop table attachment_job, attachment_chunk, attachment_document, attachment_settings;
drop index attachment_media_name_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

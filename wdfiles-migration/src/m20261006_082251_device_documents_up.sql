create table file_document (
    file_id uuid not null,
    revision bigint not null,
    device_id uuid not null,
    generation uuid not null,
    published_generation uuid,
    state text not null default 'queued',
    last_error text,
    created_at timestamptz not null default now(),
    primary key (file_id, revision),
    foreign key (file_id, revision) references file_content(file_id, revision) on delete cascade,
    foreign key (device_id, file_id, revision) references file_revision(device_id, id, revision) on delete cascade
);
create index file_document_device_idx on file_document(device_id, file_id, revision);
create index file_document_published_idx on file_document(published_generation) where published_generation is not null;
create table file_document_generation (
    id uuid primary key,
    file_id uuid not null,
    revision bigint not null,
    complete boolean not null,
    parser_version text not null,
    warnings jsonb not null default '[]',
    summary text,
    summary_state text not null default 'queued',
    position_state text not null default 'queued',
    search_tsv tsvector generated always as (to_tsvector('russian', coalesce(summary,''))) stored,
    created_at timestamptz not null default now(),
    foreign key (file_id, revision) references file_document(file_id, revision) on delete cascade
);
alter table file_document add foreign key (published_generation) references file_document_generation(id);
create table file_document_revision_generation (
    file_id uuid not null,
    revision bigint not null,
    generation uuid not null references file_document_generation(id) on delete cascade,
    primary key(file_id, revision, generation),
    foreign key(file_id, revision) references file_document(file_id, revision) on delete cascade
);
create index file_document_generation_search_idx on file_document_generation using gin(search_tsv);
create index file_document_generation_summary_idx on file_document_generation using gin(summary gin_trgm_ops);
create table file_document_chunk (
    id uuid primary key,
    generation uuid not null references file_document_generation(id) on delete cascade,
    ordinal integer not null,
    member text not null,
    locator text not null,
    text text not null,
    markdown text not null,
    html text not null,
    summary text,
    coordinates jsonb not null default '[]',
    positions_done boolean not null default false,
    text_tsv tsvector generated always as (to_tsvector('russian',text)) stored,
    search_tsv tsvector generated always as (to_tsvector('russian',member || ' ' || text || ' ' || coalesce(summary,''))) stored,
    unique(generation, ordinal)
);
create index file_document_chunk_search_idx on file_document_chunk using gin(search_tsv);
create index file_document_chunk_content_idx on file_document_chunk using gin(text_tsv);
create index file_document_chunk_member_idx on file_document_chunk using gin(member gin_trgm_ops);
create index file_document_chunk_text_idx on file_document_chunk using gin(text gin_trgm_ops);
create index file_document_chunk_summary_idx on file_document_chunk using gin(summary gin_trgm_ops);
create table file_document_position (
    id uuid primary key,
    chunk_id uuid not null references file_document_chunk(id) on delete cascade,
    name text not null,
    name_key text not null,
    kind text not null check(kind in ('position','crew','callsign')),
    spans jsonb not null,
    coordinates jsonb not null,
    unique(chunk_id, name_key, kind)
);
create index file_document_position_name_idx on file_document_position(name_key,kind,id);
create index file_document_position_name_trgm_idx on file_document_position using gin(name_key gin_trgm_ops);
create table file_document_job (
    id uuid primary key,
    file_id uuid not null,
    revision bigint not null,
    generation uuid not null,
    kind text not null check(kind in ('extract','summary','positions','inspect')),
    state text not null default 'queued',
    attempts integer not null default 0,
    lease uuid,
    lease_until timestamptz,
    next_attempt_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    payload jsonb not null default '{}',
    result jsonb,
    last_error text,
    foreign key(file_id,revision) references file_document(file_id,revision) on delete cascade
);
create index file_document_job_due_idx on file_document_job(kind,next_attempt_at,created_at,id)
    where state in ('queued','retry_wait','running');
create unique index file_document_job_generation_idx on file_document_job(file_id,revision,generation,kind)
    where kind <> 'inspect';
create table file_document_backfill (
    id smallint primary key check(id=1),
    cursor_file uuid,
    cursor_revision bigint,
    complete boolean not null default false,
    discovered bigint not null default 0
);
insert into file_document_backfill(id) values(1);
create function file_document_content_published() returns trigger language plpgsql as $$
declare source_device uuid; next_generation uuid;
begin
    select device_id into strict source_device from file_revision where id=new.file_id and revision=new.revision;
    next_generation := uuid_generate_v7();
    insert into file_document(file_id,revision,device_id,generation)
        values(new.file_id,new.revision,source_device,next_generation) on conflict do nothing;
    insert into file_document_job(id,file_id,revision,generation,kind)
        select uuid_generate_v7(),file_id,revision,generation,'extract'
        from file_document where file_id=new.file_id and revision=new.revision on conflict do nothing;
    return new;
end $$;
create trigger file_document_content_published after insert on file_content
    for each row execute function file_document_content_published();

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists goi_integration (
                    id bigserial primary key,
                    owner_organism_id bigint not null references organism(id) on delete cascade,
                    created_at timestamptz not null default now(),
                    integration_type text not null,
                    server_key text not null unique,
                    server_label text not null,
                    ssh_host text,
                    ssh_user text,
                    ssh_port int4 not null default 22,
                    path text not null default '/etc/goi/data/palettes',
                    api_host text,
                    api_port int4 not null default 8088,
                    api_login text,
                    api_password text
                );

                create index if not exists idx_goi_integration_owner_organism_id
                    on goi_integration (owner_organism_id);

                create table if not exists goi_integration_access_organism (
                    id bigserial primary key,
                    goi_integration_id bigint not null references goi_integration(id) on delete cascade,
                    organism_id bigint not null references organism(id) on delete cascade,
                    created_at timestamptz not null default now(),
                    unique (goi_integration_id, organism_id)
                );

                create index if not exists idx_goi_integration_access_organism_integration_id
                    on goi_integration_access_organism (goi_integration_id);

                create index if not exists idx_goi_integration_access_organism_organism_id
                    on goi_integration_access_organism (organism_id);

                create table if not exists goi_integration_access_login (
                    id bigserial primary key,
                    goi_integration_id bigint not null references goi_integration(id) on delete cascade,
                    login text not null references login(login) on delete cascade,
                    created_at timestamptz not null default now(),
                    unique (goi_integration_id, login)
                );

                create index if not exists idx_goi_integration_access_login_integration_id
                    on goi_integration_access_login (goi_integration_id);

                create index if not exists idx_goi_integration_access_login_login
                    on goi_integration_access_login (login);

                alter table goi_association
                    add column if not exists integration_id bigint references goi_integration(id) on delete cascade;

                alter table goi_knowledge
                    add column if not exists integration_id bigint references goi_integration(id) on delete cascade;

                with legacy_goi_configs as (
                    select
                        o.id as organism_id,
                        o.created_at,
                        o.name as organism_name,
                        coalesce(nullif(trim(o.goi_integration_type), ''), 'full') as integration_type,
                        nullif(trim(o.goi_ssh_host), '') as ssh_host,
                        nullif(trim(o.goi_ssh_user), '') as ssh_user,
                        case
                            when o.goi_ssh_port > 0 then o.goi_ssh_port
                            else 22
                        end as ssh_port,
                        coalesce(nullif(trim(o.goi_path), ''), '/etc/goi/data/palettes') as path,
                        nullif(trim(o.goi_api_host), '') as api_host,
                        case
                            when o.goi_api_port > 0 then o.goi_api_port
                            else 8088
                        end as api_port,
                        nullif(trim(o.goi_api_login), '') as api_login,
                        nullif(trim(o.goi_api_password), '') as api_password,
                        case
                            when nullif(trim(o.goi_api_host), '') is not null then trim(o.goi_api_host)
                            when nullif(trim(o.goi_ssh_host), '') is not null then trim(o.goi_ssh_host)
                            else o.name
                        end as server_label_base
                    from organism o
                    where o.deleted_permanently = false
                        and (
                            nullif(trim(coalesce(o.goi_api_host, '')), '') is not null
                            or nullif(trim(coalesce(o.goi_ssh_host, '')), '') is not null
                            or exists (
                                select 1
                                from goi_association ga
                                where ga.organism_id = o.id
                            )
                            or exists (
                                select 1
                                from goi_knowledge gk
                                where gk.organism_id = o.id
                            )
                        )
                ),
                legacy_goi_configs_keyed as (
                    select
                        organism_id,
                        created_at,
                        organism_name,
                        integration_type,
                        ssh_host,
                        ssh_user,
                        ssh_port,
                        path,
                        api_host,
                        api_port,
                        api_login,
                        api_password,
                        case
                            when integration_type = 'full' then concat(
                                'full|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text)),
                                '|',
                                api_port::text
                            )
                            else concat(
                                'simple|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text))
                            )
                        end as server_key,
                        case
                            when integration_type = 'full'
                                and position('://' in coalesce(api_host, ssh_host, '')) = 0
                                and position(':' in coalesce(api_host, ssh_host, '')) = 0
                            then concat(server_label_base, ':', api_port::text)
                            else server_label_base
                        end as server_label
                    from legacy_goi_configs
                )
                insert into goi_integration (
                    owner_organism_id,
                    created_at,
                    integration_type,
                    server_key,
                    server_label,
                    ssh_host,
                    ssh_user,
                    ssh_port,
                    path,
                    api_host,
                    api_port,
                    api_login,
                    api_password
                )
                select distinct on (server_key)
                    organism_id,
                    created_at,
                    integration_type,
                    server_key,
                    server_label,
                    ssh_host,
                    ssh_user,
                    ssh_port,
                    path,
                    api_host,
                    api_port,
                    api_login,
                    api_password
                from legacy_goi_configs_keyed
                order by server_key, organism_id
                on conflict (server_key) do nothing;

                with legacy_goi_configs as (
                    select
                        o.id as organism_id,
                        coalesce(nullif(trim(o.goi_integration_type), ''), 'full') as integration_type,
                        nullif(trim(o.goi_ssh_host), '') as ssh_host,
                        nullif(trim(o.goi_api_host), '') as api_host,
                        case
                            when o.goi_api_port > 0 then o.goi_api_port
                            else 8088
                        end as api_port
                    from organism o
                    where o.deleted_permanently = false
                        and (
                            nullif(trim(coalesce(o.goi_api_host, '')), '') is not null
                            or nullif(trim(coalesce(o.goi_ssh_host, '')), '') is not null
                            or exists (
                                select 1
                                from goi_association ga
                                where ga.organism_id = o.id
                            )
                            or exists (
                                select 1
                                from goi_knowledge gk
                                where gk.organism_id = o.id
                            )
                        )
                ),
                legacy_goi_configs_keyed as (
                    select
                        organism_id,
                        case
                            when integration_type = 'full' then concat(
                                'full|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text)),
                                '|',
                                api_port::text
                            )
                            else concat(
                                'simple|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text))
                            )
                        end as server_key
                    from legacy_goi_configs
                )
                insert into goi_integration_access_organism (
                    goi_integration_id,
                    organism_id
                )
                select
                    gi.id,
                    legacy_goi_configs_keyed.organism_id
                from legacy_goi_configs_keyed
                join goi_integration gi
                    on gi.server_key = legacy_goi_configs_keyed.server_key
                on conflict (goi_integration_id, organism_id) do nothing;

                with legacy_goi_configs as (
                    select
                        o.id as organism_id,
                        coalesce(nullif(trim(o.goi_integration_type), ''), 'full') as integration_type,
                        nullif(trim(o.goi_ssh_host), '') as ssh_host,
                        nullif(trim(o.goi_api_host), '') as api_host,
                        case
                            when o.goi_api_port > 0 then o.goi_api_port
                            else 8088
                        end as api_port
                    from organism o
                    where o.deleted_permanently = false
                        and (
                            nullif(trim(coalesce(o.goi_api_host, '')), '') is not null
                            or nullif(trim(coalesce(o.goi_ssh_host, '')), '') is not null
                            or exists (
                                select 1
                                from goi_association ga
                                where ga.organism_id = o.id
                            )
                            or exists (
                                select 1
                                from goi_knowledge gk
                                where gk.organism_id = o.id
                            )
                        )
                ),
                legacy_goi_configs_keyed as (
                    select
                        organism_id,
                        case
                            when integration_type = 'full' then concat(
                                'full|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text)),
                                '|',
                                api_port::text
                            )
                            else concat(
                                'simple|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text))
                            )
                        end as server_key
                    from legacy_goi_configs
                )
                update goi_association ga
                set integration_id = gi.id
                from legacy_goi_configs_keyed
                join goi_integration gi
                    on gi.server_key = legacy_goi_configs_keyed.server_key
                where ga.organism_id = legacy_goi_configs_keyed.organism_id
                    and ga.integration_id is null;

                with legacy_goi_configs as (
                    select
                        o.id as organism_id,
                        coalesce(nullif(trim(o.goi_integration_type), ''), 'full') as integration_type,
                        nullif(trim(o.goi_ssh_host), '') as ssh_host,
                        nullif(trim(o.goi_api_host), '') as api_host,
                        case
                            when o.goi_api_port > 0 then o.goi_api_port
                            else 8088
                        end as api_port
                    from organism o
                    where o.deleted_permanently = false
                        and (
                            nullif(trim(coalesce(o.goi_api_host, '')), '') is not null
                            or nullif(trim(coalesce(o.goi_ssh_host, '')), '') is not null
                            or exists (
                                select 1
                                from goi_association ga
                                where ga.organism_id = o.id
                            )
                            or exists (
                                select 1
                                from goi_knowledge gk
                                where gk.organism_id = o.id
                            )
                        )
                ),
                legacy_goi_configs_keyed as (
                    select
                        organism_id,
                        case
                            when integration_type = 'full' then concat(
                                'full|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text)),
                                '|',
                                api_port::text
                            )
                            else concat(
                                'simple|',
                                coalesce(lower(api_host), lower(ssh_host), concat('legacy-organism-', organism_id::text))
                            )
                        end as server_key
                    from legacy_goi_configs
                )
                update goi_knowledge gk
                set integration_id = gi.id
                from legacy_goi_configs_keyed
                join goi_integration gi
                    on gi.server_key = legacy_goi_configs_keyed.server_key
                where gk.organism_id = legacy_goi_configs_keyed.organism_id
                    and gk.integration_id is null;

                alter table goi_association
                    alter column integration_id set not null;

                alter table goi_knowledge
                    alter column integration_id set not null;

                drop index if exists idx_goi_association_organism_source_id;
                drop index if exists idx_goi_association_organism_id;
                alter table goi_association
                    drop constraint if exists goi_association_organism_id_source_association_id_key;

                create index if not exists idx_goi_association_integration_id
                    on goi_association (integration_id);

                create unique index if not exists idx_goi_association_integration_source_id
                    on goi_association (integration_id, source_association_id);

                drop index if exists idx_goi_knowledge_organism_source_id;
                drop index if exists idx_goi_knowledge_organism_id;
                alter table goi_knowledge
                    drop constraint if exists goi_knowledge_organism_id_source_knowledge_id_key;

                create index if not exists idx_goi_knowledge_integration_id
                    on goi_knowledge (integration_id);

                create unique index if not exists idx_goi_knowledge_integration_source_id
                    on goi_knowledge (integration_id, source_knowledge_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_goi_knowledge_integration_source_id;
                drop index if exists idx_goi_knowledge_integration_id;
                alter table goi_knowledge
                    drop column if exists integration_id;
                create index if not exists idx_goi_knowledge_organism_id
                    on goi_knowledge (organism_id);
                create index if not exists idx_goi_knowledge_organism_source_id
                    on goi_knowledge (organism_id, source_knowledge_id);

                drop index if exists idx_goi_association_integration_source_id;
                drop index if exists idx_goi_association_integration_id;
                alter table goi_association
                    drop column if exists integration_id;
                create index if not exists idx_goi_association_organism_id
                    on goi_association (organism_id);
                create index if not exists idx_goi_association_organism_source_id
                    on goi_association (organism_id, source_association_id);

                drop index if exists idx_goi_integration_access_login_login;
                drop index if exists idx_goi_integration_access_login_integration_id;
                drop table if exists goi_integration_access_login;

                drop index if exists idx_goi_integration_access_organism_organism_id;
                drop index if exists idx_goi_integration_access_organism_integration_id;
                drop table if exists goi_integration_access_organism;

                drop index if exists idx_goi_integration_owner_organism_id;
                drop table if exists goi_integration;
            "#,
        )
        .await?;
        Ok(())
    }
}

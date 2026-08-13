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
alter table if exists sigint_unit
    add column if not exists other text,
    add column if not exists team_or_crew text,
    add column if not exists section text,
    add column if not exists squad text,
    add column if not exists platoon text,
    add column if not exists brigade text,
    add column if not exists corps text;

update sigint_unit
set other = coalesce(other, ''),
    team_or_crew = coalesce(team_or_crew, ''),
    section = coalesce(section, ''),
    squad = coalesce(squad, ''),
    platoon = coalesce(platoon, ''),
    brigade = coalesce(brigade, ''),
    corps = coalesce(corps, '')
where other is null
    or team_or_crew is null
    or section is null
    or squad is null
    or platoon is null
    or brigade is null
    or corps is null;

alter table if exists sigint_unit
    alter column other set default '',
    alter column other set not null,
    alter column team_or_crew set default '',
    alter column team_or_crew set not null,
    alter column section set default '',
    alter column section set not null,
    alter column squad set default '',
    alter column squad set not null,
    alter column platoon set default '',
    alter column platoon set not null,
    alter column brigade set default '',
    alter column brigade set not null,
    alter column corps set default '',
    alter column corps set not null;
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
alter table if exists sigint_unit
    drop column if exists other,
    drop column if exists team_or_crew,
    drop column if exists section,
    drop column if exists squad,
    drop column if exists platoon,
    drop column if exists brigade,
    drop column if exists corps;
                "#,
            )
            .await?;
        Ok(())
    }
}

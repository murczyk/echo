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
create table public.file_favorite (
    entry_id uuid primary key references public.file_entry(id) on delete cascade,
    created_by uuid not null,
    created_at timestamptz not null default now()
);
create table public.file_view (
    file_id uuid not null,
    revision bigint not null,
    login_id uuid not null,
    viewed_at timestamptz not null default now(),
    primary key (file_id, revision, login_id),
    foreign key (file_id, revision) references public.file_revision(id, revision) on delete cascade
);
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table public.file_view;
drop table public.file_favorite;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }
}

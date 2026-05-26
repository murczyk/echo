use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists organism_keyword_set (
                    id bigserial primary key,
                    organism_id bigint not null references organism(id) on delete cascade,
                    author_login text references login(login) on delete set null,
                    name text not null,
                    words text[] not null default '{}'::text[],
                    is_system_default boolean not null default false,
                    updated_at timestamp without time zone not null default (now() at time zone 'utc'),
                    unique (organism_id, name)
                );
                create index if not exists organism_keyword_set_organism_id_idx on organism_keyword_set(organism_id);
            "#,
        )
        .await?;
        let seed_sql = include_str!(
            "seed_data_m20260520_120000_organism_default_keyword_set.sql"
        );
        db.execute_unprepared(seed_sql).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop table if exists organism_keyword_set;
            "#,
        )
        .await?;
        Ok(())
    }
}

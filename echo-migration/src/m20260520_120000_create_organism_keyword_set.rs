use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table organism_keyword_set (
                    id bigserial primary key,
                    organism_id bigint not null references organism(id) on delete cascade,
                    author_login text references login(login) on delete set null,
                    name text not null,
                    words jsonb not null default '[]',
                    is_system_default boolean not null default false,
                    updated_at timestamp without time zone not null default (now() at time zone 'utc'),
                    unique (organism_id, name)
                );
                create index organism_keyword_set_organism_id_idx on organism_keyword_set(organism_id);
            "#,
        )
        .await?;
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

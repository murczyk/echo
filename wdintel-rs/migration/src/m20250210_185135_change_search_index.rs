use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_search;").await?;

        db.execute_unprepared(
            "create table sigint_search (
    id BIGSERIAL PRIMARY KEY,
    search_tsv tsvector
    );
    ",
        )
        .await?;

        db.execute_unprepared(
            "create index sigint_search_tsv_idx ON sigint_search using gin(search_tsv);",
        )
        .await?;

        db.execute_unprepared(
            "alter table sigint_search add constraint fk_sigint_search_id foreign key (id) references sigint_inbox_item(id) on delete cascade;",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared("drop table sigint_search;").await?;

        db.execute_unprepared(
            "create table sigint_search (
    id BIGSERIAL PRIMARY KEY,
    search_tsv tsvector
    );
    ",
        )
        .await?;

        db.execute_unprepared(
            "create index sigint_search_tsv_idx ON sigint_search using gin(search_tsv);",
        )
        .await?;

        db.execute_unprepared(
            "alter table sigint_search add constraint fk_sigint_search_id foreign key (id) references signal_message(id) on delete cascade;",
        )
        .await?;

        Ok(())
    }
}

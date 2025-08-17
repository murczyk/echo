use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                CREATE TABLE tags_ordering (
                    id bigserial primary key,
                    login text not null references login(login),
                    ordering jsonb not null,
                    tag_ids_list text not null,
                    seed text not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    deprecated_at timestamp without time zone
                );
                ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE tags_ordering;").await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table source (
    id bigserial primary key,
    name text not null,
    deleted boolean not null default false,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;

        db.execute_unprepared("insert into source (name) values ('ДОПИТ');")
            .await?;
        db.execute_unprepared("insert into source (name) values ('Р/О');")
            .await?;
        db.execute_unprepared("insert into source (name) values ('ОСІНТ');")
            .await?;
        db.execute_unprepared(
            "insert into source (name) values ('ВЗАЄМОДІЯ');",
        )
        .await?;
        db.execute_unprepared("insert into source (name) values ('ЕТАЛОНКА');")
            .await?;

        db.execute_unprepared(
            "alter table sigint_callsign add column source_id int references source(id);",
        ).await?;
        db.execute_unprepared("update sigint_callsign set source_id = 1;")
            .await?;
        db.execute_unprepared(
            "alter table sigint_callsign alter column source_id set not null;",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table source;").await?;
        db.execute_unprepared(
            "alter table sigint_callsign drop column source_id;",
        )
        .await?;
        Ok(())
    }
}

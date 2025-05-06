use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table login alter column password drop not null;",
        )
        .await?;
        db.execute_unprepared(
            "
                create table delta_login (
                    id serial primary key,
                    login varchar(255) not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                alter table login add column delta_login_id int references delta_login(id);
                ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("alter table login drop column delta_login_id;")
            .await?;
        db.execute_unprepared("drop table delta_login;").await?;
        Ok(())
    }
}

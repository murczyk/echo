use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("
            create table sigint_key_share_policy (
                id bigserial primary key,
                grant_from int8 references organism(id) not null,
                grant_to int8 references organism(id) not null,
                author text not null references login(login),
                deleted boolean not null default false,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            "
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_key_share_policy")
            .await?;

        Ok(())
    }
}

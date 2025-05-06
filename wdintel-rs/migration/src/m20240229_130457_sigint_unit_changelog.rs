use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table sigint_unit_changelog (
    id bigserial primary key,
    sigint_unit_id int8 not null references sigint_unit(id),
    login text not null references login(login),
    action text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    new_value jsonb,
    old_value jsonb,
    req jsonb
);
",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_unit_changelog;")
            .await?;
        Ok(())
    }
}

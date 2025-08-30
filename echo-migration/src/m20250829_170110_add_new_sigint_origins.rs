use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            insert into sigint_origin(name) values ('kupiansk');
            insert into sigint_origin(name) values ('kyiv');
            insert into sigint_origin(name) values ('pivden');
            insert into sigint_origin(name) values ('pivnich');
            insert into sigint_origin(name) values ('zakhid');
            insert into sigint_origin(name) values ('skhid');
            ",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            delete from sigint_origin where name in (
                'kupiansk',
                'kyiv',
                'pivden',
                'pivnich',
                'zakhid',
                'skhid');
            ",
        )
        .await?;

        Ok(())
    }
}

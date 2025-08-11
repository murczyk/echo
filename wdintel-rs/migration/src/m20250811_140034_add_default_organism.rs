use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            insert into organism(name, roles, group_auto_link, enabled) values ('-', '["Rer"]', true, true);
            update login set organism_id = (select id from organism where name = '-') where organism_id is null;
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            update login set organism_id = null where organism_id in (select id from organism where name = '-');
            delete from organism where name = '-';
            ",
        )
            .await?;
        Ok(())
    }
}

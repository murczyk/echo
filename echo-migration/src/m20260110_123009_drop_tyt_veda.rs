use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            update sigint_network_encryption_key set modulation_id = 11 where modulation_id = 9;
            update sigint_network_freq set modulation_id = 11 where modulation_id = 9;
            delete from modulation where id = 9;
            update modulation set lft = 200 where id = 10;
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            update modulation set lft = 210 where id = 10;
            INSERT INTO modulation (id, name, lft, rgt) VALUES (9, 'TYT (VEDA)', 200, 209)
            ",
        )
            .await?;
        Ok(())
    }
}

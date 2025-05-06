use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        println!(
            "> create type sigint_network_kind as ENUM ('УКХ', 'DMR', 'DMRe');"
        );
        // create new value VHF
        db.execute_unprepared(
            r#"ALTER TYPE sigint_network_kind ADD VALUE 'VHF';"#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        println!(
            "> create type sigint_network_kind as ENUM ('УКХ', 'DMR', 'DMRe');"
        );
        // remove value VHF
        db.execute_unprepared(
            r#"ALTER TYPE sigint_network_kind DROP VALUE 'VHF';"#,
        )
        .await?;

        Ok(())
    }
}

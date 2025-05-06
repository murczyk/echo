use sea_orm_migration::prelude::*;
use std::path::Path;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"CREATE TYPE settlement_kind AS ENUM ('City', 'Town', 'Village');"#
        ).await?;
        db.execute_unprepared(
            r#"CREATE TABLE settlement (
                id                    INTEGER NOT NULL,
                kind                  settlement_kind NOT NULL,
                name                  TEXT NOT NULL,
                territorial_community TEXT NULL,
                district              TEXT NULL,
                region                TEXT NULL,
                lon                   FLOAT8,
                lat                   FLOAT8,
                CONSTRAINT settlement_pkey PRIMARY KEY (id)
            );"#,
        )
        .await?;

        let mut file = Path::new("./migration/src/settlement_data.sql");
        if !file.exists() {
            file = Path::new("/usr/share/echo/migration/settlement_data.sql");
        }
        if !file.exists() {
            file = Path::new("/fast/kon/workspace/echo/wdintel-rs/migration/src/settlement_data.sql");
        }
        let sql =
            std::fs::read_to_string(file).expect("Unable to read SQL file");
        db.execute_unprepared(&sql).await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(r#"DROP TABLE settlement;"#).await?;
        db.execute_unprepared(r#"DROP TYPE settlement_kind;"#)
            .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;
use std::env;
use std::ops::Deref;
use std::path::Path;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            delete from settlement where id >= 99998;
            "#,
        )
        .await?;

        db.execute_unprepared(&run_from_file("settlements_data_rf_rb.sql"))
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(r#"delete from settlement;"#).await?;
        db.execute_unprepared(&run_from_file("settlement_data.sql"))
            .await?;
        db.execute_unprepared(&run_from_file("settlements_data_rf_rb.sql"))
            .await?;
        Ok(())
    }
}

fn run_from_file(filename: &'static str) -> String {
    let path = format!("./src/{}", filename);
    let mut file = Path::new(&path);
    let path = format!("/usr/share/echo/migration/{}", filename);
    if !file.exists() {
        file = Path::new(&path);
    }
    let path = format!("/fast/kon/workspace/echo/migration/src/{}", filename);
    if !file.exists() {
        file = Path::new(&path);
    }
    let path = env::current_dir()
        .unwrap()
        .join("migration")
        .join("src")
        .join(filename);
    if !file.exists() {
        file = path.deref();
    }
    let sql = std::fs::read_to_string(file).expect("Unable to read SQL file");
    sql
}

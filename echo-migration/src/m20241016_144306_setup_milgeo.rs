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
            CREATE EXTENSION IF NOT EXISTS postgis;

            CREATE
            OR REPLACE FUNCTION public.ST_CardinalDirection(azimuth float8) RETURNS varchar AS $$ BEGIN IF $1 < 0.0 THEN RAISE 'Cardinal direction calculation error';
            ELSE RETURN (
              SELECT
                CASE WHEN degrees($1) < 22.5 THEN 'N'
                WHEN degrees($1) < 67.5 THEN 'NE'
                WHEN degrees($1) < 112.5 THEN 'E'
                WHEN degrees($1) < 157.5 THEN 'SE'
                WHEN degrees($1) < 202.5 THEN 'S'
                WHEN degrees($1) < 247.5 THEN 'SW'
                WHEN degrees($1) < 292.5 THEN 'W'
                WHEN degrees($1) < 337.5 THEN 'NW'
                WHEN degrees($1) <= 360.0 THEN 'N' END
            );
            END IF;
            END;
            $$ LANGUAGE plpgsql IMMUTABLE COST 100;

            drop table settlement;

            CREATE TABLE settlement (
                id                    INTEGER NOT NULL,
                kind                  settlement_kind NOT NULL,
                name                  TEXT NOT NULL,
                territorial_community TEXT NULL,
                district              TEXT NULL,
                region                TEXT NULL,
                lon                   FLOAT8,
                lat                   FLOAT8,
                CONSTRAINT settlement_pkey PRIMARY KEY (id)
            );
            "#,
        )
            .await?;

        db.execute_unprepared(&run_from_file("settlement_data.sql"))
            .await?;
        db.execute_unprepared(&run_from_file("settlement_data_rf.sql"))
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(r#"delete from settlement;"#).await?;
        db.execute_unprepared(&run_from_file("settlement_data.sql"))
            .await?;
        Ok(())
    }
}
fn run_from_file(filename: &'static str) -> String {
    let path = format!("./src/{filename}");
    let mut file = Path::new(&path);
    let path = format!("/usr/share/echo/migration/{filename}");
    if !file.exists() {
        file = Path::new(&path);
    }
    let path = format!("/fast/kon/workspace/echo/migration/src/{filename}");
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

    std::fs::read_to_string(file).expect("Unable to read SQL file")
}

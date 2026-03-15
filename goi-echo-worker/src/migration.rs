use anyhow::Result;
use sea_orm::DatabaseConnection;
use sea_orm_migration::prelude::*;

pub struct Migrator;

impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20260315_200000_create_association::Migration)]
    }
}

pub async fn run_migration(db: &DatabaseConnection) -> Result<()> {
    Migrator::up(db, None).await?;
    Ok(())
}

mod m20260315_200000_create_association {
    use sea_orm_migration::prelude::*;

    #[derive(DeriveMigrationName)]
    pub struct Migration;

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared(
                    r#"
                        create table if not exists association (
                            id bigserial primary key,
                            row jsonb not null,
                            created_at timestamptz not null default now(),
                            deleted bool not null default false,
                            dedupe_key text not null
                        );

                        create unique index if not exists idx_association_dedupe_key
                            on association (dedupe_key);
                    "#,
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared(
                    r#"
                        drop index if exists idx_association_dedupe_key;
                        drop table if exists association;
                    "#,
                )
                .await?;
            Ok(())
        }
    }
}

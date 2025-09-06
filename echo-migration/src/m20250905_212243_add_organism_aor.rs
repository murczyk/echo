use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                CREATE TABLE organism_aor (
                    id bigserial primary key,
                    organism_id bigint NOT NULL REFERENCES organism(id) ON DELETE CASCADE,
                    aor_id bigint NOT NULL REFERENCES area_of_responsibility(id) ON DELETE CASCADE,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                CREATE INDEX idx_organism_id ON organism_aor(organism_id);
                CREATE INDEX idx_organism_aor_aor_id ON organism_aor(aor_id);
                "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop table organism_aor;
            "#,
        )
        .await?;
        Ok(())
    }
}

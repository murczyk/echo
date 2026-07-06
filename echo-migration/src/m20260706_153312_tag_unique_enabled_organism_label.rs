use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_tag_owner_organism_id_label;

                create unique index if not exists idx_tag_enabled_owner_organism_id_label
                    on tag(owner_organism_id, label)
                    where owner_organism_id is not null and enabled = true;
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_tag_enabled_owner_organism_id_label;

                create unique index if not exists idx_tag_owner_organism_id_label
                    on tag(owner_organism_id, label);
            "#,
        )
        .await?;

        Ok(())
    }
}

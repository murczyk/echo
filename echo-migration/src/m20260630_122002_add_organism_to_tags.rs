use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table tag
                    add column if not exists owner_organism_id int8 references organism(id) on delete cascade;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                create index if not exists idx_tag_owner_organism_id on tag(owner_organism_id);
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                create unique index if not exists idx_tag_owner_organism_id_label on tag(owner_organism_id, label);
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table tag
                    drop column if exists owner_organism_id;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                drop index if exists idx_tag_owner_organism_id;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                drop index if exists idx_tag_owner_organism_id_label;
            "#,
        )
        .await?;

        Ok(())
    }
}

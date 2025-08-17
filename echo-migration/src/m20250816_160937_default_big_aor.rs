use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table area_of_responsibility add column is_default boolean not null default false;
            "#,
        )
            .await?;

        // now create default aor with large start/end
        db.execute_unprepared(
            r#"
            INSERT INTO area_of_responsibility (name, description, left_bound, right_bound, is_default, is_top_level, updated_at, created_at, deleted)
            VALUES ('DEFAULT_AOR', 'Вся смуга', 0.0, 35999.99, true, true, NOW(), NOW(), false);
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // Remove the default AOR record
        db.execute_unprepared(
            r#"
            DELETE FROM area_of_responsibility WHERE name = 'DEFAULT_AOR' AND is_default = true;
            "#,
        )
            .await?;

        // Remove the is_default column
        db.execute_unprepared(
            r#"
            ALTER TABLE area_of_responsibility DROP COLUMN is_default;
            "#,
        )
        .await?;

        Ok(())
    }
}

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
alter table device
    add column rating integer check (rating between 0 and 5),
    add column description text check (char_length(description) <= 4000);

-- Publish both nullable columns to CDC. Device has no UPDATE triggers; touch
-- only the new columns on one row without changing its activity timestamp.
update device set rating = rating, description = description
where id = (select id from device order by id limit 1);
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table device drop column description, drop column rating;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }
}

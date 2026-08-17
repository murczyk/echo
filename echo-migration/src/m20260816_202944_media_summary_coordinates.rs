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
alter table media_summary
    add column coordinates jsonb not null default '[]'::jsonb,
    add constraint media_summary_coordinates_array
        check (
            jsonb_typeof(coordinates) = 'array'
            and jsonb_array_length(coordinates) <= 50
        );
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
alter table media_summary drop column coordinates;
                "#,
            )
            .await?;
        Ok(())
    }
}

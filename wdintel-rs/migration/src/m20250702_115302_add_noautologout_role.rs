use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "UPDATE
                login
            SET
                roles = roles || '[\"NoAutoLogout\"]'::jsonb
            WHERE
                (roles @> '[\"Admin\"]'::jsonb
                    OR roles @> '[\"Api\"]'::jsonb)
                AND NOT (roles @> '[\"NoAutoLogout\"]'::jsonb);
            ",        
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            UPDATE login
                SET roles = (
                    SELECT jsonb_agg(value)
                    FROM jsonb_array_elements(roles) AS elem(value)
                    WHERE value <> '\"NoAutoLogout\"'
                    )
                WHERE (roles @> '[\"Admin\"]'::jsonb OR roles @> '[\"Api\"]'::jsonb)
                    AND roles @> '[\"NoAutoLogout\"]'::jsonb;",
        )
        .await?;
        Ok(())
    }
}

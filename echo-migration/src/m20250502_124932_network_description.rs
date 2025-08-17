use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TYPE network_description_type as ENUM ('Confirmation', 'Sign');") 
        .await?;

        db.execute_unprepared(
            "
                CREATE TABLE sigint_network_description (
                id bigserial primary key,
                network_id int8 not null references sigint_network(id),
                login text not null references login(login),
                type network_description_type NOT NULL,
                description text NOT NULL,
                comment text,
                deleted boolean DEFAULT false NOT NULL,
                created_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL);
                ",
        )
            .await?;

        db.execute_unprepared(
            "ALTER TABLE sigint_network DROP COLUMN confirmation;
                 ALTER TABLE sigint_network DROP COLUMN signs;",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE sigint_network_description;")
            .await?;

        db.execute_unprepared("DROP TYPE network_description_type;")
            .await?;

        db.execute_unprepared(
            "ALTER TABLE sigint_network ADD COLUMN confirmation text;
             ALTER TABLE sigint_network ADD COLUMN signs text;",
        )
        .await?;
        Ok(())
    }
}

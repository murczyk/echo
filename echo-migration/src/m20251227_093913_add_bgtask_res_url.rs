use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Replace the sample below with your own migration scripts
        todo!();

        manager
            .create_table(
                Table::create()
                    .table(Post::Table)
                    .if_not_exists()
                    .col(pk_auto(Post::Id))
                    .col(string(Post::Title))
                    .col(string(Post::Text))
                    .to_owned(),
            )
            .awaituse sea_orm_migration::prelude::*;

        #[derive(DeriveMigrationName)]
        pub struct Migration;

        #[async_trait::async_trait]
        impl MigrationTrait for Migration {
            async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
                let db = manager.get_connection();

                db.execute_unprepared(
                    "
            alter table bgtask_res add column res_url text;            ",
                )
                    .await?;

                Ok(())
            }

            async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
                let db = manager.get_connection();

                db.execute_unprepared(
                    "
            alter table bgtask_res drop column res_url;            ",
                )
                    .await?;

                Ok(())
            }
        }
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Replace the sample below with your own migration scripts
        todo!();

        manager
            .drop_table(Table::drop().table(Post::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Post {
    Table,
    Id,
    Title,
    Text,
}

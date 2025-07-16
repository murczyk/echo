use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table sigint_post add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_post add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_callsign add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;

            alter table sigint_post add column mothership_id bigint;
            alter table sigint_network_post add column mothership_id bigint;
            alter table sigint_network_callsign add column mothership_id bigint;
            ",
        )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table sigint_post drop column mothership_id;
            alter table sigint_network_post drop column mothership_id;
            alter table sigint_network_callsign drop column mothership_id;

            alter table sigint_post drop column sigint_origin_id;
            alter table sigint_network_post drop column sigint_origin_id;
            alter table sigint_network_callsign drop column sigint_origin_id;
            ",
        )
        .await?;

        Ok(())
    }
}

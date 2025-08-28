use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table sigint_callsign drop column mothership_id;
                alter table sigint_signal drop column mothership_id;
                alter table sigint_network_freq drop column mothership_id;
                alter table sigint_post drop column mothership_id;
                alter table sigint_network_freq_changelog drop column mothership_id;
                alter table sigint_network_unit drop column mothership_id;
                alter table sigint_network_unit_changelog drop column mothership_id;
                alter table sigint_unit drop column mothership_id;
                alter table sigint_signal_changelog drop column mothership_id;
                alter table sigint_zone drop column mothership_id;
                alter table sigint_network_callsign drop column mothership_id;
                alter table sigint_network drop column mothership_id;
                alter table sigint_callsign_changelog drop column mothership_id;
                alter table source drop column mothership_id;
                alter table sigint_network_description drop column mothership_id;
                alter table sigint_network_changelog drop column mothership_id;
                alter table sigint_network_post drop column mothership_id;
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
             alter table sigint_unit add column mothership_id bigint;
            alter table sigint_signal add column mothership_id bigint;
            alter table sigint_signal_changelog add column mothership_id bigint;
            alter table sigint_network add column mothership_id bigint;
            alter table sigint_network_changelog add column mothership_id bigint;
            alter table sigint_network_description add column mothership_id bigint;
            alter table sigint_network_freq add column mothership_id bigint;
            alter table sigint_network_freq_changelog add column mothership_id bigint;
            alter table sigint_network_unit add column mothership_id bigint;
            alter table sigint_network_unit_changelog add column mothership_id bigint;
            alter table sigint_zone add column mothership_id bigint;
            alter table sigint_callsign add column mothership_id bigint;
            alter table sigint_callsign_changelog add column mothership_id bigint;
            alter table source add column mothership_id bigint;
            "#,
        )
            .await?;
        Ok(())
    }
}

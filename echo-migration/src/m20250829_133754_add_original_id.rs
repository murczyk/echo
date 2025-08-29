use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table sigint_callsign add column original_id bigint;
                alter table sigint_signal add column original_id bigint;
                alter table sigint_network_freq add column original_id bigint;
                alter table sigint_post add column original_id bigint;
                alter table sigint_network_freq_changelog add column original_id bigint;
                alter table sigint_network_unit add column original_id bigint;
                alter table sigint_network_unit_changelog add column original_id bigint;
                alter table sigint_unit add column original_id bigint;
                alter table sigint_signal_changelog add column original_id bigint;
                alter table sigint_zone add column original_id bigint;
                alter table sigint_network_callsign add column original_id bigint;
                alter table modulation add column original_id int;
                alter table sigint_network add column original_id bigint;
                alter table sigint_network_aor add column original_id bigint;
                alter table sigint_callsign_changelog add column original_id bigint;
                alter table source add column original_id bigint;
                alter table sigint_zone_aor add column original_id bigint;
                alter table sigint_network_description add column original_id bigint;
                alter table sigint_network_changelog add column original_id bigint;
                alter table area_of_responsibility add column original_id bigint;
                alter table sigint_network_post add column original_id bigint;
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table sigint_callsign drop column original_id;
                alter table sigint_signal drop column original_id;
                alter table sigint_network_freq drop column original_id;
                alter table sigint_post drop column original_id;
                alter table sigint_network_freq_changelog drop column original_id;
                alter table sigint_network_unit drop column original_id;
                alter table sigint_network_unit_changelog drop column original_id;
                alter table sigint_unit drop column original_id;
                alter table sigint_signal_changelog drop column original_id;
                alter table sigint_zone drop column original_id;
                alter table sigint_network_callsign drop column original_id;
                alter table modulation drop column original_id;
                alter table sigint_network drop column original_id;
                alter table sigint_network_aor drop column original_id;
                alter table sigint_callsign_changelog drop column original_id;
                alter table source drop column original_id;
                alter table sigint_zone_aor drop column original_id;
                alter table sigint_network_description drop column original_id;
                alter table sigint_network_changelog drop column original_id;
                alter table area_of_responsibility drop column original_id;
                alter table sigint_network_post drop column original_id;
            "#,
        )
            .await?;
        Ok(())
    }
}

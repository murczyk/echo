use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            create table sigint_origin (
                id bigserial primary key,
                name varchar(255) not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            insert into sigint_origin(name) values ('mothership');
            insert into sigint_origin(name) values ('zaporizhzha');
            insert into sigint_origin(name) values ('kherson');
            insert into sigint_origin(name) values ('donetsk');
            insert into sigint_origin(name) values ('luhansk');
            insert into sigint_origin(name) values ('kharkiv');
            insert into sigint_origin(name) values ('lyman');
            insert into sigint_origin(name) values ('siversk');
            insert into sigint_origin(name) values ('volyn');
            insert into sigint_origin(name) values ('pivden');
            insert into sigint_origin(name) values ('pivnich');
            insert into sigint_origin(name) values ('skhid');
            insert into sigint_origin(name) values ('zakhid');
            insert into sigint_origin(name) values ('kyiv');

            alter table sigint_unit add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_signal add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_signal_changelog add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_changelog add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_description add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_freq add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_freq_changelog add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_unit add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_network_unit_changelog add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_zone add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_callsign add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            alter table sigint_callsign_changelog add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;

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
            ",
        )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table sigint_unit drop column mothership_id;
            alter table sigint_signal drop column mothership_id;
            alter table sigint_signal_changelog drop column mothership_id;
            alter table sigint_network drop column mothership_id;
            alter table sigint_network_changelog drop column mothership_id;
            alter table sigint_network_description drop column mothership_id;
            alter table sigint_network_freq drop column mothership_id;
            alter table sigint_network_freq_changelog drop column mothership_id;
            alter table sigint_network_unit drop column mothership_id;
            alter table sigint_network_unit_changelog drop column mothership_id;
            alter table sigint_zone drop column mothership_id;
            alter table sigint_callsign drop column mothership_id;
            alter table sigint_callsign_changelog drop column mothership_id;

            alter table sigint_unit drop column sigint_origin_id;
            alter table sigint_signal drop column sigint_origin_id;
            alter table sigint_signal_changelog drop column sigint_origin_id;
            alter table sigint_network drop column sigint_origin_id;
            alter table sigint_network_changelog drop column sigint_origin_id;
            alter table sigint_network_description drop column sigint_origin_id;
            alter table sigint_network_freq drop column sigint_origin_id;
            alter table sigint_network_freq_changelog drop column sigint_origin_id;
            alter table sigint_network_unit drop column sigint_origin_id;
            alter table sigint_network_unit_changelog drop column sigint_origin_id;
            alter table sigint_zone drop column sigint_origin_id;
            alter table sigint_callsign drop column sigint_origin_id;
            alter table sigint_callsign_changelog drop column sigint_origin_id;

            drop table sigint_origin;
            ",
        )
        .await?;

        Ok(())
    }
}

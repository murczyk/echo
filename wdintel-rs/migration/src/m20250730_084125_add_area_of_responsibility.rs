use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            -- Create table for Area Of Responsibility (AOR)
            CREATE TABLE area_of_responsibility (
                id bigserial primary key,
                name text NOT NULL,
                description text,
                left_bound float8 NOT NULL,
                right_bound float8 NOT NULL,
                left_lat float8,
                left_lon float8,
                right_lat float8,
                right_lon float8,
                left_settelment text,
                right_settelment text,
                updated_by text references login(login),
                updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                created_at timestamp without time zone default (now() at time zone 'utc') NOT NULL
            );
            CREATE INDEX area_of_responsibility_left_bound_idx on area_of_responsibility (left_bound);
            CREATE INDEX area_of_responsibility_right_bound_idx on area_of_responsibility (right_bound);

            -- Create default AOR
            INSERT INTO area_of_responsibility (name, description, left_bound, right_bound)
            VALUES ('Default AOR', 'Смуга за замовчанням. Увага! Переіменуйте та проставте межі перед початком роботи.', 30000.0, 60000.0);

            -- Create linkage table between Messenger Group and AOR
            CREATE TABLE signal_group_aor (
                id bigserial primary key,
                master_key text NOT NULL REFERENCES signal_group(master_key) ON DELETE CASCADE,
                aor_id bigint NOT NULL REFERENCES area_of_responsibility(id) ON DELETE CASCADE,
				created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            CREATE INDEX idx_signal_group_aor_master_key ON signal_group_aor(master_key);
            CREATE INDEX idx_signal_group_aor_aor_id ON signal_group_aor(aor_id);

            -- Create linkage table between Zone and AOR
            CREATE TABLE sigint_zone_aor (
                id bigserial primary key,
                zone_id bigint NOT NULL REFERENCES sigint_zone(id) ON DELETE CASCADE,
                aor_id bigint NOT NULL REFERENCES area_of_responsibility(id) ON DELETE CASCADE,
				created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            CREATE INDEX idx_sigint_zone_aor_zone_id ON sigint_zone_aor(zone_id);
            CREATE INDEX idx_sigint_zone_aor_aor_id ON sigint_zone_aor(aor_id);

            -- Create linkage table between Network and AOR
            CREATE TABLE sigint_network_aor (
                id bigserial primary key,
                network_id bigint NOT NULL REFERENCES sigint_network(id) ON DELETE CASCADE,
                aor_id bigint NOT NULL REFERENCES area_of_responsibility(id) ON DELETE CASCADE,
				created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            CREATE INDEX idx_sigint_network_aor_network_id ON sigint_network_aor(network_id);
            CREATE INDEX idx_sigint_network_aor_aor_id ON sigint_network_aor(aor_id);

            -- Fill existing Signal Groups with Default AOR
            INSERT INTO signal_group_aor(master_key, aor_id)
                SELECT sg.master_key, aor.id
                    FROM signal_group sg, area_of_responsibility aor
                WHERE aor.name = 'Default AOR';

            INSERT INTO sigint_zone_aor(zone_id, aor_id)
                SELECT sz.id, aor.id
                    FROM sigint_zone sz, area_of_responsibility aor
                WHERE aor.name = 'Default AOR';

            INSERT INTO sigint_network_aor(network_id, aor_id)
                SELECT sn.id, aor.id
                    FROM sigint_network sn, area_of_responsibility aor
                WHERE aor.name = 'Default AOR';
            ",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            DROP TABLE sigint_network_aor;
            DROP TABLE sigint_zone_aor;
            DROP TABLE signal_group_aor;
            DROP TABLE area_of_responsibility;
            ",
        )
        .await?;

        Ok(())
    }
}

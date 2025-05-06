use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                create table sigint_peleng (
                    id bigserial primary key,
                    source_inbox_item_id int8 not null references sigint_inbox_item(id),
                    lat float8 not null,
                    lng float8 not null,
                    settlement text,
                    locality_direction text,
                    distance_m float8,
                    country_code varchar(2),
                    deleted boolean not null default false,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    updated_at timestamp without time zone
                );

                alter table sigint_inbox_item drop column other_coords;
                alter table sigint_inbox_item drop column coords_location;
                alter table sigint_inbox_item drop column has_coords_location_v2;
                ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r"
                drop table sigint_peleng;
                alter table sigint_inbox_item add column other_coords jsonb;
                alter table sigint_inbox_item add column coords_location text;
                alter table sigint_inbox_item add column has_coords_location_v2 boolean DEFAULT false NOT NULL;
                "
        ).await?;
        Ok(())
    }
}

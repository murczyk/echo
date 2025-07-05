use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE secret_group_user (
                id bigserial primary key not null,
                master_key text references signal_group (master_key) not null,
                login text references login (login) not null
            );",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE sigint_zone_datasource_new (
                id BIGSERIAL PRIMARY KEY not null,
                sigint_zone_id int8 REFERENCES sigint_zone (id) not null,
                datasource_id int8 REFERENCES datasource (id) not null,
                group_master_key text REFERENCES signal_group (master_key) not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );"
        ).await?;
        db.execute_unprepared(
            "ALTER TABLE signal_group ADD COLUMN is_secret boolean default false not null;"
        ).await?;
        db.execute_unprepared(
            "
                insert into sigint_zone_datasource_new (sigint_zone_id, datasource_id, group_master_key)
                select sigint_zone_id, datasource_id, jsonb_array_elements_text(group_master_keys) as group_master_key from sigint_zone_datasource;
            ",
        )
            .await?;
        db.execute_unprepared(
            "
                DROP TABLE sigint_zone_datasource;
            ",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE sigint_zone_datasource_new RENAME TO sigint_zone_datasource;"
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table secret_group_user;")
            .await?;
        db.execute_unprepared("CREATE TABLE sigint_zone_datasource_old (
	        id BIGSERIAL PRIMARY KEY,
	        sigint_zone_id int8 REFERENCES sigint_zone (id) not null,
	        datasource_id int8 REFERENCES datasource (id) not null,
	        group_master_keys jsonb,
	        created_at timestamp without time zone default (now() at time zone 'utc') not null
        );").await?;
        db.execute_unprepared(
            "ALTER TABLE signal_group DROP COLUMN is_secret;",
        )
        .await?;
        db.execute_unprepared(
            "
                DROP TABLE sigint_zone_datasource;
            ",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE sigint_zone_datasource_old RENAME TO sigint_zone_datasource;"
        ).await?;
        Ok(())
    }
}

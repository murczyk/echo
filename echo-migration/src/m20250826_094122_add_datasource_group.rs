use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("
            create table datasource_group (
                id bigserial primary key,
                group_master_key text references signal_group(master_key) not null,
                datasource_id int8 REFERENCES datasource (id) not null,
                last_sync_at timestamp without time zone default (now() at time zone 'utc') not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            "
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table datasource_group").await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table signal_group drop column short_note;
            alter table signal_group drop column long_note;
            create table group_admin_data (
                id bigserial primary key,
                group_master_key text references signal_group(master_key),
                short_note text,
                long_note text,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            ",
        )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            drop table group_admin_data;
            alter table signal_group add column short_note text;
            alter table signal_group add column long_note text;
            ",
        )
        .await?;

        Ok(())
    }
}

use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create table user_group_feed_read_state (
    login_id uuid not null references login(id) on delete cascade,
    group_master_key text not null references signal_group(master_key) on delete cascade,
    last_read_created_at timestamp without time zone,
    last_read_message_id bigint,
    updated_at timestamp without time zone not null default (now() at time zone 'utc'),
    primary key (login_id, group_master_key)
);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop table user_group_feed_read_state;")
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

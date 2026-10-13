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
create table sigint_inbox_item_unit_selection (
    item_id bigint primary key references sigint_inbox_item(id) on delete cascade,
    unit_id bigint not null references sigint_unit(id) on delete cascade,
    body_hash text not null,
    unit_v2 text,
    unit text
);
create index sigint_inbox_item_unit_selection_unit_idx
    on sigint_inbox_item_unit_selection (unit_id, item_id);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop table sigint_inbox_item_unit_selection;")
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

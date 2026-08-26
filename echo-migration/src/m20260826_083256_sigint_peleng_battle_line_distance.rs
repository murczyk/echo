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
alter table sigint_peleng
    add column battle_line_distance integer;

alter table system_settings
    add column show_peleng_distance_to_battleline boolean;

update system_settings
set show_peleng_distance_to_battleline = false;

alter table system_settings
    alter column show_peleng_distance_to_battleline set default false,
    alter column show_peleng_distance_to_battleline set not null;

create index sigint_peleng_pending_battle_line_distance_idx
    on sigint_peleng (source_inbox_item_id, id)
    where battle_line_distance is null and not deleted;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index if exists sigint_peleng_pending_battle_line_distance_idx;

alter table sigint_peleng
    drop column if exists battle_line_distance;

alter table system_settings
    drop column if exists show_peleng_distance_to_battleline;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

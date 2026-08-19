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
create index sigint_unit_active_normalized_name_idx
    on sigint_unit (
        lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')),
        id
    )
    where deleted = false;

create index failed_inbox_unit_active_text_metadata_idx
    on failed_inbox_unit (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g')),
        is_bad_data desc,
        id desc
    )
    where deleted = false;
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
drop index if exists failed_inbox_unit_active_text_metadata_idx;
drop index if exists sigint_unit_active_normalized_name_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

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
drop index settlement_name_trgm_idx;
create index settlement_name_lookup_idx on settlement using gin (
    upper(translate(btrim(name), chr(39) || 'ʼ`', '’’’')) gin_trgm_ops
);
create index settlement_alias_text_lookup_idx on settlement_alias using gin (
    upper(translate(btrim(text), chr(39) || 'ʼ`', '’’’')) gin_trgm_ops
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
            .execute_unprepared(
                r#"
drop index if exists settlement_alias_text_lookup_idx;
drop index if exists settlement_name_lookup_idx;
create index settlement_name_trgm_idx on settlement using gin (name gin_trgm_ops);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

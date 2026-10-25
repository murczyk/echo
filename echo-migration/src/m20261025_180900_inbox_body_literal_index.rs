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
create index concurrently if not exists sigint_inbox_item_body_literal_idx
    on sigint_inbox_item using gin((coalesce(body_noheader->>'body','')) gin_trgm_ops);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"
do $$
begin
    if not exists (
        select 1 from pg_index
        where indexrelid = 'sigint_inbox_item_body_literal_idx'::regclass
          and indrelid = 'sigint_inbox_item'::regclass
          and indisvalid and indisready
    ) then
        raise exception 'sigint_inbox_item_body_literal_idx requires recovery before retrying migration';
    end if;
end $$;
analyze sigint_inbox_item;
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
drop index concurrently if exists sigint_inbox_item_body_literal_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}

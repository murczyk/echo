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
        select 1
        from pg_index idx
        join pg_class relation on relation.oid = idx.indexrelid
        join pg_am method on method.oid = relation.relam
        join pg_opclass operators on operators.oid = idx.indclass[0]
        where idx.indexrelid = 'sigint_inbox_item_body_literal_idx'::regclass
          and idx.indrelid = 'sigint_inbox_item'::regclass
          and idx.indisvalid and idx.indisready and idx.indislive
          and method.amname = 'gin'
          and operators.opcname = 'gin_trgm_ops'
          and idx.indnkeyatts = 1 and idx.indnatts = 1
          and idx.indcollation[0] = 'default'::regcollation
          and idx.indpred is null
          and pg_get_expr(idx.indexprs, idx.indrelid)
              = 'COALESCE((body_noheader ->> ''body''::text), ''''::text)'
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

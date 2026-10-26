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
create index concurrently if not exists messenger_alert_delivery_created_at_idx
    on messenger_alert_delivery (created_at);
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
        join pg_attribute attribute on attribute.attrelid = idx.indrelid
            and attribute.attnum = idx.indkey[0]
        where idx.indexrelid = 'messenger_alert_delivery_created_at_idx'::regclass
          and idx.indrelid = 'messenger_alert_delivery'::regclass
          and idx.indisvalid and idx.indisready and idx.indislive
          and not idx.indisunique
          and method.amname = 'btree'
          and operators.opcname = 'timestamp_ops'
          and operators.opcnamespace = 'pg_catalog'::regnamespace
          and attribute.attname = 'created_at'
          and idx.indnkeyatts = 1 and idx.indnatts = 1
          and idx.indoption[0] = 0 and idx.indcollation[0] = 0
          and idx.indpred is null and idx.indexprs is null
    ) then
        raise exception 'messenger_alert_delivery_created_at_idx requires recovery before retrying migration';
    end if;
end $$;
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
drop index concurrently if exists messenger_alert_delivery_created_at_idx;
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

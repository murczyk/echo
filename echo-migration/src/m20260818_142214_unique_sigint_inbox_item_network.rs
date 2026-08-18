use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
do $$
begin
    if not exists (
        select 1
        from pg_index index_state
        join pg_class index_class
          on index_class.oid = index_state.indexrelid
        join pg_namespace index_namespace
          on index_namespace.oid = index_class.relnamespace
        where index_namespace.nspname = 'public'
          and index_class.relname = 'sigint_inbox_item_network_network_inbox_uq'
          and index_state.indisunique
          and index_state.indisvalid
          and index_state.indisready
    ) and pg_relation_size('public.sigint_inbox_item_network') >= 134217728
    then
        raise exception using message =
            'run oneoff-prepare-inbox-network-uniqueness before applying this migration';
    end if;
end
$$;

delete from sigint_inbox_item_network duplicate
using sigint_inbox_item_network retained
where duplicate.sigint_network_id = retained.sigint_network_id
  and duplicate.sigint_inbox_item_id = retained.sigint_inbox_item_id
  and duplicate.id > retained.id
  and not exists (
      select 1
      from pg_index index_state
      join pg_class index_class
        on index_class.oid = index_state.indexrelid
      join pg_namespace index_namespace
        on index_namespace.oid = index_class.relnamespace
      where index_namespace.nspname = 'public'
        and index_class.relname = 'sigint_inbox_item_network_network_inbox_uq'
        and index_state.indisunique
        and index_state.indisvalid
        and index_state.indisready
  );

create unique index if not exists
    sigint_inbox_item_network_network_inbox_uq
    on sigint_inbox_item_network (
        sigint_network_id,
        sigint_inbox_item_id
    );

do $$
begin
    if not exists (
        select 1
        from pg_index index_state
        join pg_class index_class
          on index_class.oid = index_state.indexrelid
        join pg_namespace index_namespace
          on index_namespace.oid = index_class.relnamespace
        where index_namespace.nspname = 'public'
          and index_class.relname = 'sigint_inbox_item_network_network_inbox_uq'
          and index_state.indrelid =
              'public.sigint_inbox_item_network'::regclass
          and index_state.indisunique
          and index_state.indisvalid
          and index_state.indisready
          and index_state.indpred is null
          and index_state.indexprs is null
          and index_state.indnkeyatts = 2
          and (
              select array_agg(
                  attribute.attname order by index_column.ordinality
              )
              from unnest(index_state.indkey) with ordinality
                  as index_column(attribute_number, ordinality)
              join pg_attribute attribute
                on attribute.attrelid = index_state.indrelid
               and attribute.attnum = index_column.attribute_number
          ) = array[
              'sigint_network_id',
              'sigint_inbox_item_id'
          ]::name[]
    ) then
        raise exception using message =
            'run oneoff-prepare-inbox-network-uniqueness before applying this migration';
    end if;
end
$$;

drop index if exists sigint_inbox_item_network_network_inbox_idx;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create index if not exists sigint_inbox_item_network_network_inbox_idx
    on sigint_inbox_item_network (sigint_network_id, sigint_inbox_item_id);

drop index if exists sigint_inbox_item_network_network_inbox_uq;
                "#,
            )
            .await?;
        Ok(())
    }
}

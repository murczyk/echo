use sea_orm_migration::prelude::*;

pub const DATETIME_NEO_BACKFILL_BATCH_SQL: &str = r#"
with batch as materialized (
    select id, datetime
    from sigint_inbox_item
    where datetime is not null
        and datetime_neo is null
        and (
            $1::timestamp is null
            or (datetime, id) > ($1, $2)
        )
    order by datetime asc, id asc
    limit $3
),
updated as (
    update sigint_inbox_item as item
    set datetime_neo = item.datetime
    from batch
    where item.id = batch.id
        and item.datetime_neo is null
    returning item.id
)
select
    (select count(*)::bigint from batch) as selected_count,
    (select count(*)::bigint from updated) as updated_count,
    (
        select datetime
        from batch
        order by datetime desc, id desc
        limit 1
    ) as cursor_datetime,
    (
        select id
        from batch
        order by datetime desc, id desc
        limit 1
    ) as cursor_id
"#;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table sigint_inbox_item
    add column datetime_neo timestamp without time zone;

create index sigint_inbox_item_datetime_neo_idx
    on sigint_inbox_item (datetime_neo desc);
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
drop index sigint_inbox_item_datetime_neo_idx;

alter table sigint_inbox_item
    drop column datetime_neo;
                "#,
            )
            .await?;
        Ok(())
    }
}

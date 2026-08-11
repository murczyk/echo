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
drop index if exists failed_inbox_unit_inbox_item_id_uq;
drop index if exists sigint_inbox_item_unit_parsed_item_id_uq;

create unique index if not exists failed_inbox_unit_inbox_item_text_uq
    on failed_inbox_unit (
        inbox_item_id,
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))
    );
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
drop index if exists failed_inbox_unit_inbox_item_text_uq;

with ranked_failed_inbox_units as (
    select
        id,
        row_number() over (
            partition by inbox_item_id
            order by deleted asc, id asc
        ) as row_number
    from failed_inbox_unit
)
delete from failed_inbox_unit
using ranked_failed_inbox_units
where failed_inbox_unit.id = ranked_failed_inbox_units.id
    and ranked_failed_inbox_units.row_number > 1;

with ranked_parsed_unit_links as (
    select
        id,
        row_number() over (partition by item_id order by id asc) as row_number
    from sigint_inbox_item_unit
    where kind = 'parsed'
)
delete from sigint_inbox_item_unit
using ranked_parsed_unit_links
where sigint_inbox_item_unit.id = ranked_parsed_unit_links.id
    and ranked_parsed_unit_links.row_number > 1;

create unique index if not exists failed_inbox_unit_inbox_item_id_uq
    on failed_inbox_unit (inbox_item_id);

create unique index if not exists sigint_inbox_item_unit_parsed_item_id_uq
    on sigint_inbox_item_unit (item_id)
    where kind = 'parsed';
                "#,
            )
            .await?;
        Ok(())
    }
}

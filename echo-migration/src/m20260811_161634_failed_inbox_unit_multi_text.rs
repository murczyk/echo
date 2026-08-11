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

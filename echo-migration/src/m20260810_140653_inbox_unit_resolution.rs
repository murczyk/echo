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
create table failed_inbox_unit (
    id bigserial primary key,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    deleted boolean default false not null,
    is_bad_data boolean default false not null,
    inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
    unit_txt text not null check (btrim(unit_txt) <> ''),
    deleted_at timestamp without time zone
);

create unique index failed_inbox_unit_inbox_item_id_uq
    on failed_inbox_unit (inbox_item_id);

create index failed_inbox_unit_active_text_idx
    on failed_inbox_unit (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g')),
        id
    )
    where deleted = false and is_bad_data = false;

create index failed_inbox_unit_pending_idx
    on failed_inbox_unit (deleted_at, id)
    where deleted = true;

create table sigint_unit_label (
    id bigserial primary key,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    sigint_unit_id bigint not null references sigint_unit(id) on delete cascade,
    label text not null check (char_length(btrim(label)) >= 2)
);

create unique index sigint_unit_label_normalized_uq
    on sigint_unit_label (
        lower(regexp_replace(btrim(label), '[[:space:]]+', ' ', 'g'))
    );

create index sigint_unit_label_sigint_unit_id_idx
    on sigint_unit_label (sigint_unit_id, id);
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
drop table if exists sigint_unit_label;
drop table if exists failed_inbox_unit;
                "#,
            )
            .await?;
        Ok(())
    }
}

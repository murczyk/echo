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
alter table sigint_inbox_item_settlement
    drop constraint sigint_inbox_item_settlement_check,
    add constraint sigint_inbox_item_settlement_check
        check (is_undefined is not true or settlement_id is null);

create function sigint_inbox_item_settlement_requeue_deleted()
returns trigger language plpgsql as $$
begin
    new.is_undefined = null;
    return new;
end;
$$;

create trigger sigint_inbox_item_settlement_requeue_deleted
before update of settlement_id on sigint_inbox_item_settlement
for each row
when (old.settlement_id is not null and new.settlement_id is null
      and new.is_undefined is false)
execute function sigint_inbox_item_settlement_requeue_deleted();
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
drop trigger sigint_inbox_item_settlement_requeue_deleted
    on sigint_inbox_item_settlement;
drop function sigint_inbox_item_settlement_requeue_deleted();

update sigint_inbox_item_settlement
set is_undefined = null
where is_undefined is false;

alter table sigint_inbox_item_settlement
    drop constraint sigint_inbox_item_settlement_check,
    add constraint sigint_inbox_item_settlement_check
        check (is_undefined is null or (is_undefined and settlement_id is null));
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

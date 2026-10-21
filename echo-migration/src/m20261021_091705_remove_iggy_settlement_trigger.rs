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
drop trigger sigint_inbox_item_settlement_capture_iggy_link
    on sigint_inbox_item_settlement;
drop function capture_api_integration_iggy_inbox_settlement();
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
create function capture_api_integration_iggy_inbox_settlement()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' and old.settlement_id is not null
        and (tg_op = 'DELETE' or old.settlement_id is distinct from new.settlement_id
            or old.item_id is distinct from new.item_id) then
        if not exists (
            select 1 from sigint_inbox_item_settlement other
            where other.item_id = old.item_id
                and other.settlement_id = old.settlement_id
                and other.id <> old.id
        ) then
            perform queue_api_integration_iggy_event(
                old.item_id,
                jsonb_build_object(
                    'event_type', 'sigint_inbox_item_settlement_unlinked',
                    'settlement_id', old.settlement_id
                )
            );
        end if;
    end if;
    if tg_op <> 'DELETE' and new.settlement_id is not null
        and (tg_op = 'INSERT' or old.settlement_id is distinct from new.settlement_id
            or old.item_id is distinct from new.item_id) then
        perform queue_api_integration_iggy_event(
            new.item_id,
            jsonb_build_object(
                'event_type', 'sigint_inbox_item_settlement_linked',
                'settlement_id', new.settlement_id
            )
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger sigint_inbox_item_settlement_capture_iggy_link
after insert or update or delete on sigint_inbox_item_settlement
for each row execute function capture_api_integration_iggy_inbox_settlement();
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            drop table if exists sigint_inbox_item_point_tokens;

            create table sigint_inbox_item_point_token (
                id bigserial primary key,
                sigint_inbox_item_id int8 not null references sigint_inbox_item(id) on delete cascade,
                palitra_id int8 not null references palitra(id) on delete cascade,
                point_tokens jsonb not null,
                constraint sigint_inbox_item_point_token_uq unique (sigint_inbox_item_id, palitra_id)
            );
            create index sigint_inbox_item_point_token_sigint_inbox_item_id_idx on sigint_inbox_item_point_token(sigint_inbox_item_id);
            create index sigint_inbox_item_point_token_sigint_palitra_id_idx on sigint_inbox_item_point_token(palitra_id);
             "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            drop table if exists sigint_inbox_item_point_token;
            create table sigint_inbox_item_point_tokens (
                id bigserial primary key,
                sigint_inbox_item_id int8 not null references sigint_inbox_item(id) on delete cascade,
                scope_type text not null,
                scope_id text,
                point_tokens jsonb not null,
                constraint sigint_inbox_item_point_token_sigint_inbox_item_id_scope_ty_key unique (sigint_inbox_item_id, scope_type, scope_id)
            );
             "#,
        )
        .await?;

        Ok(())
    }
}

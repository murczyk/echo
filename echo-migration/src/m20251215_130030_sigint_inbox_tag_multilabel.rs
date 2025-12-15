use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                alter table sigint_inbox_item_tag
                    drop constraint if exists sigint_inbox_item_tag_uniq;
                alter table sigint_inbox_item_tag
                    drop constraint if exists sigint_inbox_item_tag_unique_actor;
                alter table sigint_inbox_item_tag
                    add constraint sigint_inbox_item_tag_unique_actor unique(sigint_inbox_item_id, tag_id, login, model);

                create table sigint_inbox_tag_model_error (
                    id bigserial primary key,
                    sigint_inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
                    tag_id bigint not null references tag(id),
                    model text not null,
                    model_login text null references login(login),
                    confidence float8 not null,
                    removed_by_login text not null references login(login),
                    removed_at timestamptz not null default now()
                );
                create index sigint_inbox_tag_model_error_item_tag_idx
                    on sigint_inbox_tag_model_error(sigint_inbox_item_id, tag_id);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                drop table if exists sigint_inbox_tag_model_error;

                alter table sigint_inbox_item_tag
                    drop constraint if exists sigint_inbox_item_tag_unique_actor;
                alter table sigint_inbox_item_tag
                    add constraint sigint_inbox_item_tag_uniq unique(sigint_inbox_item_id, tag_id);
                "#,
            )
            .await?;
        Ok(())
    }
}

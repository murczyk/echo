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
                do $$
                begin
                    create type intel_prod_relation_kind as enum ('report', 'comment');
                exception
                    when duplicate_object then null;
                end $$;

                alter table intel_prod
                    add column if not exists relation_kind intel_prod_relation_kind;

                update intel_prod
                set relation_kind = 'comment'
                from sigint_comment
                where sigint_comment.migrated_signal_message_id = intel_prod.signal_message_id
                  and sigint_comment.signal_message_id = intel_prod.parent_signal_message_id;

                update intel_prod
                set relation_kind = 'report'
                where relation_kind is null;

                alter table intel_prod
                    alter column relation_kind set default 'report',
                    alter column relation_kind set not null;

                create index if not exists idx_intel_prod_relation_kind_parent
                    on intel_prod(relation_kind, parent_signal_message_id);
                "#,
            )
            .await
            .map(|_| ())
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop index if exists idx_intel_prod_relation_kind_parent;
                alter table intel_prod drop column if exists relation_kind;
                drop type if exists intel_prod_relation_kind;
                "#,
            )
            .await
            .map(|_| ())
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))
    }
}

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
                    create type intel_product_relation_kind as enum ('report', 'comment');
                exception
                    when duplicate_object then null;
                end $$;

                alter table intel_product
                    add column if not exists relation_kind intel_product_relation_kind;

                update intel_product
                set relation_kind = 'comment'
                from sigint_comment
                where sigint_comment.migrated_signal_message_id = intel_product.intel_message_id
                  and sigint_comment.signal_message_id = intel_product.source_message_id;

                update intel_product
                set relation_kind = 'report'
                where relation_kind is null;

                alter table intel_product
                    alter column relation_kind set default 'report',
                    alter column relation_kind set not null;

                create index if not exists idx_intel_product_relation_kind_source
                    on intel_product(relation_kind, source_message_id);
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
                drop index if exists idx_intel_product_relation_kind_source;
                alter table intel_product drop column if exists relation_kind;
                drop type if exists intel_product_relation_kind;
                "#,
            )
            .await
            .map(|_| ())
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))
    }
}

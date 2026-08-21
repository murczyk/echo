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
                alter table sigint_comment
                    add column if not exists migrated_signal_message_id bigint;

                alter table sigint_comment
                    drop constraint if exists sigint_comment_migrated_signal_message_id_fkey;

                alter table sigint_comment
                    add constraint sigint_comment_migrated_signal_message_id_fkey
                    foreign key (migrated_signal_message_id)
                    references signal_message(id)
                    on delete set null;

                create unique index if not exists sigint_comment_migrated_message_uq
                    on sigint_comment(migrated_signal_message_id)
                    where migrated_signal_message_id is not null;
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
                drop index if exists sigint_comment_migrated_message_uq;
                alter table sigint_comment
                    drop constraint if exists sigint_comment_migrated_signal_message_id_fkey;
                alter table sigint_comment
                    drop column if exists migrated_signal_message_id;
                "#,
            )
            .await
            .map(|_| ())
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))
    }
}

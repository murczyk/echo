use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create index if not exists echo_missing_message_created_at_id_idx
                    on echo_missing_message (created_at desc, id desc);

                do $$
                begin
                    if to_regclass('public.echo_restapi_error') is not null then
                        execute 'create index if not exists echo_restapi_error_created_at_id_idx
                            on echo_restapi_error (created_at desc, id desc)';
                    end if;
                end
                $$;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists echo_missing_message_created_at_id_idx;
                drop index if exists echo_restapi_error_created_at_id_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}

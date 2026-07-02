use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists sigint_comment (
                    id bigserial primary key,
                    login text references login(login) not null,
                    signal_message_id bigint references signal_message(id) not null,
                    comment text not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

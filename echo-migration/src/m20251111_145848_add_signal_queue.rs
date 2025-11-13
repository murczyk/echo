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
                create table signal_message_queue  (
                    id bigserial primary key,
                    datasource_id int8 REFERENCES datasource (id) not null,
                    internal_id int8 not null,
                    external_id text,
                    body text not null,
                    sender_id text,
                    sender_name text,
                    sender_phone_number text,
                    group_id text,
                    timestamp timestamp without time zone not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                CREATE TABLE signal_message_queue_attachment (
                    id bigserial primary key,
                    message_id int8 not null references signal_message_queue(id) on delete cascade,
                    path TEXT NOT NULL,
                    name TEXT NULL,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );
               "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "
                drop table signal_message_queue_attachment;
                drop table signal_message_queue;
                ",
            )
            .await;
        Ok(())
    }
}

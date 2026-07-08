use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter type echo_missing_message_status
                    rename to echo_missing_message_status_old;

                create type echo_missing_message_status as enum (
                    'pending',
                    'scheduled',
                    'error',
                    'resolved',
                    'deleted',
                    'duplicate'
                );

                alter table echo_missing_message
                    alter column status drop default;

                alter table echo_missing_message
                    alter column status type echo_missing_message_status
                    using status::text::echo_missing_message_status;

                alter table echo_missing_message
                    alter column status set default 'pending';

                drop type echo_missing_message_status_old;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                update echo_missing_message
                set
                    status = 'error',
                    is_resolved = false,
                    resolved_at = null,
                    error = coalesce(error, 'duplicate')
                where status = 'duplicate';

                alter type echo_missing_message_status
                    rename to echo_missing_message_status_old;

                create type echo_missing_message_status as enum (
                    'pending',
                    'scheduled',
                    'error',
                    'resolved',
                    'deleted'
                );

                alter table echo_missing_message
                    alter column status drop default;

                alter table echo_missing_message
                    alter column status type echo_missing_message_status
                    using status::text::echo_missing_message_status;

                alter table echo_missing_message
                    alter column status set default 'pending';

                drop type echo_missing_message_status_old;
            "#,
        )
        .await?;
        Ok(())
    }
}

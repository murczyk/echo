use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                alter table system_settings
                    add column if not exists rer_duty_test_replay_interval_sec int8;

                update system_settings
                set rer_duty_test_replay_interval_sec = greatest(rer_duty_poll_interval_sec, 1),
                    rer_duty_test_enabled = rer_duty_test_enabled and rer_duty_insert_historical_interceptions,
                    rer_duty_insert_historical_interceptions = rer_duty_test_enabled and rer_duty_insert_historical_interceptions;

                alter table system_settings
                    alter column rer_duty_test_replay_interval_sec set default 1;
                alter table system_settings
                    alter column rer_duty_test_replay_interval_sec set not null;

                create index if not exists sigint_comment_rer_duty_test_replay_idx
                    on sigint_comment (created_at desc, signal_message_id)
                    where comment = '[duplicate]';

                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop index if exists sigint_comment_rer_duty_test_replay_idx;
                alter table system_settings
                    drop column if exists rer_duty_test_replay_interval_sec;
                "#,
            )
            .await?;
        Ok(())
    }
}

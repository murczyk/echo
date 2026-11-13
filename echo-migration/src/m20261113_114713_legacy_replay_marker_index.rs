use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

/// Restores the partial index on the comment the message replay before #4110
/// put on its copies, which `m20261111_090000_message_replay_session` dropped.
/// The replay worker purges the copies that replay left behind through it;
/// without it each batch scans every system comment.
///
/// Runs without a transaction because of `create index concurrently`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create index concurrently if not exists sigint_comment_rer_duty_test_replay_idx
    on sigint_comment (created_at desc, signal_message_id)
    where comment = '[duplicate]';
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index concurrently if exists sigint_comment_rer_duty_test_replay_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}

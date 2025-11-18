use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'signal_message_group'::regclass
      AND contype = 'f'
      AND confrelid = 'signal_group'::regclass;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE signal_message_group DROP CONSTRAINT %I', constraint_name);
    END IF;

    EXECUTE $stmt$
        ALTER TABLE signal_message_group
        ADD CONSTRAINT signal_message_group_group_master_key_fkey
        FOREIGN KEY (group_master_key) REFERENCES signal_group(master_key)
        ON DELETE CASCADE
    $stmt$;
END $$;
            ",
        )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            ALTER TABLE signal_message_group DROP CONSTRAINT signal_message_group_group_master_key_fkey;
            ",
        )
            .await?;

        Ok(())
    }
}

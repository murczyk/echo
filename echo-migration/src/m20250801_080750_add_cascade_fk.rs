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
    WHERE conrelid = 'sigint_network_description'::regclass
      AND contype = 'f'
      AND confrelid = 'sigint_network_freq'::regclass;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sigint_network_description DROP CONSTRAINT %I', constraint_name);
    END IF;

    EXECUTE $stmt$
        ALTER TABLE sigint_network_description
        ADD CONSTRAINT sigint_network_description_sigint_network_freq_id_fkey
        FOREIGN KEY (sigint_network_freq_id) REFERENCES sigint_network_freq(id)
        ON DELETE CASCADE
    $stmt$;
END $$;
            ",
        )
            .await?;

        db.execute_unprepared(
            "
DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'sigint_network_description'::regclass
      AND contype = 'f'
      AND confrelid = 'sigint_network'::regclass;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sigint_network_description DROP CONSTRAINT %I', constraint_name);
    END IF;

    EXECUTE $stmt$
        ALTER TABLE sigint_network_description
        ADD CONSTRAINT sigint_network_description_sigint_network_id_fkey
        FOREIGN KEY (network_id) REFERENCES sigint_network(id)
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
DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'sigint_network_description'::regclass
      AND contype = 'f'
      AND confrelid = 'sigint_network_freq'::regclass;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sigint_network_description DROP CONSTRAINT %I', constraint_name);
    END IF;

    EXECUTE $stmt$
        ALTER TABLE sigint_network_description
        ADD CONSTRAINT sigint_network_description_sigint_network_freq_id_fkey
        FOREIGN KEY (sigint_network_freq_id) REFERENCES sigint_network_freq(id)
    $stmt$;
END $$;
            ",
        )
            .await?;

        db.execute_unprepared(
            "
DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'sigint_network_description'::regclass
      AND contype = 'f'
      AND confrelid = 'sigint_network'::regclass;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sigint_network_description DROP CONSTRAINT %I', constraint_name);
    END IF;

    EXECUTE $stmt$
        ALTER TABLE sigint_network_description
        ADD CONSTRAINT sigint_network_description_sigint_network_id_fkey
        FOREIGN KEY (network_id) REFERENCES sigint_network(id)
    $stmt$;
END $$;
            ",
        )
            .await?;

        Ok(())
    }
}

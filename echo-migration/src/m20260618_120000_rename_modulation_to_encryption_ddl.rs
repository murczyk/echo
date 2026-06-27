use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'encryption'
                ) THEN
                    CREATE TABLE encryption (
                        id               INTEGER   NOT NULL,
                        name             TEXT      NOT NULL,
                        enabled          BOOLEAN   NOT NULL DEFAULT true,
                        created_at       TIMESTAMP NOT NULL DEFAULT now(),
                        sigint_origin_id BIGINT    REFERENCES sigint_origin(id) ON DELETE SET NULL,
                        mothership_id    INTEGER,
                        PRIMARY KEY (id)
                    );
                END IF;
            END $$;
            INSERT INTO encryption (id, name, enabled, created_at) VALUES
                (1, 'Без шифрування', true, now()),
                (2, 'ARC40',          true, now()),
                (3, 'AES256',         true, now()),
                (4, 'TYT (16 bit)',   true, now()),
                (5, 'TYT (128 bit)', true, now()),
                (6, 'Не визначено',  true, now())
            ON CONFLICT (id) DO NOTHING;
            ALTER TABLE sigint_network_freq
                ADD COLUMN IF NOT EXISTS modulation    TEXT    NOT NULL DEFAULT 'NFM';
            ALTER TABLE sigint_network_freq
                ADD COLUMN IF NOT EXISTS encryption_id INTEGER
                    REFERENCES encryption(id) ON DELETE SET NULL;
            ALTER TABLE sigint_network_encryption_key
                ADD COLUMN IF NOT EXISTS encryption_id BIGINT
                    REFERENCES encryption(id) ON DELETE NO ACTION;",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE sigint_network_encryption_key DROP COLUMN IF EXISTS encryption_id;
             ALTER TABLE sigint_network_freq           DROP COLUMN IF EXISTS encryption_id;
             ALTER TABLE sigint_network_freq           DROP COLUMN IF EXISTS modulation;
             DROP TABLE IF EXISTS encryption;",
        )
        .await?;
        Ok(())
    }
}

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
                    REFERENCES encryption(id) ON DELETE NO ACTION;
            WITH freq_mods AS (
                SELECT snf.id, snf.kind::text AS kind, m.name AS old_mod
                FROM sigint_network_freq snf
                LEFT JOIN modulation m ON m.id = snf.modulation_id
            )
            UPDATE sigint_network_freq snf
            SET
                modulation = CASE
                    WHEN fm.kind = 'VHF'
                         AND (fm.old_mod IS NULL OR fm.old_mod = 'NFM') THEN 'NFM'
                    WHEN fm.kind = 'VHF' AND fm.old_mod = 'AM'         THEN 'AM'
                    ELSE 'DMR'
                END,
                encryption_id = (
                    SELECT e.id FROM encryption e
                    WHERE e.name = CASE
                        WHEN fm.old_mod = 'DMR (ARC40)'                             THEN 'ARC40'
                        WHEN fm.old_mod IN ('DMR (AES256)', 'HYTERA (256 bit)')     THEN 'AES256'
                        WHEN fm.old_mod IN ('TYT', 'TYT (128 bit)')                THEN 'TYT (128 bit)'
                        WHEN fm.old_mod = 'TYT (16 bit)'                           THEN 'TYT (16 bit)'
                        WHEN fm.kind = 'VHF'
                             AND (fm.old_mod IS NULL
                                  OR fm.old_mod IN ('NFM', 'AM', 'DMR'))           THEN 'Без шифрування'
                        ELSE 'Не визначено'
                    END
                    LIMIT 1
                )
            FROM freq_mods fm
            WHERE snf.id = fm.id;
            UPDATE sigint_network_encryption_key k
            SET encryption_id = (
                SELECT e.id FROM encryption e
                WHERE e.name = CASE
                    WHEN m.name = 'DMR (ARC40)'                             THEN 'ARC40'
                    WHEN m.name IN ('DMR (AES256)', 'HYTERA (256 bit)')     THEN 'AES256'
                    WHEN m.name IN ('TYT', 'TYT (128 bit)')                THEN 'TYT (128 bit)'
                    WHEN m.name = 'TYT (16 bit)'                           THEN 'TYT (16 bit)'
                    ELSE 'Не визначено'
                END
                LIMIT 1
            )
            FROM modulation m
            WHERE k.modulation_id = m.id AND k.encryption_id IS NULL;",
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

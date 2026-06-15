use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        // Save original (kind, modulation_id) before any transformation — used by down()
        db.execute_unprepared(
            "
            CREATE TABLE _mig_freq_backup AS
                SELECT id, kind::text AS kind, modulation_id
                FROM sigint_network_freq;

            CREATE TABLE _mig_enc_key_backup AS
                SELECT id, modulation_id
                FROM sigint_network_encryption_key;
        ",
        )
        .await?;

        // Insert new encryption target records and add modulation text column
        db.execute_unprepared("
            INSERT INTO modulation (id, name, lft, rgt) VALUES
                (20, 'Без шифрування', 270, 279),
                (21, 'ARC40', 280, 289),
                (22, 'AES256', 290, 299),
                (23, 'Не визначено', 300, 309);

            ALTER TABLE sigint_network_freq ADD COLUMN modulation text;

            UPDATE sigint_network_freq SET modulation =
                CASE
                    WHEN modulation_id = 1                       THEN 'NFM'
                    WHEN modulation_id = 2                       THEN 'AM'
                    WHEN modulation_id IS NULL AND kind = 'VHF'  THEN 'NFM'
                    ELSE 'DMR'
                END;

            ALTER TABLE sigint_network_freq ALTER COLUMN modulation SET NOT NULL;
        ").await?;

        // Remap modulation_id → new encryption IDs
        db.execute_unprepared("
            UPDATE sigint_network_freq SET modulation_id =
                CASE modulation_id
                    WHEN 8  THEN 11
                    WHEN 1  THEN 20  WHEN 2  THEN 20  WHEN 3  THEN 20  WHEN 6  THEN 20
                    WHEN 4  THEN 21
                    WHEN 5  THEN 22  WHEN 7  THEN 22
                    WHEN 12 THEN 23  WHEN 13 THEN 23  WHEN 14 THEN 23  WHEN 15 THEN 23
                    ELSE 23
                END;

            UPDATE sigint_network_encryption_key SET modulation_id =
                CASE modulation_id
                    WHEN 8  THEN 11
                    WHEN 1  THEN 20  WHEN 2  THEN 20  WHEN 3  THEN 20  WHEN 6  THEN 20
                    WHEN 4  THEN 21
                    WHEN 5  THEN 22  WHEN 7  THEN 22
                    WHEN 12 THEN 23  WHEN 13 THEN 23  WHEN 14 THEN 23  WHEN 15 THEN 23
                    ELSE modulation_id
                END;

            DELETE FROM modulation WHERE id IN (1,2,3,4,5,6,7,8,12,13,14,15);
        ").await?;

        // Structural renames
        db.execute_unprepared("
            ALTER TABLE sigint_network_freq DROP COLUMN kind;
            ALTER TABLE sigint_network_freq RENAME COLUMN modulation_id TO encryption_id;
            ALTER TABLE sigint_network_encryption_key RENAME COLUMN modulation_id TO encryption_id;
            ALTER TABLE modulation RENAME TO encryption;
            DROP TYPE sigint_network_kind;
        ").await?;

        // DMRe → DMR; analog modulations have no encryption
        db.execute_unprepared("
            UPDATE sigint_network_freq SET modulation = 'DMR' WHERE modulation = 'DMRe';
            UPDATE sigint_network_freq SET encryption_id = NULL WHERE modulation IN ('NFM', 'AM');
        ").await?;

        // Reset encryption IDs to sequential 1-6
        db.execute_unprepared("
            INSERT INTO encryption (id, name, lft, rgt, enabled, created_at) VALUES
                (1, 'Без шифрування', 1, 2, true, now()),
                (2, 'ARC40', 3, 4, true, now()),
                (3, 'AES256', 5, 6, true, now()),
                (4, 'TYT (16 bit)', 7, 8, true, now()),
                (5, 'TYT (128 bit)', 9, 10, true, now()),
                (6, 'Не визначено', 11, 12, true, now());

            UPDATE sigint_network_freq SET encryption_id =
                CASE encryption_id
                    WHEN 20 THEN 1  WHEN 21 THEN 2  WHEN 22 THEN 3
                    WHEN 10 THEN 4  WHEN 11 THEN 5  WHEN 23 THEN 6
                    ELSE encryption_id
                END;

            UPDATE sigint_network_encryption_key SET encryption_id =
                CASE encryption_id
                    WHEN 20 THEN 1  WHEN 21 THEN 2  WHEN 22 THEN 3
                    WHEN 10 THEN 4  WHEN 11 THEN 5  WHEN 23 THEN 6
                    ELSE encryption_id
                END;

            DELETE FROM encryption WHERE id IN (10, 11, 20, 21, 22, 23);
        ").await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        // Step 1: Rename table and columns — keep modulation text column for now (needed below)
        db.execute_unprepared("
            CREATE TYPE sigint_network_kind AS ENUM ('DMR', 'DMRe', 'VHF');

            ALTER TABLE encryption RENAME TO modulation;
            ALTER TABLE sigint_network_encryption_key RENAME COLUMN encryption_id TO modulation_id;
            ALTER TABLE sigint_network_freq RENAME COLUMN encryption_id TO modulation_id;

            ALTER TABLE sigint_network_freq ADD COLUMN kind sigint_network_kind NOT NULL DEFAULT 'VHF';

            UPDATE sigint_network_freq SET kind =
                CASE modulation WHEN 'NFM' THEN 'VHF'::sigint_network_kind
                                ELSE 'DMR'::sigint_network_kind END;
        ").await?;

        // Step 2: Fix the ID conflict — modulation table has ids 1-6 with new names,
        // we need old names there. Update 1-6 in-place, insert 7-15 fresh (no conflict).
        db.execute_unprepared("
            UPDATE modulation SET name='NFM',              lft=100, rgt=109 WHERE id=1;
            UPDATE modulation SET name='AM',               lft=110, rgt=119 WHERE id=2;
            UPDATE modulation SET name='DMR',              lft=120, rgt=159 WHERE id=3;
            UPDATE modulation SET name='DMR (ARC40)',      lft=130, rgt=139 WHERE id=4;
            UPDATE modulation SET name='DMR (AES256)',     lft=140, rgt=149 WHERE id=5;
            UPDATE modulation SET name='HYTERA',           lft=160, rgt=189 WHERE id=6;

            INSERT INTO modulation (id, name, lft, rgt) VALUES
                (7,  'HYTERA (256 bit)', 170, 179),
                (8,  'TYT',              190, 229),
                (9,  'TYT (VEDA)',       200, 209),
                (10, 'TYT (16 bit)',     210, 219),
                (11, 'TYT (128 bit)',    220, 229),
                (12, 'TETRA',            230, 239),
                (13, 'Граніт',           240, 249),
                (14, 'GSM',              250, 259),
                (15, 'Умовна',           260, 269);
        ").await?;

        // Step 3: Restore modulation_id.
        //   - Rows from before migration → exact value from backup.
        //   - New rows (not in backup) → derive from (modulation text, old encryption_id).
        //     The CASE values 1-6 correspond to what was encryption_id before the rename:
        //     1=Без шифр., 2=ARC40, 3=AES256, 4=TYT16, 5=TYT128, 6=Не визначено.
        db.execute_unprepared("
            UPDATE sigint_network_freq f
            SET modulation_id = COALESCE(
                (SELECT b.modulation_id FROM _mig_freq_backup b WHERE b.id = f.id),
                CASE
                    WHEN f.modulation = 'NFM'     THEN 1
                    WHEN f.modulation = 'AM'      THEN 2
                    WHEN f.modulation_id = 2      THEN 4
                    WHEN f.modulation_id = 3      THEN 5
                    WHEN f.modulation_id = 4      THEN 10
                    WHEN f.modulation_id = 5      THEN 11
                    WHEN f.modulation_id = 6      THEN 12
                    ELSE 3
                END
            );

            UPDATE sigint_network_encryption_key k
            SET modulation_id = COALESCE(
                (SELECT b.modulation_id FROM _mig_enc_key_backup b WHERE b.id = k.id),
                CASE k.modulation_id
                    WHEN 2 THEN 4   WHEN 3 THEN 5
                    WHEN 4 THEN 10  WHEN 5 THEN 11  WHEN 6 THEN 12
                    WHEN 1 THEN 3
                    ELSE k.modulation_id
                END
            );

            ALTER TABLE sigint_network_freq DROP COLUMN modulation;
            DROP TABLE _mig_freq_backup;
            DROP TABLE _mig_enc_key_backup;
        ").await?;

        Ok(())
    }
}

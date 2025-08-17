use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // add kind column to sigint_network_freq table
        db.execute_unprepared("ALTER TABLE sigint_network_freq ADD COLUMN kind sigint_network_kind;").await?;

        // add modulation to sigint_network_freq table and create foreign key for it
        db.execute_unprepared(
            "ALTER TABLE sigint_network_freq
                ADD COLUMN modulation_id INT,
                ADD CONSTRAINT fk_modulation
                    FOREIGN KEY (modulation_id)
                    REFERENCES modulation(id)
                    ON DELETE SET NULL;
                ",
        )
        .await?;

        // populate modulation_id and kind in sigint_network_freq table from sigint_network for ALL freqs in the network
        db.execute_unprepared(
            "UPDATE sigint_network_freq
                SET modulation_id = sigint_network.modulation_id,
                    kind = sigint_network.kind
                FROM sigint_network
                WHERE sigint_network_freq.network_id = sigint_network.id",
        )
        .await?;

        // drop columns kind and modulation_id from sigint_network table, drop foreign key constraint
        db.execute_unprepared(
            "ALTER TABLE sigint_network
                    DROP CONSTRAINT fk_modulation,
                    DROP COLUMN kind,
                    DROP COLUMN modulation_id;
                    ",
        )
        .await?;

        // Set kind column not null in sigint_network_freq
        db.execute_unprepared(
            "ALTER TABLE sigint_network_freq ALTER COLUMN kind SET NOT NULL;",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // add kind column to sigint_network table
        db.execute_unprepared(
            "ALTER TABLE sigint_network ADD COLUMN kind sigint_network_kind;",
        )
        .await?;

        // add modulation to sigint_network table and create foreign key for it
        db.execute_unprepared(
            "ALTER TABLE sigint_network
                ADD COLUMN modulation_id INT,
                ADD CONSTRAINT fk_modulation
                    FOREIGN KEY (modulation_id)
                    REFERENCES modulation(id)
                    ON DELETE SET NULL;
                ",
        )
        .await?;

        // populate modulation_id and kind in sigint_network table from sigint_network_freq
        db.execute_unprepared(
            "UPDATE sigint_network
                SET
                    modulation_id = nf.modulation_id,
                    kind = nf.kind
                FROM (
                    SELECT DISTINCT ON (network_id) *
                    FROM sigint_network_freq
                    ORDER BY network_id, id
                ) nf
                WHERE nf.network_id = sigint_network.id;",
        )
        .await?;

        // drop columns kind and modulation_id from sigint_network_freq table, drop foreign key constraint
        db.execute_unprepared(
            "ALTER TABLE sigint_network_freq
                    DROP CONSTRAINT fk_modulation,
                    DROP COLUMN kind,
                    DROP COLUMN modulation_id;
                    ",
        )
        .await?;

        // Set kind column not null in sigint_network
        db.execute_unprepared(
            "ALTER TABLE sigint_network ALTER COLUMN kind SET NOT NULL;",
        )
        .await?;

        Ok(())
    }
}

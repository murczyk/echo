use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // Add modulation table
        db.execute_unprepared(
            "CREATE TABLE modulation (
                id int PRIMARY KEY,
                name text NOT NULL,
                lft int NOT NULL,
                rgt int NOT NULL,
                enabled boolean NOT NULL DEFAULT true,
                created_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
                );") 
        .await?;

        // populate modulation table from file
        db.execute_unprepared(
            "INSERT INTO modulation (id, name, lft, rgt) VALUES
                (1, 'NFM', 100, 109),
                (2, 'AM', 110, 119),

                (3, 'DMR', 120, 159),
                (4, 'DMR (ARC40)', 130, 139),
                (5, 'DMR (AES256)', 140, 149),

                (6, 'HYTERA', 160, 189),
                (7, 'HYTERA (256 bit)', 170, 179),

                (8, 'TYT', 190, 229),
                (9, 'TYT (VEDA)', 200, 209),
                (10, 'TYT (16 bit)', 210, 219),
                (11, 'TYT (128 bit)', 220, 229),

                (12, 'TETRA', 230, 239),
                (13, 'Граніт', 240, 249),
                (14, 'GSM', 250, 259);",
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

        // populate modulation_id in sigint_network table from trans_type field
        db.execute_unprepared(
            "UPDATE sigint_network
                SET modulation_id = modulation.id
                FROM modulation
                WHERE sigint_network.trans_type::text = modulation.name;",
        )
        .await?;

        // drop column trans_type from sigint_network table
        db.execute_unprepared(
            "ALTER TABLE sigint_network DROP COLUMN trans_type;",
        )
        .await?;

        // drop user defined data type for network transmission type
        db.execute_unprepared("DROP TYPE sigint_network_transmission_type;")
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        // create new user defined data type for network transmission type
        db.execute_unprepared(
            "CREATE TYPE sigint_network_transmission_type AS ENUM ('NFM', 'AM', 'DMR');",
        )
        .await?;

        // add new columns to sigint_network
        db.execute_unprepared(
            "ALTER TABLE sigint_network ADD COLUMN trans_type sigint_network_transmission_type not null default 'NFM';",
        )
        .await?;

        // populate modulation_id in sigint_network table from trans_type field
        db.execute_unprepared(
            "UPDATE sigint_network
                SET trans_type = modulation.name::sigint_network_transmission_type
                FROM modulation
                WHERE sigint_network.modulation_id = modulation.id;",
        )
        .await?;

        db.execute_unprepared("DROP TABLE modulation;").await?;

        db.execute_unprepared(
            "ALTER TABLE sigint_network
                    DROP CONSTRAINT fk_modulation,
                    DROP COLUMN modulation_id;
                    ",
        )
        .await?;

        Ok(())
    }
}

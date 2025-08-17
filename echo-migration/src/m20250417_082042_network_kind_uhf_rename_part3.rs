use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        println!("> update table sigint_network.kind set kind = 'UHF' where kind = 'УКХ';");
        let db = manager.get_connection(); // Add this line to get the connection
        db.execute_unprepared(
            r#"UPDATE sigint_network SET kind = 'VHF' WHERE kind = 'УКХ';"#,
        )
        .await?;

        println!("> drop old value УКХ from enum");
        println!("> Rename the old enum type");
        db.execute_unprepared(
            r#"ALTER TYPE sigint_network_kind RENAME TO sigint_network_kind_old;"#,
        )
        .await?;

        println!("> Create the new enum type without 'УКХ'");

        db.execute_unprepared(
            r#"
            CREATE TYPE sigint_network_kind AS ENUM ('DMR', 'DMRe', 'VHF');
"#,
        )
        .await?;

        println!("> Alter the column to use the new enum type");

        db.execute_unprepared(
            r#"
            ALTER TABLE sigint_network
                ALTER COLUMN kind TYPE sigint_network_kind
                USING kind::text::sigint_network_kind;
"#,
        )
        .await?;

        println!("Drop the old enum type");

        db.execute_unprepared(
            r#"
            DROP TYPE sigint_network_kind_old;
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        println!("> update table sigint_network.kind set kind = 'УКХ' where kind = 'VHF';");
        // Update data first, as 'VHF' won't exist in the old enum type
        db.execute_unprepared(
            r#"UPDATE sigint_network SET kind = 'УКХ' WHERE kind = 'VHF';"#,
        )
        .await?;

        println!("> Rename the current enum type");
        db.execute_unprepared(
            r#"ALTER TYPE sigint_network_kind RENAME TO sigint_network_kind_new;"#,
        )
        .await?;

        println!("> Create the original enum type with 'УКХ'");
        db.execute_unprepared(
            r#"
            CREATE TYPE sigint_network_kind AS ENUM ('DMR', 'DMRe', 'УКХ');
            "#,
        )
        .await?;

        println!("> Alter the column to use the original enum type");
        // The USING clause converts the text representation back to the enum type.
        // Since we updated 'VHF' to 'УКХ' already, this should work directly.
        db.execute_unprepared(
            r#"
            ALTER TABLE sigint_network
                ALTER COLUMN kind TYPE sigint_network_kind
                USING kind::text::sigint_network_kind;
            "#,
        )
        .await?;

        println!("Drop the temporary enum type");
        db.execute_unprepared(
            r#"
            DROP TYPE sigint_network_kind_new;
            "#,
        )
        .await?;

        Ok(())
    }
}

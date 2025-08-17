use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let _db = manager.get_connection();

        println!("DO NOTHING");

        //         println!("> update table sigint_network.kind set kind = 'UHF' where kind = 'УКХ';");
        //         db.execute_unprepared(
        //             r#"UPDATE sigint_network SET kind = 'VHF' WHERE kind = 'УКХ';"#,
        //         )
        //         .await?;

        //         println!("> drop old value УКХ from enum");
        //         println!("> Rename the old enum type");
        //         db.execute_unprepared(
        //             r#"ALTER TYPE sigint_network_kind RENAME TO sigint_network_kind_old;"#,
        //         )
        //         .await?;

        //         println!("> Create the new enum type without 'УКХ'");

        //         db.execute_unprepared(
        //             r#"
        //             CREATE TYPE sigint_network_kind AS ENUM ('DMR', 'DMRe', 'VHF');
        // "#,
        //         )
        //         .await?;

        //         println!("> Alter the column to use the new enum type");

        //         db.execute_unprepared(
        //             r#"
        //             ALTER TABLE sigint_network
        //                 ALTER COLUMN kind TYPE sigint_network_kind
        //                 USING kind::text::sigint_network_kind;
        // "#,
        //         )
        //         .await?;

        //         println!("Drop the old enum type");

        //         db.execute_unprepared(
        //             r#"
        //             DROP TYPE sigint_network_kind_old;
        //             "#,
        //         )
        //         .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let _db = manager.get_connection();

        // // 1) revert data
        // println!("> revert kind 'VHF' back to 'УКХ'");
        // db.execute_unprepared(
        //     r#"UPDATE sigint_network SET kind = 'УКХ' WHERE kind = 'VHF';"#,
        // )
        // .await?;

        // // 2) rename the current enum out of the way
        // println!("> rename current enum to tmp");
        // db.execute_unprepared(
        //     r#"ALTER TYPE sigint_network_kind RENAME TO sigint_network_kind_tmp;"#,
        // )
        // .await?;

        // // 3) recreate the original enum
        // println!("> create original enum with 'УКХ'");
        // db.execute_unprepared(
        //     r#"
        //     CREATE TYPE sigint_network_kind AS ENUM ('DMR', 'DMRe', 'УКХ');
        //     "#,
        // )
        // .await?;

        // // 4) switch the column back to it
        // println!("> alter column to use original enum");
        // db.execute_unprepared(
        //     r#"
        //     ALTER TABLE sigint_network
        //         ALTER COLUMN kind TYPE sigint_network_kind
        //         USING kind::text::sigint_network_kind;
        //     "#,
        // )
        // .await?;

        // // 5) drop the temporary enum
        // println!("> drop temporary enum");
        // db.execute_unprepared(r#"DROP TYPE sigint_network_kind_tmp;"#)
        //     .await?;

        Ok(())
    }
}

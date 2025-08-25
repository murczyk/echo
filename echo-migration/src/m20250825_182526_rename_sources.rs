use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        // Переіменувати джерела:
        //     Р\О на РЕР
        //     ОСІНТ на OSINT (відкриті джерела)
        // Додати джерела:
        //     Пролом
        //     Документ
        // Еталонка видалити, якщо є, замінити на "Взаємодія"

        db.execute_unprepared(
            r#"UPDATE source SET name = 'РЕР' WHERE name = 'Р/О';
               UPDATE source SET name = 'OSINT' WHERE name = 'ОСІНТ';

               INSERT INTO source (name)
                   SELECT 'ПРОЛОМ'
                   WHERE NOT EXISTS(SELECT 1 FROM source WHERE name = 'ПРОЛОМ');

               INSERT INTO source (name)
                   SELECT 'ДОКУМЕНТ'
                   WHERE NOT EXISTS(SELECT 1 FROM source WHERE name = 'ДОКУМЕНТ');   

               -- replace Еталонка with Взаємодія in sigint_callsign
               UPDATE sigint_callsign sc
                SET source_id = s_new.id
                FROM source s_new
                    JOIN source s_old ON s_old.name = 'ЕТАЛОНКА'
                WHERE sc.source_id = s_old.id
                    AND s_new.name = 'ВЗАЄМОДІЯ';

                -- replace Еталонка with Взаємодія in sigint_network_callsign
               UPDATE sigint_network_callsign nc
                SET source_id = s_new.id
                FROM source s_new
                    JOIN source s_old ON s_old.name = 'ЕТАЛОНКА'
                WHERE nc.source_id = s_old.id
                    AND s_new.name = 'ВЗАЄМОДІЯ';

               DELETE FROM source WHERE name = 'ЕТАЛОНКА';"#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"UPDATE source SET name = 'Р/О' WHERE name = 'РЕР';
            UPDATE source SET name = 'ОСІНТ' WHERE name = 'OSINT';

            INSERT INTO source (name)
                SELECT 'ЕТАЛОНКА'
                WHERE NOT EXISTS(SELECT 1 FROM source WHERE name = 'ЕТАЛОНКА');

            -- replace ПРОЛОМ with Взаємодія in sigint_callsign
            UPDATE sigint_callsign sc
            SET source_id = s_new.id
            FROM source s_new
                JOIN source s_old ON s_old.name = 'ПРОЛОМ'
            WHERE sc.source_id = s_old.id
                AND s_new.name = 'ВЗАЄМОДІЯ';

            -- replace ПРОЛОМ with Взаємодія in sigint_network_callsign
            UPDATE sigint_network_callsign nc
            SET source_id = s_new.id
            FROM source s_new
                JOIN source s_old ON s_old.name = 'ПРОЛОМ'
            WHERE nc.source_id = s_old.id
                AND s_new.name = 'ВЗАЄМОДІЯ';

            -- replace ДОКУМЕНТ with Взаємодія in sigint_callsign
            UPDATE sigint_callsign sc
            SET source_id = s_new.id
            FROM source s_new
                JOIN source s_old ON s_old.name = 'ДОКУМЕНТ'
            WHERE sc.source_id = s_old.id
                AND s_new.name = 'ВЗАЄМОДІЯ';

            -- replace ДОКУМЕНТ with Взаємодія in sigint_network_callsign
            UPDATE sigint_network_callsign nc
            SET source_id = s_new.id
            FROM source s_new
                JOIN source s_old ON s_old.name = 'ДОКУМЕНТ'
            WHERE nc.source_id = s_old.id
                AND s_new.name = 'ВЗАЄМОДІЯ';                    
            
            DELETE FROM source WHERE name = 'ПРОЛОМ';
            DELETE FROM source WHERE name = 'ДОКУМЕНТ';"#,
        )
        .await?;

        Ok(())
    }
}

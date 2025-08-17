use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            -- add system user for internal activity logging
            INSERT INTO login (login, roles, sigint_zone_id, deleted)
            VALUES ('system', '[\"Admin\", \"NoAutoLogout\"]', 1, false);
            
            -- move existing comments to network descriptions as Confirmations
            INSERT INTO sigint_network_description (network_id, description, type, deleted, login)
            SELECT id, comment, 'Confirmation', false, 'system'
              FROM sigint_network 
              WHERE comment <> '';            
            
            -- drop comment column from sigint_network
            ALTER TABLE sigint_network DROP COLUMN comment;
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            -- revert changes by adding comment column back to sigint_network
            ALTER TABLE sigint_network ADD COLUMN comment TEXT NOT NULL DEFAULT '';
            
            -- move existing descriptions back to comments
            UPDATE sigint_network
            SET comment = (
                SELECT description
                FROM sigint_network_description
                WHERE sigint_network.id = sigint_network_description.network_id
                  AND sigint_network_description.type = 'Confirmation'
                  AND sigint_network_description.deleted = false
                  AND sigint_network_description.login = 'system'
                ORDER BY sigint_network_description.id DESC
            	LIMIT 1)
			WHERE EXISTS (
			    SELECT 1
			    FROM sigint_network_description
			    WHERE sigint_network.id = sigint_network_description.network_id
			      AND sigint_network_description.type = 'Confirmation'
			      AND sigint_network_description.deleted = false
			      AND sigint_network_description.login = 'system'
				);  

            -- delete just moved comments from descriptions
            DELETE FROM sigint_network_description
              WHERE sigint_network_description.type = 'Confirmation'
			      AND sigint_network_description.deleted = false
			      AND sigint_network_description.login = 'system';

            -- remove system user
            DELETE FROM login WHERE login = 'system';            
            ",
        )
        .await?;
        Ok(())
    }
}

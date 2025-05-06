use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // Add sigint_post table
        // creare index for name field in sigint_post table
        db.execute_unprepared(
            "CREATE TABLE sigint_post (
                id bigserial PRIMARY KEY,
                name text UNIQUE NOT NULL,
                origin text,
                description text,
                deleted boolean NOT NULL DEFAULT false,
                created_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
                );
                
            CREATE INDEX sigint_post_name_idx ON sigint_post (name);") 
        .await?;

        // add post_id to sigint_inbox_item table and create foreign key for it
        db.execute_unprepared(
            "ALTER TABLE sigint_inbox_item
                ADD COLUMN post_id BIGINT,
                ADD CONSTRAINT sigint_inbox_item_post_id_fkey
                    FOREIGN KEY (post_id)
                    REFERENCES sigint_post(id)
                    ON DELETE SET NULL;

            CREATE INDEX sigint_inbox_item_post_id_idx ON sigint_inbox_item (post_id);
           ",
        )
        .await?;

        // in one transaction, populate sigint_posts table from sigint_inbox_item.post fiels
        // and set post_id in sigint_inbox_item table to the id of the corresponding sigint_post
        // drop the post field from sigint_inbox_item table
        db.execute_unprepared(
            "
            INSERT INTO sigint_post (name, origin)
                SELECT DISTINCT TRIM(UPPER(post)), TRIM(post)
                    FROM sigint_inbox_item
                    WHERE post IS NOT NULL
                ON CONFLICT (name) DO NOTHING;
            
            UPDATE sigint_inbox_item
                SET post_id = sigint_post.id
                FROM sigint_post
                WHERE TRIM(UPPER(sigint_inbox_item.post)) = sigint_post.name
                AND sigint_inbox_item.post IS NOT NULL;
            
            ALTER TABLE sigint_inbox_item DROP COLUMN post;",
        )
        .await?;

        // create sigint_network_post table
        db.execute_unprepared(
        "CREATE TABLE sigint_network_post (
            id bigserial PRIMARY KEY,
            network_id bigint NOT NULL,
            post_id bigint NOT NULL,
            deleted boolean NOT NULL DEFAULT false,
            created_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
            CONSTRAINT sigint_network_post_network_id_fkey FOREIGN KEY (network_id)
                REFERENCES sigint_network(id) ON DELETE CASCADE,
            CONSTRAINT sigint_network_post_post_id_fkey FOREIGN KEY (post_id)
                REFERENCES sigint_post(id) ON DELETE CASCADE
        );
        ").await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE sigint_network_post;")
            .await?;

        // Add back the dropped column
        // Restore post values from post_id
        // Drop the post_id column
        db.execute_unprepared(
            "
            ALTER TABLE sigint_inbox_item ADD COLUMN post TEXT;

            UPDATE sigint_inbox_item
            SET post = sigint_post.name
            FROM sigint_post
            WHERE sigint_inbox_item.post_id = sigint_post.id;
            
            ALTER TABLE sigint_inbox_item DROP COLUMN post_id;",
        )
        .await?;
        db.execute_unprepared("DROP TABLE sigint_post;").await?;

        Ok(())
    }
}

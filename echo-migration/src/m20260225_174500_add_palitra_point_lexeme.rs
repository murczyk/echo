use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table if not exists palitra_point_lexeme (
                id bigserial primary key,
                palitra_point_id int8 not null references palitra_point(id) on delete cascade,
                lexeme text not null,
                label_tsv tsvector
            );

            create unique index if not exists palitra_point_lexeme_point_lexeme_idx
                on palitra_point_lexeme (palitra_point_id, lexeme);

            create index if not exists palitra_point_lexeme_lexeme_idx
                on palitra_point_lexeme (lexeme);

            update palitra_point_lexeme
                set label_tsv = to_tsvector('russian', lexeme)
                where label_tsv is null;

            create index if not exists palitra_point_lexeme_tsv_idx
                on palitra_point_lexeme using gin(label_tsv);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists palitra_point_lexeme_tsv_idx;
            drop index if exists palitra_point_lexeme_lexeme_idx;
            drop index if exists palitra_point_lexeme_point_lexeme_idx;
            drop table if exists palitra_point_lexeme;
            "#,
        )
        .await?;
        Ok(())
    }
}

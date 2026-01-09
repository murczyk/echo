use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(r"
            update tag_keyword as k
            set keyword_negative_forms = keyword_negative_forms || array['200 метр', '200 лево', '200 право']
            from tag as t
            where k.tag_id = t.id
              and t.label = 'втрати'
              and k.keyword = '200';

            update tag_keyword as k
            set keyword_negative_forms = keyword_negative_forms || array['300 метр', '300 лево', '300 право']
            from tag as t
            where k.tag_id = t.id
              and t.label = 'втрати'
              and k.keyword = '300';

            insert into tag_keyword(tag_id, is_regex, keyword, keyword_forms, keyword_negative_forms)
            select t.id, true, 'цифры лево/право', array['[0-9]+ (лево|право)']::text[], array[]::text[]
            from tag as t
            where t.label = 'арта';
            ").await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r"
            update tag_keyword as k
            set keyword_negative_forms = array_remove(array_remove(
                array_remove(keyword_negative_forms, '200 метр'),
                '200 лево'
            ), '200 право')
            from tag as t
            where k.tag_id = t.id
              and t.label = 'втрати'
              and k.keyword = '200';

            update tag_keyword as k
            set keyword_negative_forms = array_remove(array_remove(
                array_remove(keyword_negative_forms, '300 метр'),
                '300 лево'
            ), '300 право')
            from tag as t
            where k.tag_id = t.id
              and t.label = 'втрати'
              and k.keyword = '300';

            delete from tag_keyword k
            using tag t
            where k.tag_id = t.id
              and k.keyword = 'цифры лево/право'
              and t.label = 'арта';
            ",
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table signal_message_queue
                    add column if not exists deleted boolean not null default false;

                with ranked as (
                    select
                        id,
                        row_number() over (
                            partition by datasource_id, internal_id
                            order by
                                created_at desc,
                                id desc,
                                case when group_id is not null then 0 else 1 end,
                                case when body <> '' then 0 else 1 end
                        ) as rn
                    from signal_message_queue
                )
                delete from signal_message_queue q
                using ranked r
                where q.id = r.id
                    and r.rn > 1;

                create unique index if not exists signal_message_queue_datasource_internal_id_uq
                    on signal_message_queue (datasource_id, internal_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists signal_message_queue_datasource_internal_id_uq;
                alter table signal_message_queue
                    drop column if exists deleted;
            "#,
        )
        .await?;
        Ok(())
    }
}

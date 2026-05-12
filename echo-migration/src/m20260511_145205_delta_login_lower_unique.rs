use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            with ranked_delta_login as (
                select
                    delta_login.id,
                    first_value(delta_login.id) over (
                        partition by lower(delta_login.login)
                        order by
                            exists (
                                select 1
                                from login
                                where login.delta_login_id = delta_login.id
                                    and login.deleted = false
                                    and login.deleted_permanently = false
                            ) desc,
                            delta_login.created_at,
                            delta_login.id
                    ) as keep_id
                from delta_login
            ),
            merge_delta_login as (
                select id, keep_id
                from ranked_delta_login
                where id != keep_id
            )
            update login
            set delta_login_id = merge_delta_login.keep_id
            from merge_delta_login
            where login.delta_login_id = merge_delta_login.id;

            with ranked_delta_login as (
                select
                    delta_login.id,
                    first_value(delta_login.id) over (
                        partition by lower(delta_login.login)
                        order by
                            exists (
                                select 1
                                from login
                                where login.delta_login_id = delta_login.id
                                    and login.deleted = false
                                    and login.deleted_permanently = false
                            ) desc,
                            delta_login.created_at,
                            delta_login.id
                    ) as keep_id
                from delta_login
            ),
            merge_delta_login as (
                select id
                from ranked_delta_login
                where id != keep_id
            )
            delete from delta_login
            using merge_delta_login
            where delta_login.id = merge_delta_login.id;

            create unique index idx_delta_login_login_lower_uniq
                on delta_login (lower(login));
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index idx_delta_login_login_lower_uniq;
            "#,
        )
        .await?;
        Ok(())
    }
}

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    create table api_integration (
                        id bigserial primary key,
                        description text,
                        api_user text not null references login(login),
                        has_iggy_connection boolean not null default false,
                        iggy_url text,
                        iggy_login text,
                        iggy_password text,
                        iggy_inbox_topic text,
                        iggy_analytics_topic text,
                        created_at timestamptz not null default now(),
                        constraint api_integration_iggy_fields_check check (
                            (
                                has_iggy_connection = false
                                and iggy_url is null
                                and iggy_login is null
                                and iggy_password is null
                                and iggy_inbox_topic is null
                                and iggy_analytics_topic is null
                            )
                            or (
                                has_iggy_connection = true
                                and nullif(trim(iggy_url), '') is not null
                                and nullif(trim(iggy_login), '') is not null
                                and nullif(trim(iggy_password), '') is not null
                                and nullif(trim(iggy_inbox_topic), '') is not null
                                and nullif(trim(iggy_analytics_topic), '') is not null
                            )
                        )
                    );

                    create index idx_api_integration_api_user
                        on api_integration (api_user);
                "#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop table api_integration;")
            .await?;

        Ok(())
    }
}

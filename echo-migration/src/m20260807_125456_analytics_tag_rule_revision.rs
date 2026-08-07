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
                create table analytics_tag_rule_set_state (
                    id boolean primary key default true,
                    revision bigint not null default 0,
                    constraint analytics_tag_rule_set_state_singleton_check
                        check (id),
                    constraint analytics_tag_rule_set_state_revision_check
                        check (revision >= 0)
                );

                insert into analytics_tag_rule_set_state (id, revision)
                    values (true, 0);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop table if exists analytics_tag_rule_set_state;",
            )
            .await?;
        Ok(())
    }
}

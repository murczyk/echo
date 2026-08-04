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
create function sigint_comment_blacklist_system_login_id()
returns uuid
language sql
stable
as $$
    select id from login where login = 'system'
$$;

create table sigint_comment_blacklist (
    text text primary key,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    created_by_login_id uuid not null default sigint_comment_blacklist_system_login_id() references login(id),
    is_persistent boolean not null default false
);

insert into sigint_comment_blacklist (text, is_persistent)
values
    ('Службовий радіообмін', true),
    ('++', true),
    ('+', true),
    ('доповідь по обстановці', true),
    ('доповідь обстановки', true),
    ('повсякденна діяльність', true),
    ('службовий р/о', true),
    ('перевірка зв''язку', true),
    ('доповідь про стан справ', true),
    ('обстановка', true),
    ('виклик', true),
    ('встановлення зв''язку', true),
    ('запит обстановки', true),
    ('доведення інформації', true),
    ('доповідь', true),
    ('доповідав обстановку по позиціям', true),
    ('запитував обстановку', true),
    ('намагався встановити зв''язок', true),
    ('перевірка обстановки', true),
    ('звіт про ситуацію', true),
    ('викликав на зв''язок', true),
    ('здійснював запит обстановки', true),
    ('здійснював перевірку зв''язку', true),
    ('запит та доповідь обстановки', true);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table sigint_comment_blacklist;
drop function sigint_comment_blacklist_system_login_id();
                "#,
            )
            .await?;
        Ok(())
    }
}

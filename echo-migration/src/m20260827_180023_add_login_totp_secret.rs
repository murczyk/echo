use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
-- PeerDB-excluded credential store: plaintext TOTP seeds must not enter analytics.
create table if not exists login_totp (
    login_id uuid primary key references login (id),
    totp_secret text not null
);

-- Branch DBs that applied the earlier login.totp_secret column: move + drop.
do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'login'
          and column_name = 'totp_secret'
    ) then
        insert into login_totp (login_id, totp_secret)
        select id, totp_secret
        from login
        where totp_secret is not null
          and btrim(totp_secret) <> ''
        on conflict (login_id) do nothing;

        alter table login drop column totp_secret;
    end if;
end $$;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table if exists login_totp;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}

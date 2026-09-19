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
        for sql in [
            r#"
create index concurrently if not exists sigint_callsign_active_match_key_idx
    on sigint_callsign ((
        btrim(regexp_replace(translate(lower(callsign), U&'\002D\0020\2010\2011\2012\2013\2014\2015\0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000', repeat('-', 32)), '-+', '-', 'g'), '-')
    ))
    where deleted = false;
            "#,
            r#"
create index concurrently if not exists sigint_network_callsign_active_match_key_network_idx
    on sigint_network_callsign (
        (btrim(regexp_replace(translate(lower(sigint_callsign), U&'\002D\0020\2010\2011\2012\2013\2014\2015\0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000', repeat('-', 32)), '-+', '-', 'g'), '-')),
        sigint_network_id,
        id
    )
    where deleted = false;
            "#,
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!("{}: {error}", h!()))
                })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            "drop index concurrently if exists sigint_network_callsign_active_match_key_network_idx;",
            "drop index concurrently if exists sigint_callsign_active_match_key_idx;",
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!("{}: {error}", h!()))
                })?;
        }
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}

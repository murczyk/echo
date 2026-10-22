use super::query::IdRow;
use crate::types::*;
use sea_orm::{
    DatabaseBackend, DatabaseTransaction, FromQueryResult, Statement,
};

async fn active_result(
    db: &DatabaseTransaction,
    fallback: i64,
    processed: &[i64],
) -> anyhow::Result<i64> {
    Ok(IdRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select id from signal_message where id = any($1) and not deleted order by id limit 1",
        vec![processed.to_vec().into()],
    )).one(db).await.c(h!())?.map_or(fallback, |row| row.id))
}

pub async fn record_processed_source(
    db: &DatabaseTransaction,
    datasource: i64,
    inbox: i64,
    fallback: i64,
    processed: &[i64],
) -> anyhow::Result<()> {
    let canonical = active_result(db, fallback, processed).await.c(h!())?;
    super::record_source(db, datasource, inbox, canonical)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn record_promoted_sources(
    db: &DatabaseTransaction,
    traces: &[i64],
    fallback: i64,
    processed: &[i64],
) -> anyhow::Result<()> {
    #[derive(FromQueryResult)]
    struct Source {
        datasource_id: i64,
        inbox_message_id: i64,
    }
    let canonical = active_result(db, fallback, processed).await.c(h!())?;
    let sources = Source::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"select distinct dg.datasource_id, sm.echo_inbox_message_id as inbox_message_id
            from signal_message sm join datasource_group dg on dg.id = sm.datasource_group_id
            where sm.id = any($1) and sm.echo_inbox_message_id is not null
            order by dg.datasource_id, sm.echo_inbox_message_id"#,
        vec![traces.to_vec().into()],
    )).all(db).await.c(h!())?;
    for source in sources {
        super::record_source(
            db,
            source.datasource_id,
            source.inbox_message_id,
            canonical,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

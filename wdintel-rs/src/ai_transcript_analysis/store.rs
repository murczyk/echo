use crate::{h, types::ShortContext};
use sea_orm::{ConnectionTrait, DbBackend, FromQueryResult, Statement, Value};

pub(crate) fn sql(query: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

pub(crate) async fn rows<T: FromQueryResult, C: ConnectionTrait>(
    db: &C,
    query: &str,
    values: Vec<Value>,
) -> anyhow::Result<Vec<T>> {
    T::find_by_statement(sql(query, values))
        .all(db)
        .await
        .c(h!())
}

pub(crate) async fn execute<C: ConnectionTrait>(
    db: &C,
    query: &str,
    values: Vec<Value>,
) -> anyhow::Result<u64> {
    Ok(db
        .execute_raw(sql(query, values))
        .await
        .c(h!())?
        .rows_affected())
}

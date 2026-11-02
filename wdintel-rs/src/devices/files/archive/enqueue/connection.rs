use sea_orm::{
    ConnectionTrait, DbBackend, DbErr, ExecResult, QueryResult, RuntimeErr,
    Statement,
};
use sea_query_sqlx::SqlxValues;
use sqlx::{PgConnection, Postgres};
use tokio::sync::Mutex;

// Reuse sea-orm writers (archive admission, device stats) on the publication
// transaction's physical connection.
pub(in crate::devices::files) struct SqlxConnection<'a>(
    pub Mutex<&'a mut PgConnection>,
);

fn query(
    statement: &Statement,
) -> sqlx::query::Query<'_, Postgres, SqlxValues> {
    let values = statement
        .values
        .clone()
        .unwrap_or_else(|| sea_orm::sea_query::Values(Vec::new()));
    sqlx::query_with(
        sqlx::AssertSqlSafe(statement.sql.as_str()),
        SqlxValues(values),
    )
}

#[async_trait::async_trait]
impl ConnectionTrait for SqlxConnection<'_> {
    fn get_database_backend(&self) -> DbBackend {
        DbBackend::Postgres
    }

    async fn execute_raw(
        &self,
        statement: Statement,
    ) -> Result<ExecResult, DbErr> {
        query(&statement)
            .execute(&mut **self.0.lock().await)
            .await
            .map(Into::into)
            .map_err(|error| DbErr::Exec(RuntimeErr::SqlxError(error.into())))
    }

    async fn execute_unprepared(&self, sql: &str) -> Result<ExecResult, DbErr> {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&mut **self.0.lock().await)
            .await
            .map(Into::into)
            .map_err(|error| DbErr::Exec(RuntimeErr::SqlxError(error.into())))
    }

    async fn query_one_raw(
        &self,
        statement: Statement,
    ) -> Result<Option<QueryResult>, DbErr> {
        query(&statement)
            .fetch_optional(&mut **self.0.lock().await)
            .await
            .map(|row| row.map(Into::into))
            .map_err(|error| DbErr::Query(RuntimeErr::SqlxError(error.into())))
    }

    async fn query_all_raw(
        &self,
        statement: Statement,
    ) -> Result<Vec<QueryResult>, DbErr> {
        query(&statement)
            .fetch_all(&mut **self.0.lock().await)
            .await
            .map(|rows| rows.into_iter().map(Into::into).collect())
            .map_err(|error| DbErr::Query(RuntimeErr::SqlxError(error.into())))
    }
}

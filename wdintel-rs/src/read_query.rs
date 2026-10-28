use crate::{config::*, h, types::ShortContext};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, DbErr, ExecResult,
    QueryResult, RuntimeErr, Statement,
};
use sqlx::{pool::PoolConnection, Connection, PgConnection, PgPool, Postgres};
use std::{
    cell::Cell,
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(crate) struct RequestId(pub(crate) String);

struct ReadContext {
    request_id: String,
    source_pools: Vec<usize>,
    login: OnceLock<uuid::Uuid>,
    search: OnceLock<()>,
    count_request: Cell<bool>,
    timeouts: Cell<SearchTimeouts>,
    deadline_changed: Arc<Notify>,
}

#[derive(Clone, Copy)]
pub(crate) struct SearchTimeouts {
    pub(crate) statement_ms: u64,
    pub(crate) http_ms: u64,
}

impl Default for SearchTimeouts {
    fn default() -> Self {
        Self {
            statement_ms: ANALYSIS_SEARCH_STATEMENT_TIMEOUT_MS_DEFAULT,
            http_ms: ANALYSIS_SEARCH_HTTP_TIMEOUT_MS_DEFAULT,
        }
    }
}

tokio::task_local! {
    static READ_CONTEXT: ReadContext;
    static STATEMENT_BUDGET_MS: u64;
}

static SOURCE_READS: once_cell::sync::Lazy<Arc<Semaphore>> =
    once_cell::sync::Lazy::new(|| {
        Arc::new(Semaphore::new(ANALYSIS_SOURCE_READ_MAX_CONCURRENT))
    });
static LOGIN_READS: once_cell::sync::Lazy<
    Mutex<HashMap<uuid::Uuid, Weak<Semaphore>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static COUNT_READS: once_cell::sync::Lazy<Arc<Semaphore>> =
    once_cell::sync::Lazy::new(|| {
        Arc::new(Semaphore::new(ANALYSIS_SOURCE_COUNT_MAX_CONCURRENT))
    });
static LOGIN_COUNT_READS: once_cell::sync::Lazy<
    Mutex<HashMap<uuid::Uuid, Weak<Semaphore>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static COUNT_OPERATIONS: once_cell::sync::Lazy<Arc<Semaphore>> =
    once_cell::sync::Lazy::new(|| {
        Arc::new(Semaphore::new(
            ANALYSIS_SOURCE_COUNT_OPERATION_MAX_CONCURRENT,
        ))
    });
static LOGIN_COUNT_OPERATIONS: once_cell::sync::Lazy<
    Mutex<HashMap<uuid::Uuid, Weak<Semaphore>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static LOGIN_OPERATIONS: once_cell::sync::Lazy<
    Mutex<HashMap<uuid::Uuid, Weak<Semaphore>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

pub(crate) fn pool_identity(db: &DatabaseConnection) -> usize {
    Arc::as_ptr(&db.get_postgres_connection_pool().connect_options()) as usize
}

pub(crate) fn request_id() -> String {
    READ_CONTEXT
        .try_with(|context| context.request_id.clone())
        .unwrap_or_else(|_| "-".into())
}

pub(crate) fn set_login(login: uuid::Uuid) {
    let _ = READ_CONTEXT.try_with(|context| context.login.set(login));
}

pub(crate) fn configure_search_timeouts(timeouts: SearchTimeouts) {
    let _ = READ_CONTEXT.try_with(|context| context.timeouts.set(timeouts));
}

pub(crate) fn set_count_request() {
    let _ = READ_CONTEXT.try_with(|context| context.count_request.set(true));
}

pub(crate) fn is_search_count() -> bool {
    READ_CONTEXT
        .try_with(|context| {
            context.count_request.get() && context.search.get().is_some()
        })
        .unwrap_or(false)
}

pub(crate) fn queue_timeout_ms() -> u64 {
    if is_search_count() {
        http_timeout_ms()
    } else {
        ANALYSIS_SOURCE_READ_QUEUE_TIMEOUT_MS
    }
}

pub(crate) async fn with_statement_budget<T>(
    timeout_ms: u64,
    future: impl Future<Output = T>,
) -> T {
    STATEMENT_BUDGET_MS.scope(timeout_ms, future).await
}

pub(crate) async fn probe(
    db: &DatabaseConnection,
    statement: Statement,
    timeout_ms: u64,
) -> anyhow::Result<Option<Vec<QueryResult>>> {
    let transaction = begin(db).await.c(h!())?;
    let rows = transaction.probe(statement, timeout_ms).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(rows)
}

pub(crate) fn set_search(search: &Option<String>) {
    if search
        .as_deref()
        .is_none_or(|search| search.trim().is_empty())
    {
        return;
    }
    let _ = READ_CONTEXT.try_with(|context| {
        if context.search.set(()).is_ok() {
            context.deadline_changed.notify_one();
        }
    });
}

pub(crate) fn http_timeout_ms() -> u64 {
    READ_CONTEXT
        .try_with(|context| {
            if context.search.get().is_some() {
                context.timeouts.get().http_ms
            } else {
                ANALYTICS_HTTP_READ_TIMEOUT_MS
            }
        })
        .unwrap_or(ANALYTICS_HTTP_READ_TIMEOUT_MS)
}

fn search_statement_timeout_ms() -> Option<u64> {
    READ_CONTEXT
        .try_with(|context| {
            context
                .search
                .get()
                .map(|_| context.timeouts.get().statement_ms)
        })
        .ok()
        .flatten()
}

pub(crate) async fn with_deadline<T>(
    future: impl Future<Output = T>,
) -> Result<T, ()> {
    let started = tokio::time::Instant::now();
    let changed = READ_CONTEXT.with(|context| context.deadline_changed.clone());
    tokio::pin!(future);
    loop {
        tokio::select! {
            biased;
            _ = changed.notified() => {},
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep_until(started + Duration::from_millis(http_timeout_ms())) => return Err(()),
        }
    }
}

pub(crate) async fn scope<T>(
    request_id: String,
    source_pools: Vec<usize>,
    future: impl Future<Output = T>,
) -> T {
    READ_CONTEXT
        .scope(
            ReadContext {
                request_id,
                source_pools,
                login: OnceLock::new(),
                search: OnceLock::new(),
                count_request: Cell::new(false),
                timeouts: Cell::new(SearchTimeouts::default()),
                deadline_changed: Arc::new(Notify::new()),
            },
            future,
        )
        .await
}

pub(crate) fn connection(db: &DatabaseConnection) -> ReadConnection<'_> {
    ReadConnection { db }
}

pub(crate) struct ReadConnection<'a> {
    db: &'a DatabaseConnection,
}

fn login_reads(
    queues: &Mutex<HashMap<uuid::Uuid, Weak<Semaphore>>>,
    login: uuid::Uuid,
    max_concurrent: usize,
) -> anyhow::Result<Arc<Semaphore>> {
    let mut queues = queues
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    queues.retain(|_, queue| queue.strong_count() > 0);
    if let Some(queue) = queues.get(&login).and_then(Weak::upgrade) {
        return Ok(queue);
    }
    if queues.len() >= ANALYSIS_SOURCE_READ_LOGIN_QUEUE_MAX_ENTRIES {
        return Err(DbErr::Custom(ANALYSIS_SOURCE_READ_QUEUE_ERROR.into()))
            .c(h!());
    }
    let queue = Arc::new(Semaphore::new(max_concurrent));
    queues.insert(login, Arc::downgrade(&queue));
    Ok(queue)
}

struct ReadPermits {
    _count: Option<OwnedSemaphorePermit>,
    _login: Option<OwnedSemaphorePermit>,
    _global: OwnedSemaphorePermit,
}

async fn acquire_reads() -> anyhow::Result<ReadPermits> {
    let started = Instant::now();
    let login = READ_CONTEXT
        .try_with(|context| context.login.get().copied())
        .ok()
        .flatten();
    let acquire = async {
        let (queues, max) = if is_search_count() {
            (&*LOGIN_COUNT_READS, ANALYSIS_SOURCE_COUNT_MAX_PER_LOGIN)
        } else {
            (&*LOGIN_READS, ANALYSIS_SOURCE_READ_MAX_PER_LOGIN)
        };
        let login = match login {
            Some(login) => Some(
                login_reads(queues, login, max)
                    .c(h!())?
                    .acquire_owned()
                    .await
                    .c(h!())?,
            ),
            None => None,
        };
        let count = if is_search_count() {
            Some(COUNT_READS.clone().acquire_owned().await.c(h!())?)
        } else {
            None
        };
        let global = SOURCE_READS.clone().acquire_owned().await.c(h!())?;
        anyhow::Ok(ReadPermits {
            _count: count,
            _login: login,
            _global: global,
        })
    };
    let result = tokio::time::timeout(
        Duration::from_millis(queue_timeout_ms()),
        acquire,
    )
    .await;
    log::info!(target: "analytics_route", "request_id={} stage=source_admission outcome={} elapsed_ms={}", request_id(), if matches!(result, Ok(Ok(_))) { "success" } else { "rejected" }, started.elapsed().as_millis());
    match result {
        Ok(result) => result,
        Err(_) => {
            Err(DbErr::Custom(ANALYSIS_SOURCE_READ_QUEUE_ERROR.into())).c(h!())
        }
    }
}

pub(crate) async fn acquire_operation(
) -> anyhow::Result<Option<OwnedSemaphorePermit>> {
    let login = READ_CONTEXT
        .try_with(|context| context.login.get().copied())
        .ok()
        .flatten();
    let Some(login) = login else { return Ok(None) };
    tokio::time::timeout(
        Duration::from_millis(ANALYSIS_SOURCE_READ_QUEUE_TIMEOUT_MS),
        login_reads(
            &LOGIN_OPERATIONS,
            login,
            ANALYSIS_SOURCE_READ_MAX_PER_LOGIN,
        )
        .c(h!())?
        .acquire_owned(),
    )
    .await
    .map_err(|_| DbErr::Custom(ANALYSIS_SOURCE_READ_QUEUE_ERROR.into()))
    .c(h!())?
    .map(Some)
    .c(h!())
}

pub(crate) struct CountOperationPermits {
    _login: Option<OwnedSemaphorePermit>,
    _global: OwnedSemaphorePermit,
}

pub(crate) async fn acquire_count_operation(
) -> anyhow::Result<CountOperationPermits> {
    let started = Instant::now();
    let login = READ_CONTEXT
        .try_with(|context| context.login.get().copied())
        .ok()
        .flatten();
    let result = tokio::time::timeout(
        Duration::from_millis(queue_timeout_ms()),
        async {
            let login = match login {
                Some(login) => Some(
                    login_reads(
                        &LOGIN_COUNT_OPERATIONS,
                        login,
                        ANALYSIS_SOURCE_COUNT_OPERATION_MAX_PER_LOGIN,
                    )
                    .c(h!())?
                    .acquire_owned()
                    .await
                    .c(h!())?,
                ),
                None => None,
            };
            let global =
                COUNT_OPERATIONS.clone().acquire_owned().await.c(h!())?;
            anyhow::Ok(CountOperationPermits {
                _login: login,
                _global: global,
            })
        },
    )
    .await;
    log::info!(target: "analytics_route", "request_id={} stage=count_operation_admission outcome={} elapsed_ms={}", request_id(), if matches!(result, Ok(Ok(_))) { "success" } else { "rejected" }, started.elapsed().as_millis());
    result
        .map_err(|_| DbErr::Custom(ANALYSIS_SOURCE_READ_QUEUE_ERROR.into()))
        .c(h!())?
        .c(h!())
}

#[derive(Clone, Copy)]
struct BackendIdentity {
    pid: i32,
    started: chrono::DateTime<chrono::Utc>,
}

struct ReadLease {
    connection: Option<PoolConnection<Postgres>>,
    pool: PgPool,
    backend: Option<BackendIdentity>,
    request_id: String,
    started: Instant,
    permits: Option<ReadPermits>,
}

impl Drop for ReadLease {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        let pool = self.pool.clone();
        let backend = self.backend;
        let request_id = self.request_id.clone();
        let elapsed_ms = self.started.elapsed().as_millis();
        let permits = self.permits.take();
        tokio::spawn(async move {
            let _permits = permits;
            if let Some(backend) = backend {
                cancel_backend(&pool, backend, &request_id, elapsed_ms).await;
            }
            // Keep the checked-out connection until cancellation finishes, then discard it.
            let _ = tokio::time::timeout(
                Duration::from_millis(POSTGRES_READ_CANCEL_TIMEOUT_MS),
                connection.close(),
            )
            .await;
        });
    }
}

async fn cancel_backend(
    pool: &PgPool,
    backend: BackendIdentity,
    request_id: &str,
    elapsed_ms: u128,
) {
    let cancel = async {
        let mut control = PgConnection::connect_with(&pool.connect_options())
            .await
            .c(h!())?;
        let cancelled = sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe("SELECT COALESCE((SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2 AND usename=current_user),false)")).bind(backend.pid).bind(backend.started).fetch_one(&mut control).await.c(h!())?;
        anyhow::Ok(cancelled)
    };
    let result = tokio::time::timeout(
        Duration::from_millis(POSTGRES_READ_CANCEL_TIMEOUT_MS),
        cancel,
    )
    .await;
    log::warn!(target: "analytics_route", "request_id={request_id} stage=source_sql outcome=cancelled cancel_sent={} elapsed_ms={elapsed_ms}", matches!(result, Ok(Ok(true))));
}

pub(crate) struct ReadTransaction {
    lease: tokio::sync::Mutex<ReadLease>,
}

pub(crate) async fn begin(
    db: &DatabaseConnection,
) -> anyhow::Result<ReadTransaction> {
    let mut lease = read_lease(db, connection(db).is_source_read())
        .await
        .c(h!())?;
    sqlx::query(sqlx::AssertSqlSafe(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ))
    .execute(&mut **lease.connection.as_mut().c(h!())?)
    .await
    .map_err(query_error)
    .c(h!())?;
    Ok(ReadTransaction {
        lease: tokio::sync::Mutex::new(lease),
    })
}

async fn read_lease(
    db: &DatabaseConnection,
    active: bool,
) -> anyhow::Result<ReadLease> {
    let permits = if active {
        Some(acquire_reads().await.c(h!())?)
    } else {
        None
    };
    let pool = db.get_postgres_connection_pool();
    let started = Instant::now();
    let acquired = if active {
        tokio::time::timeout(
            Duration::from_millis(ANALYSIS_SOURCE_READ_QUEUE_TIMEOUT_MS),
            pool.acquire(),
        )
        .await
        .map_err(|_| {
            log::warn!(target: "analytics_route", "request_id={} stage=source_pool outcome=rejected elapsed_ms={}", request_id(), started.elapsed().as_millis());
            DbErr::Custom(ANALYSIS_SOURCE_READ_QUEUE_ERROR.into())
        })
        .c(h!())?
    } else {
        pool.acquire().await
    };
    log::info!(target: "analytics_route", "request_id={} stage=source_pool outcome={} elapsed_ms={}", request_id(), if acquired.is_ok() { "success" } else { "error" }, started.elapsed().as_millis());
    let connection = acquired.map_err(query_error).c(h!())?;
    let mut lease = ReadLease {
        connection: Some(connection),
        pool: pool.clone(),
        backend: None,
        request_id: request_id(),
        started: Instant::now(),
        permits,
    };
    if active {
        lease.backend = Some(
            backend_identity(&mut **lease.connection.as_mut().c(h!())?)
                .await
                .c(h!())?,
        );
    }
    Ok(lease)
}

impl ReadTransaction {
    pub(crate) async fn probe(
        &self,
        statement: Statement,
        timeout_ms: u64,
    ) -> anyhow::Result<Option<Vec<QueryResult>>> {
        let mut lease = self.lease.lock().await;
        let connection = &mut **lease.connection.as_mut().c(h!())?;
        sqlx::query(sqlx::AssertSqlSafe("SAVEPOINT echo_search_probe"))
            .execute(&mut *connection)
            .await
            .map_err(query_error)
            .c(h!())?;
        let started = Instant::now();
        let result = read_rows_inner(
            connection,
            statement,
            false,
            true,
            Some(timeout_ms),
        )
        .await;
        sqlx::query(sqlx::AssertSqlSafe(
            "ROLLBACK TO SAVEPOINT echo_search_probe",
        ))
        .execute(&mut *connection)
        .await
        .map_err(query_error)
        .c(h!())?;
        sqlx::query(sqlx::AssertSqlSafe("RELEASE SAVEPOINT echo_search_probe"))
            .execute(connection)
            .await
            .map_err(query_error)
            .c(h!())?;
        log::info!(target: "analytics_route", "request_id={} stage=source_probe outcome={} elapsed_ms={} budget_ms={timeout_ms}", request_id(), if result.is_ok() { "success" } else { "error" }, started.elapsed().as_millis());
        match result {
            Ok(rows) => Ok(Some(rows)),
            Err(error) if is_statement_timeout(&error) => Ok(None),
            Err(error) => Err(error).c(h!()),
        }
    }

    pub(crate) async fn commit(self) -> anyhow::Result<()> {
        let mut lease = self.lease.into_inner();
        sqlx::query(sqlx::AssertSqlSafe("COMMIT"))
            .execute(&mut **lease.connection.as_mut().c(h!())?)
            .await
            .map_err(query_error)
            .c(h!())?;
        drop(lease.connection.take());
        Ok(())
    }
}

#[async_trait::async_trait]
impl ConnectionTrait for ReadTransaction {
    fn get_database_backend(&self) -> DbBackend {
        DbBackend::Postgres
    }
    async fn execute_raw(
        &self,
        statement: Statement,
    ) -> Result<ExecResult, DbErr> {
        let mut lease = self.lease.lock().await;
        let connection =
            &mut **lease.connection.as_mut().expect("active read transaction");
        let values = sea_query_sqlx::SqlxValues(
            statement
                .values
                .unwrap_or_else(|| sea_orm::sea_query::Values(Vec::new())),
        );
        sqlx::query_with(sqlx::AssertSqlSafe(statement.sql.as_str()), values)
            .execute(connection)
            .await
            .map(Into::into)
            .map_err(query_error)
    }
    async fn execute_unprepared(&self, sql: &str) -> Result<ExecResult, DbErr> {
        let mut lease = self.lease.lock().await;
        let connection =
            &mut **lease.connection.as_mut().expect("active read transaction");
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(connection)
            .await
            .map(Into::into)
            .map_err(query_error)
    }
    async fn query_one_raw(
        &self,
        statement: Statement,
    ) -> Result<Option<QueryResult>, DbErr> {
        let mut lease = self.lease.lock().await;
        read_rows(
            lease.connection.as_mut().expect("active read transaction"),
            statement,
            true,
            true,
        )
        .await
        .map(|rows| rows.into_iter().next())
        .map_err(boundary_error)
    }
    async fn query_all_raw(
        &self,
        statement: Statement,
    ) -> Result<Vec<QueryResult>, DbErr> {
        let mut lease = self.lease.lock().await;
        read_rows(
            lease.connection.as_mut().expect("active read transaction"),
            statement,
            false,
            true,
        )
        .await
        .map_err(boundary_error)
    }
}

async fn backend_identity(
    connection: &mut PgConnection,
) -> anyhow::Result<BackendIdentity> {
    let (pid, started) = sqlx::query_as::<_, (i32, chrono::DateTime<chrono::Utc>)>(sqlx::AssertSqlSafe("SELECT pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()")).fetch_one(connection).await.map_err(query_error).c(h!())?;
    Ok(BackendIdentity { pid, started })
}

async fn read_rows(
    connection: &mut PgConnection,
    statement: Statement,
    one: bool,
    in_transaction: bool,
) -> anyhow::Result<Vec<QueryResult>> {
    let started = Instant::now();
    let result =
        read_rows_inner(connection, statement, one, in_transaction, None).await;
    log::info!(target: "analytics_route", "request_id={} stage=source_sql outcome={} elapsed_ms={}", request_id(), if result.is_ok() { "success" } else { "error" }, started.elapsed().as_millis());
    result
}

async fn read_rows_inner(
    connection: &mut PgConnection,
    statement: Statement,
    one: bool,
    in_transaction: bool,
    timeout_ms: Option<u64>,
) -> anyhow::Result<Vec<QueryResult>> {
    let scoped = statement.sql.contains(ANALYSIS_SOURCE_SEARCH_SQL_HINT);
    let requested_timeout = timeout_ms
        .or_else(|| STATEMENT_BUDGET_MS.try_with(|timeout| *timeout).ok());
    let search_timeout =
        match (requested_timeout, search_statement_timeout_ms()) {
            (Some(requested), Some(configured)) => {
                Some(std::cmp::min(requested, configured))
            }
            (requested, configured) => requested.or(configured),
        };
    let local_settings = scoped || search_timeout.is_some();
    if local_settings && !in_transaction {
        sqlx::query(sqlx::AssertSqlSafe("BEGIN READ ONLY"))
            .execute(&mut *connection)
            .await
            .map_err(query_error)
            .c(h!())?;
    }
    if let Some(timeout) = search_timeout {
        sqlx::query(sqlx::AssertSqlSafe(
            "SELECT set_config('statement_timeout',$1,true)",
        ))
        .bind(timeout.to_string())
        .execute(&mut *connection)
        .await
        .map_err(query_error)
        .c(h!())?;
    }
    if scoped {
        sqlx::query(sqlx::AssertSqlSafe("SET LOCAL jit=off"))
            .execute(&mut *connection)
            .await
            .map_err(query_error)
            .c(h!())?;
    }
    let values = sea_query_sqlx::SqlxValues(
        statement
            .values
            .unwrap_or_else(|| sea_orm::sea_query::Values(Vec::new())),
    );
    let query =
        sqlx::query_with(sqlx::AssertSqlSafe(statement.sql.as_str()), values);
    let rows = if one {
        query
            .fetch_optional(&mut *connection)
            .await
            .map(|row| row.into_iter().collect::<Vec<_>>())
    } else {
        query.fetch_all(&mut *connection).await
    };
    let rows = rows.map_err(query_error).c(h!())?;
    if local_settings && !in_transaction {
        sqlx::query(sqlx::AssertSqlSafe("COMMIT"))
            .execute(connection)
            .await
            .map_err(query_error)
            .c(h!())?;
    }
    Ok(rows.into_iter().map(Into::into).collect())
}

fn is_statement_timeout(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        let Some(DbErr::Query(RuntimeErr::SqlxError(error))) = error.downcast_ref::<DbErr>() else {
            return false;
        };
        matches!(error.as_ref(), sqlx::Error::Database(error)
            if error.code().as_deref() == Some("57014") && error.message().contains("statement timeout"))
    })
}

impl ReadConnection<'_> {
    pub(crate) fn is_source_read(&self) -> bool {
        READ_CONTEXT
            .try_with(|context| {
                context.source_pools.contains(&pool_identity(self.db))
            })
            .unwrap_or(false)
    }

    async fn read(
        &self,
        statement: Statement,
        one: bool,
    ) -> anyhow::Result<Vec<QueryResult>> {
        let mut lease = read_lease(self.db, true).await.c(h!())?;
        let result = read_rows(
            &mut **lease.connection.as_mut().c(h!())?,
            statement,
            one,
            false,
        )
        .await;
        if result.is_ok() {
            drop(lease.connection.take());
        } else {
            lease.backend = None;
        }
        result
    }
}

fn query_error(error: sqlx::Error) -> DbErr {
    DbErr::Query(RuntimeErr::SqlxError(error.into()))
}

fn boundary_error(error: anyhow::Error) -> DbErr {
    match error.downcast::<DbErr>() {
        Ok(error) => error,
        Err(error) => DbErr::Custom(format!("{error:#}")),
    }
}

#[async_trait::async_trait]
impl ConnectionTrait for ReadConnection<'_> {
    fn get_database_backend(&self) -> DbBackend {
        self.db.get_database_backend()
    }
    async fn execute_raw(
        &self,
        statement: Statement,
    ) -> Result<ExecResult, DbErr> {
        self.db.execute_raw(statement).await
    }
    async fn execute_unprepared(&self, sql: &str) -> Result<ExecResult, DbErr> {
        self.db.execute_unprepared(sql).await
    }
    async fn query_one_raw(
        &self,
        statement: Statement,
    ) -> Result<Option<QueryResult>, DbErr> {
        if !self.is_source_read() {
            return self.db.query_one_raw(statement).await;
        }
        self.read(statement, true)
            .await
            .map(|rows| rows.into_iter().next())
            .map_err(boundary_error)
    }
    async fn query_all_raw(
        &self,
        statement: Statement,
    ) -> Result<Vec<QueryResult>, DbErr> {
        if !self.is_source_read() {
            return self.db.query_all_raw(statement).await;
        }
        self.read(statement, false).await.map_err(boundary_error)
    }
}

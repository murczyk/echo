use super::{read_transaction, types::*};
use crate::config::KPI_HISTORY_MAX_GROUPS;
use crate::h;
use crate::types::{Env, ShortContext};
use sea_orm::{DatabaseBackend, FromQueryResult, Statement};

const REPORTS_SQL: &str = r#"
with reports as materialized (
    select report_kind, requested_by_login_id, created_at, status, started_at, completed_at,
        bgtask_id, legacy_log_id
    from report_history where created_at >= $1 and created_at < $2
), successful as (
    select * from reports where status = 'done'
), durations as (
    select extract(epoch from completed_at - started_at)::double precision seconds
    from successful
    where bgtask_id is not null and legacy_log_id is null
        and started_at is not null and completed_at >= started_at
), kinds as (
    select report_kind id, report_kind label, count(*)::bigint count
    from successful group by report_kind limit $3
), authors as (
    select r.requested_by_login_id::text id,
        coalesce(l.login, 'Видалений обліковий запис') label, count(*)::bigint count
    from successful r left join login l on l.id = r.requested_by_login_id
    group by r.requested_by_login_id, l.login limit $3
), days as (
    select to_char(created_at, 'YYYY-MM-DD') id,
        to_char(created_at, 'YYYY-MM-DD') label, count(*)::bigint count
    from successful group by 1, 2
)
select jsonb_build_object(
    'total', (select count(*) from reports),
    'done', (select count(*) from successful),
    'failed', (select count(*) from reports where status = 'failed'),
    'byKind', coalesce((select jsonb_agg(to_jsonb(kinds) order by count desc, id) from kinds), '[]'::jsonb),
    'byAuthor', coalesce((select jsonb_agg(to_jsonb(authors) order by count desc, id) from authors), '[]'::jsonb),
    'byDay', coalesce((select jsonb_agg(to_jsonb(days) order by id) from days), '[]'::jsonb),
    'generation', jsonb_build_object(
        'samples', (select count(*) from durations),
        'excluded', (select count(*) from successful) - (select count(*) from durations),
        'medianSeconds', (select percentile_cont(0.5) within group (order by seconds) from durations),
        'p90Seconds', (select percentile_cont(0.9) within group (order by seconds) from durations)
    )
) value
"#;

const NOTIFICATIONS_SQL: &str = r#"
with deliveries as materialized (
    select status, created_at, sent_at from messenger_alert_delivery
    where created_at >= $1 and created_at < $2
), statuses as (
    select status id, status label, count(*)::bigint count from deliveries group by status limit $3
), durations as (
    select extract(epoch from sent_at - created_at)::double precision seconds
    from deliveries where status = 'sent' and sent_at >= created_at
)
select jsonb_build_object(
    'total', (select count(*) from deliveries),
    'byStatus', coalesce((select jsonb_agg(to_jsonb(statuses) order by count desc, id) from statuses), '[]'::jsonb),
    'transport', jsonb_build_object(
        'samples', (select count(*) from durations),
        'excluded', (select count(*) from deliveries where status = 'sent') - (select count(*) from durations),
        'medianSeconds', (select percentile_cont(0.5) within group (order by seconds) from durations),
        'p90Seconds', (select percentile_cont(0.9) within group (order by seconds) from durations)
    )
) value
"#;

#[derive(FromQueryResult)]
struct Aggregate {
    value: serde_json::Value,
}

async fn aggregate(
    env: &Env,
    period: &KpiPeriod,
    sql: &str,
) -> anyhow::Result<serde_json::Value> {
    let (since, until) = period.bounds().c(h!())?;
    let transaction = read_transaction(env).await.c(h!())?;
    let result = Aggregate::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [
            since.into(),
            until.into(),
            ((KPI_HISTORY_MAX_GROUPS + 1) as i64).into(),
        ],
    ))
    .one(&transaction)
    .await
    .c(h!())?
    .ok_or_else(|| anyhow::anyhow!("Missing KPI aggregate"))
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    let mut value = result.value;
    value["period"] = serde_json::to_value(period).c(h!())?;
    Ok(value)
}

pub(super) async fn reports(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<KpiReportsRsp> {
    let value = aggregate(env, period, REPORTS_SQL).await.c(h!())?;
    let result: KpiReportsRsp = serde_json::from_value(value).c(h!())?;
    anyhow::ensure!(
        result.by_kind.len() <= KPI_HISTORY_MAX_GROUPS
            && result.by_author.len() <= KPI_HISTORY_MAX_GROUPS,
        "KPI report groups exceed result limit"
    );
    Ok(result)
}

pub(super) async fn notifications(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<KpiNotificationsRsp> {
    let value = aggregate(env, period, NOTIFICATIONS_SQL).await.c(h!())?;
    serde_json::from_value(value).c(h!())
}

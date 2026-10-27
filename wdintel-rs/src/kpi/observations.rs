use super::types::*;
use crate::config::{KPI_ACTIVITY_MAX_ROWS, KPI_QUERY_TIMEOUT_MS};
use crate::h;
use crate::types::{Env, ShortContext};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::Duration;

async fn query(
    env: &Env,
    sql: &str,
) -> anyhow::Result<Option<Vec<tokio_postgres::Row>>> {
    let Some(pool) = env.greptime() else {
        return Ok(None);
    };
    let rows = tokio::time::timeout(Duration::from_millis(KPI_QUERY_TIMEOUT_MS), async {
        let client = pool.get().await.c(h!())?;
        client.batch_execute(&format!("SET TIMEZONE TO 'UTC'; SET statement_timeout = {KPI_QUERY_TIMEOUT_MS}"))
            .await.c(h!())?;
        client.query(sql, &[]).await.c(h!())
    }).await.c(h!())?.c(h!())?;
    anyhow::ensure!(
        rows.len() <= KPI_ACTIVITY_MAX_ROWS,
        "KPI aggregate exceeds result limit"
    );
    Ok(Some(rows))
}

fn boundary(
    env: &Env,
    period: &KpiPeriod,
    host_column: &str,
) -> anyhow::Result<String> {
    let (since, until) = period.bounds().c(h!())?;
    let host = env.config.public_host.replace('\'', "''");
    Ok(format!(
        "{host_column} = '{host}' and ts >= '{since}' and ts < '{until}'"
    ))
}

fn counts(values: BTreeMap<String, HashSet<String>>) -> Vec<KpiCount> {
    values
        .into_iter()
        .map(|(id, users)| KpiCount {
            label: id.clone(),
            id,
            count: users.len() as i64,
        })
        .collect()
}

pub(super) async fn activity(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<KpiActivityRsp> {
    let boundary = boundary(env, period, "public_host").c(h!())?;
    let sql = format!(
        "select cast(username as string), cast(date_trunc('day', ts) as string),
         cast(page as string), cast(min(ts) as string), cast(max(ts) as string)
         from activity_page_visit where {boundary} and username is not null
         group by username, date_trunc('day', ts), page limit {}",
        KPI_ACTIVITY_MAX_ROWS + 1,
    );
    let mut result = KpiActivityRsp {
        period: period.clone(),
        available: false,
        reason: Some("Greptime не налаштовано.".into()),
        observed_from: None,
        observed_until: None,
        accounts: None,
        by_day: vec![],
        by_page: vec![],
        unmapped_account_groups: 0,
        queue_enqueued: env.session_activity_enqueued.load(Ordering::Relaxed)
            as i64,
        queue_dropped: env.session_activity_dropped.load(Ordering::Relaxed)
            as i64,
    };
    let Some(rows) = query(env, &sql).await.c(h!())? else {
        return Ok(result);
    };
    if rows.is_empty() {
        result.reason = Some(
            "У цьому періоді немає спостережень; покриття історії невідоме."
                .into(),
        );
        return Ok(result);
    }
    aggregate_activity(rows, result).c(h!())
}

fn aggregate_activity(
    rows: Vec<tokio_postgres::Row>,
    mut result: KpiActivityRsp,
) -> anyhow::Result<KpiActivityRsp> {
    let mut users = HashSet::new();
    let mut days: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut pages: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for row in rows {
        let user: String = row.try_get(0).c(h!())?;
        let Ok(user) = uuid::Uuid::parse_str(&user) else {
            result.unmapped_account_groups += 1;
            continue;
        };
        let user = user.to_string();
        let day: String = row.try_get(1).c(h!())?;
        let page: Option<String> = row.try_get(2).c(h!())?;
        let first: String = row.try_get(3).c(h!())?;
        let last: String = row.try_get(4).c(h!())?;
        if result
            .observed_from
            .as_ref()
            .is_none_or(|value| first < *value)
        {
            result.observed_from = Some(first);
        }
        if result
            .observed_until
            .as_ref()
            .is_none_or(|value| last > *value)
        {
            result.observed_until = Some(last);
        }
        users.insert(user.clone());
        days.entry(day.chars().take(10).collect())
            .or_default()
            .insert(user.clone());
        if let Some(page) = page {
            pages.entry(page).or_default().insert(user);
        }
    }
    if users.is_empty() {
        result.reason = Some(
            "Немає спостережень зі стабільними ID облікових записів.".into(),
        );
        return Ok(result);
    }
    result.available = true;
    result.reason = None;
    result.accounts = Some(users.len() as i64);
    result.by_day = counts(days);
    result.by_page = counts(pages);
    Ok(result)
}

pub(super) async fn requests(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<KpiRequestsRsp> {
    let boundary = boundary(env, period, "request_hostname").c(h!())?;
    let sql = format!(
        "select cast(response_status as string), cast(count(distinct request_id) as string)
         from activity_details where {boundary} and event_type in ('response', 'error')
         and request_path like '/api/%' and request_id is not null and response_status >= 100 and response_status < 600
         group by response_status limit 501"
    );
    let mut result = KpiRequestsRsp {
        period: period.clone(),
        available: false,
        reason: Some("Greptime не налаштовано.".into()),
        total: None,
        server_errors: None,
        client_errors: None,
        by_status: vec![],
    };
    let Some(rows) = query(env, &sql).await.c(h!())? else {
        return Ok(result);
    };
    if rows.is_empty() {
        result.reason = Some(
            "Немає записаних відповідей; покриття історії невідоме.".into(),
        );
        return Ok(result);
    }
    let mut total = 0;
    let mut server_errors = 0;
    let mut client_errors = 0;
    for row in rows {
        let status: String = row.try_get(0).c(h!())?;
        let count = row
            .try_get::<_, String>(1)
            .c(h!())?
            .parse::<i64>()
            .c(h!())?;
        let code = status.parse::<u16>().c(h!())?;
        total += count;
        if code >= 500 {
            server_errors += count;
        } else if code >= 400 {
            client_errors += count;
        }
        result.by_status.push(KpiCount {
            id: status.clone(),
            label: status,
            count,
        });
    }
    result.by_status.sort_by(|a, b| a.id.cmp(&b.id));
    result.available = true;
    result.reason = None;
    result.total = Some(total);
    result.server_errors = Some(server_errors);
    result.client_errors = Some(client_errors);
    Ok(result)
}

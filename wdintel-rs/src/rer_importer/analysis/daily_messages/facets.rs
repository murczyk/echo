use super::*;
use std::collections::HashMap;

pub(crate) async fn groups(
    db: &DatabaseConnection,
    filter: &DailyMessageStatsReq,
    allowed: impl Into<filters::Access>,
) -> anyhow::Result<Vec<DailyMessageStatsFacetCount>> {
    let allowed = allowed.into();
    let mut filter = filter.clone();
    filter.selected_groups = None;
    let counts = if filters::empty(&filter, &allowed.groups) {
        HashMap::new()
    } else {
        let scope = filters::Scope::new(&filter, allowed.clone()).c(h!())?;
        let eligible = scope.associations("g.group_master_key as value,m.id");
        DailyMessageStatsFacetCount::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("with eligible as ({eligible}) select value,count(*)::bigint as count from eligible group by value"),
            scope.values,
        )).all(&crate::read_query::connection(db)).await.c(h!())?
            .into_iter().map(|row| (row.value, row.count)).collect()
    };
    Ok(allowed
        .groups
        .into_iter()
        .map(|value| DailyMessageStatsFacetCount {
            count: counts.get(&value).copied().unwrap_or(0),
            value,
        })
        .collect())
}

#[derive(FromQueryResult)]
struct SenderRow {
    key: Option<String>,
    label: Option<String>,
    total: i64,
}

pub(crate) async fn senders(
    db: &DatabaseConnection,
    req: &DailyMessageStatsSendersReq,
    allowed: impl Into<filters::Access>,
    access_revision: String,
) -> anyhow::Result<DailyMessageStatsSendersRsp> {
    let allowed = allowed.into();
    let mut filter = req.filter.clone();
    filter.selected_senders = None;
    let groups = filters::groups(&filter, &allowed.groups);
    let cursor = decode_cursor(&req.cursor).c(h!())?;
    let mut rows = vec![];
    if !filters::empty(&filter, &groups) {
        let mut scope =
            filters::Scope::new(&filter, allowed.with_groups(groups))
                .c(h!())?;
        let eligible =
            scope.associations("coalesce(g.sender,g.login_id::text) as key");
        let labels = catalog::sender_labels("select key from eligible");
        let search = scope.bind(
            req.search
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .cloned(),
        );
        let label =
            scope.bind(cursor.as_ref().map(|cursor| cursor.label.clone()));
        let unknown = scope
            .bind(cursor.as_ref().is_some_and(|cursor| cursor.key.is_none()));
        let key = scope.bind(
            cursor
                .as_ref()
                .and_then(|cursor| cursor.key.clone())
                .unwrap_or_default(),
        );
        let limit = scope.bind(DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE + 1);
        let sql = format!(
            r#"with eligible as materialized ({eligible}), entities as materialized ({labels})
            select p.key,p.label,t.total from (select count(*)::bigint as total from entities) t
            left join lateral (
                select key,label from entities where
                  ({search}::text is null or strpos(lower(label),lower({search}::text))>0) and
                  ({label}::text is null or (label collate "C",key is null,coalesce(key,'') collate "C") > ({label}::text collate "C",{unknown}::boolean,{key}::text collate "C"))
                order by label collate "C",key is null,coalesce(key,'') collate "C" limit {limit}
            ) p on true order by p.label collate "C",p.key is null,coalesce(p.key,'') collate "C""#
        );
        rows = SenderRow::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            scope.values,
        ))
        .all(&crate::read_query::connection(db))
        .await
        .c(h!())?;
    }
    let total = rows.first().map_or(0, |row| row.total);
    let mut options: Vec<_> = rows
        .into_iter()
        .filter_map(|row| {
            row.label.map(|label| DailyMessageStatsSenderLabel {
                key: row.key,
                label,
            })
        })
        .collect();
    let has_more =
        options.len() > DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE as usize;
    options.truncate(DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE as usize);
    let next_cursor = if has_more {
        options
            .last()
            .map(|entry| {
                encode_cursor(&DailyMessageStatsOption {
                    key: entry.key.clone(),
                    label: entry.label.clone(),
                    count: 0,
                })
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    Ok(DailyMessageStatsSendersRsp {
        options,
        next_cursor,
        total,
        access_revision,
        generated_at_ms: Utc::now().timestamp_millis(),
    })
}

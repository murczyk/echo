use crate::{config::*, h, types::ShortContext};
use chrono::{Duration, Months, NaiveDateTime};
use sea_orm::{ConnectionTrait, DatabaseConnection, QueryResult, Statement};
use std::{collections::HashSet, future::Future};

#[derive(Clone, Copy)]
pub(crate) struct SearchWindow {
    pub(crate) since: NaiveDateTime,
    pub(crate) till: NaiveDateTime,
}

pub(crate) async fn keys(
    db: &DatabaseConnection,
    windows: SearchWindows,
    build: impl Fn(SearchWindow) -> anyhow::Result<Statement>,
) -> anyhow::Result<HashSet<String>> {
    let mut identities = HashSet::new();
    read(
        db,
        windows,
        |window| std::future::ready(build(window)),
        |rows| {
            for row in rows {
                if let Some(identity) =
                    row.try_get::<Option<String>>("", "identity").c(h!())?
                {
                    identities.insert(identity);
                }
            }
            Ok(false)
        },
    )
    .await
    .c(h!())?;
    Ok(identities)
}

pub(crate) async fn sum(
    db: &DatabaseConnection,
    windows: SearchWindows,
    build: impl Fn(SearchWindow) -> anyhow::Result<Statement>,
) -> anyhow::Result<i64> {
    let mut total = 0i64;
    read(
        db,
        windows,
        |window| std::future::ready(build(window)),
        |rows| {
            for row in rows {
                total = total
                    .checked_add(row.try_get::<i64>("", "count").c(h!())?)
                    .c(h!())?;
            }
            Ok(false)
        },
    )
    .await
    .c(h!())?;
    Ok(total)
}

pub(crate) async fn exists(
    db: &DatabaseConnection,
    windows: SearchWindows,
    build: impl Fn(SearchWindow) -> anyhow::Result<Statement>,
) -> anyhow::Result<bool> {
    let mut found = false;
    read(
        db,
        windows,
        |window| std::future::ready(build(window)),
        |rows| {
            found = !rows.is_empty();
            Ok(found)
        },
    )
    .await
    .c(h!())?;
    Ok(found)
}

pub(crate) async fn read<
    BuildFuture: Future<Output = anyhow::Result<Statement>>,
>(
    db: &DatabaseConnection,
    windows: SearchWindows,
    build: impl Fn(SearchWindow) -> BuildFuture,
    mut consume: impl FnMut(Vec<QueryResult>) -> anyhow::Result<bool>,
) -> anyhow::Result<()> {
    let period = windows.remaining;
    let descending = windows.descending;
    if let Some(rows) = crate::read_query::probe(
        db,
        build(period).await.c(h!())?,
        ANALYSIS_SOURCE_COUNT_PROBE_TIMEOUT_MS,
    )
    .await
    .c(h!())?
    {
        consume(rows).c(h!())?;
        return Ok(());
    }
    let mut daily = false;
    for window in windows {
        if !daily
            && (window.since != period.since || window.till != period.till)
        {
            if let Some(rows) = crate::read_query::probe(
                db,
                build(window).await.c(h!())?,
                ANALYSIS_SOURCE_COUNT_PROBE_TIMEOUT_MS,
            )
            .await
            .c(h!())?
            {
                if consume(rows).c(h!())? {
                    return Ok(());
                }
                continue;
            }
        }
        daily = true;
        if read_daily(db, window, descending, &build, &mut consume)
            .await
            .c(h!())?
        {
            return Ok(());
        }
    }
    Ok(())
}

async fn read_daily<BuildFuture: Future<Output = anyhow::Result<Statement>>>(
    db: &DatabaseConnection,
    mut window: SearchWindow,
    descending: bool,
    build: &impl Fn(SearchWindow) -> BuildFuture,
    consume: &mut impl FnMut(Vec<QueryResult>) -> anyhow::Result<bool>,
) -> anyhow::Result<bool> {
    let width = Duration::days(ANALYSIS_SOURCE_COUNT_WINDOW_DAYS);
    while window.since < window.till {
        let next = if descending {
            SearchWindow {
                since: window
                    .till
                    .checked_sub_signed(width)
                    .unwrap_or(window.since)
                    .max(window.since),
                till: window.till,
            }
        } else {
            SearchWindow {
                since: window.since,
                till: window
                    .since
                    .checked_add_signed(width)
                    .unwrap_or(window.till)
                    .min(window.till),
            }
        };
        let rows = crate::read_query::with_statement_budget(
            ANALYSIS_SOURCE_COUNT_WINDOW_TIMEOUT_MS,
            async {
                let transaction = crate::read_query::begin(db).await.c(h!())?;
                let statement =
                    crate::attachments::search::in_source_count_window_async(
                        async { build(next).await },
                    )
                    .await
                    .c(h!())?;
                let rows =
                    transaction.query_all_raw(statement).await.c(h!())?;
                transaction.commit().await.c(h!())?;
                anyhow::Ok(rows)
            },
        )
        .await
        .c(h!())?;
        log::info!(target: "analytics_route", "request_id={} stage=source_window since={} till={} outcome=success", crate::read_query::request_id(), next.since, next.till);
        if consume(rows).c(h!())? {
            return Ok(true);
        }
        if descending {
            window.till = next.since;
        } else {
            window.since = next.till;
        }
    }
    Ok(false)
}

pub(crate) struct SearchWindows {
    remaining: SearchWindow,
    descending: bool,
    split: bool,
}

impl SearchWindows {
    pub(crate) fn single(since: NaiveDateTime, till: NaiveDateTime) -> Self {
        Self {
            remaining: SearchWindow { since, till },
            descending: false,
            split: false,
        }
    }

    pub(crate) fn for_search(
        search: &Option<String>,
        since: NaiveDateTime,
        till: NaiveDateTime,
        descending: bool,
    ) -> Option<Self> {
        if search
            .as_deref()
            .is_none_or(|search| search.trim().is_empty())
            || since >= till
            || since
                .checked_add_months(Months::new(
                    ANALYSIS_SOURCE_SEARCH_WINDOW_MONTHS,
                ))
                .is_none_or(|end| end >= till)
        {
            return None;
        }
        Some(Self {
            remaining: SearchWindow { since, till },
            descending,
            split: true,
        })
    }
}

impl Iterator for SearchWindows {
    type Item = SearchWindow;

    fn next(&mut self) -> Option<Self::Item> {
        let SearchWindow { since, till } = self.remaining;
        if since >= till {
            return None;
        }
        if !self.split {
            self.remaining.since = till;
            return Some(SearchWindow { since, till });
        }
        let width = Months::new(ANALYSIS_SOURCE_SEARCH_WINDOW_MONTHS);
        if self.descending {
            let start =
                till.checked_sub_months(width).unwrap_or(since).max(since);
            self.remaining.till = start;
            Some(SearchWindow { since: start, till })
        } else {
            let end = since.checked_add_months(width).unwrap_or(till).min(till);
            self.remaining.since = end;
            Some(SearchWindow { since, till: end })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::analytics::{SearchCoverageScope, SearchTimeBasis};
    use crate::entities::{
        sigint_inbox_item, signal_message, signal_message_group,
    };
    use crate::functest::tests::*;
    use crate::rer_importer::analysis::{
        filter_search_with_source_scope, message_in_groups_exists,
    };
    use crate::rer_importer::types::{AnalysisSearchMode, InboxMessagesSortBy};
    use sea_orm::sea_query::{Expr, ExprTrait};
    use sea_orm::*;

    fn daily_count_query(
        window: SearchWindow,
        allowed: &str,
        sort: InboxMessagesSortBy,
        mode: AnalysisSearchMode,
        keys: bool,
    ) -> anyhow::Result<Statement> {
        let column = match sort {
            InboxMessagesSortBy::IMSDatetime => Expr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            )),
            InboxMessagesSortBy::IMSTimestamp => Expr::col((
                signal_message::Entity,
                signal_message::Column::Timestamp,
            )),
            InboxMessagesSortBy::IMSCreatedAt => Expr::col((
                signal_message::Entity,
                signal_message::Column::CreatedAt,
            )),
        }
        .into_simple_expr();
        let query = sigint_inbox_item::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(message_in_groups_exists(vec![allowed.to_string()]))
            .filter(column.clone().gte(window.since))
            .filter(column.lt(window.till));
        let query = filter_search_with_source_scope(
            query,
            &Some("Береза -obsolete".into()),
            Some(mode),
            false,
            None,
            true,
            Some(SearchCoverageScope {
                since: Some(window.since),
                till: Some(window.till),
                till_inclusive: false,
                groups: &[allowed.to_string()],
                time_basis: match sort {
                    InboxMessagesSortBy::IMSDatetime => {
                        SearchTimeBasis::Interception
                    }
                    InboxMessagesSortBy::IMSTimestamp => {
                        SearchTimeBasis::Timestamp
                    }
                    InboxMessagesSortBy::IMSCreatedAt => {
                        SearchTimeBasis::Creation
                    }
                },
            }),
        )
        .c(h!())?;
        let query = if keys {
            query
                .select_only()
                .column_as(
                    sigint_inbox_item::Column::Freq
                        .into_simple_expr()
                        .if_null(""),
                    "identity",
                )
                .distinct()
        } else {
            query.select_only().column_as(
                Expr::cust("COUNT(DISTINCT signal_message.id)"),
                "count",
            )
        };
        Ok(query.build(DbBackend::Postgres))
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn daily_source_counts_keep_boundaries_access_and_distinct_keys_3780()
    {
        let env = cleanup().await.unwrap();
        let allowed = find_test_signal_group(&env.dbx).await.unwrap();
        let hidden =
            mk_signal_group(&env.dbx, Default::default()).await.unwrap();
        let datasource = find_test_datasource_group(&env.dbx).await.unwrap();
        let date = |day| {
            chrono::NaiveDate::from_ymd_opt(2026, 1, day)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
        };
        for (datetime, freq, group, deleted, text) in [
            (
                date(2) - Duration::microseconds(1),
                None,
                &allowed,
                false,
                "Береза",
            ),
            (date(2), Some(""), &allowed, false, "БЕРЕЗА"),
            (date(3), Some("3780.1"), &allowed, false, "Береза"),
            (date(2), Some("hidden"), &hidden, false, "Береза"),
            (date(2), Some("deleted"), &allowed, true, "Береза"),
            (
                date(2),
                Some("excluded"),
                &allowed,
                false,
                "Береза obsolete",
            ),
            (date(4), Some("outside"), &allowed, false, "Береза"),
        ] {
            let message = mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    created_at: Set(datetime),
                    timestamp: Set(Some(datetime)),
                    datasource_group_id: Set(Some(datasource.id)),
                    deleted: Set(deleted),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    id: Set(message.id),
                    freq: Set(freq.map(str::to_string)),
                    datetime: Set(Some(datetime)),
                    date: Set(None),
                    time: Set(None),
                    body_noheader: Set(Some(serde_json::json!({"body": text}))),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_signal_message_group(
                &env.dbx,
                signal_message_group::ActiveModel {
                    signal_message_id: Set(message.id),
                    group_master_key: Set(Some(group.master_key.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let period = SearchWindow {
            since: date(1),
            till: date(4),
        };
        for descending in [false, true] {
            for sort in [
                InboxMessagesSortBy::IMSDatetime,
                InboxMessagesSortBy::IMSTimestamp,
                InboxMessagesSortBy::IMSCreatedAt,
            ] {
                for mode in
                    [AnalysisSearchMode::Exact, AnalysisSearchMode::Substring]
                {
                    let build = |window| {
                        std::future::ready(daily_count_query(
                            window,
                            &allowed.master_key,
                            sort,
                            mode,
                            false,
                        ))
                    };
                    let mut total = 0;
                    read_daily(
                        &env.dbx,
                        period,
                        descending,
                        &build,
                        &mut |rows| {
                            total +=
                                rows[0].try_get::<i64>("", "count").c(h!())?;
                            Ok(false)
                        },
                    )
                    .await
                    .unwrap();
                    assert_eq!(total, 3);
                    let build = |window| {
                        std::future::ready(daily_count_query(
                            window,
                            &allowed.master_key,
                            sort,
                            mode,
                            true,
                        ))
                    };
                    let mut keys = HashSet::new();
                    read_daily(
                        &env.dbx,
                        period,
                        descending,
                        &build,
                        &mut |rows| {
                            for row in rows {
                                keys.insert(
                                    row.try_get::<String>("", "identity")
                                        .c(h!())?,
                                );
                            }
                            Ok(false)
                        },
                    )
                    .await
                    .unwrap();
                    assert_eq!(
                        keys,
                        HashSet::from([String::new(), "3780.1".to_string()])
                    );
                }
            }
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn failed_daily_window_rejects_the_count_after_prior_progress_3780() {
        let env = cleanup().await.unwrap();
        let since = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let period = SearchWindow {
            since,
            till: since + Duration::days(2),
        };
        let mut completed = 0;
        let build = |window: SearchWindow| {
            std::future::ready(Ok(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT 42::bigint / $1::bigint AS count",
                [if window.since == since { 0i64 } else { 1 }.into()],
            )))
        };
        let result = read_daily(&env.dbx, period, true, &build, &mut |_| {
            completed += 1;
            Ok(false)
        })
        .await;
        assert!(result.is_err());
        assert_eq!(completed, 1);
    }
}

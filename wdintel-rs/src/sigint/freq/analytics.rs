use super::*;
use crate::rer_importer::analysis::{
    load_analytics_message_id_chunks, stats, with_analytics_read_fallback,
};

#[derive(FromQueryResult)]
pub(super) struct FrequencyCount {
    pub(super) freq: String,
    pub(super) message_count: i64,
}

pub(super) async fn load_counts(
    env: &Data<Env>,
    user: &actix_identity::Identity,
    req: &ListFreqsReq,
    postgres_sql: String,
    limit: usize,
) -> Result<Vec<(String, i64, Option<String>)>, AppError> {
    let supported =
        !needs_unit_join(&req.filter_unit, &req.filter_further_investigation)
            && req.filter_sender_profile_ids.is_none();
    let counts =
        with_analytics_read_fallback(
            env,
            "frequency list",
            supported,
            |db| async move {
                Ok(load_analytics_counts(env, user, req, &db).await.c(h!())?)
            },
            |_db| async move {
                Ok(query_counts(&env.dbx, postgres_sql).await.c(h!())?)
            },
        )
        .await
        .c(h!())?;
    let rows = order_counts(&env.dbx, req, counts, limit).await.c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| (row.freq, row.message_count, None))
        .collect())
}

pub(super) async fn order_counts(
    db: &DatabaseConnection,
    req: &ListFreqsReq,
    counts: Vec<FrequencyCount>,
    limit: usize,
) -> anyhow::Result<Vec<FrequencyCount>> {
    if counts.is_empty() {
        return Ok(counts);
    }
    let (frequencies, counts): (Vec<_>, Vec<_>) = counts
        .into_iter()
        .map(|row| (row.freq, row.message_count))
        .unzip();
    let values = Query::select()
        .expr_as(Expr::cust("unnest($1::text[])"), "freq")
        .expr_as(Expr::cust("unnest($2::bigint[])"), "message_count")
        .to_owned();
    let mut query = Query::select()
        .column(Alias::new("freq"))
        .column(Alias::new("message_count"))
        .from_subquery(values, Alias::new("frequency_counts"))
        .to_owned();
    if req.filter_unknown_network.unwrap_or(false) {
        query.and_where(unknown_network_freq_filter("frequency_counts.freq"));
    }
    FrequencyCount::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        ordered_frequency_query(query, req, Some(limit)),
        vec![frequencies.into(), counts.into()],
    ))
    .all(&crate::read_query::connection(db))
    .await
    .c(h!())
}

async fn query_counts(
    db: &DatabaseConnection,
    sql: String,
) -> anyhow::Result<Vec<FrequencyCount>> {
    FrequencyCount::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        sql,
    ))
    .all(&crate::read_query::connection(db))
    .await
    .c(h!())
}

async fn load_analytics_counts(
    env: &Data<Env>,
    user: &actix_identity::Identity,
    req: &ListFreqsReq,
    db: &DatabaseConnection,
) -> anyhow::Result<Vec<FrequencyCount>> {
    let since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        user,
        &env.config,
    )
    .await
    .c(h!())?;
    let max_age = env
        .config
        .analytics
        .as_ref()
        .map(|config| config.freshness_max_age_ms())
        .unwrap_or(crate::config::ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let scope = stats::resolve_analytics_message_id_scope_for_range(
        since, till, db, max_age,
    )
    .await
    .c(h!())?;
    let cutoff = crate::rer_importer::inbox::analytics_fresh_tail_lower_bound(
        Utc::now().naive_utc(),
        max_age,
        crate::config::SIGINT_FREQUENCY_ANALYTICS_FRESH_TAIL_MINUTES,
    );
    load_hybrid_counts(&env.dbx, db, req, &groups, scope, cutoff)
        .await
        .c(h!())
}

pub(super) async fn load_hybrid_counts(
    source: &DatabaseConnection,
    db: &DatabaseConnection,
    req: &ListFreqsReq,
    groups: &[String],
    scope: crate::rer_importer::analysis::AnalyticsMessageIdScope,
    cutoff: NaiveDateTime,
) -> anyhow::Result<Vec<FrequencyCount>> {
    let mut count_req = req.clone();
    count_req.filter_unknown_network = None;
    let tail = frequency_candidates(&count_req, groups, None)
        .c(h!())?
        .filter(signal_message::Column::CreatedAt.gte(cutoff));
    let tail = query_counts(
        source,
        build_frequency_counts_query(tail, &count_req, None),
    )
    .await
    .c(h!())?;
    let historical = load_counts_for_scope(
        source,
        db,
        &count_req,
        groups,
        scope,
        Some(cutoff),
    )
    .await
    .c(h!())?;
    Ok(merge_counts([historical, tail]))
}

fn frequency_candidates(
    req: &ListFreqsReq,
    groups: &[String],
    scope: Option<&crate::rer_importer::analysis::AnalyticsMessageIdScope>,
) -> anyhow::Result<Select<signal_message::Entity>> {
    let candidates = signal_message::Entity::find().join_as(
        JoinType::InnerJoin,
        signal_message::Relation::SigintInboxItem.def(),
        Alias::new("sigint_inbox_item"),
    );
    Ok(frequency_base_filters(
        candidates,
        dt_from_millis(req.since_date_inclusive_ms).c(h!())?,
        dt_from_millis(req.till_date_noninclusive_ms).c(h!())?,
        &req.filter_freq,
        groups.to_vec(),
        &req.filter_group_master_keys,
        scope,
    ))
}

pub(super) async fn load_counts_for_scope(
    source: &DatabaseConnection,
    db: &DatabaseConnection,
    req: &ListFreqsReq,
    groups: &[String],
    scope: crate::rer_importer::analysis::AnalyticsMessageIdScope,
    created_at_upper_bound: Option<NaiveDateTime>,
) -> anyhow::Result<Vec<FrequencyCount>> {
    let chunks =
        load_analytics_message_id_chunks(source, scope, |scope| async move {
            let mut candidates =
                frequency_candidates(req, groups, Some(&scope)).c(h!())?;
            if let Some(cutoff) = created_at_upper_bound {
                candidates = candidates
                    .filter(signal_message::Column::CreatedAt.lt(cutoff));
            }
            query_counts(
                db,
                build_frequency_counts_query(candidates, req, None),
            )
            .await
            .c(h!())
        })
        .await
        .c(h!())?;
    Ok(merge_counts(chunks))
}

fn merge_counts(
    chunks: impl IntoIterator<Item = Vec<FrequencyCount>>,
) -> Vec<FrequencyCount> {
    let mut counts = HashMap::<String, i64>::new();
    for row in chunks.into_iter().flatten() {
        *counts.entry(row.freq).or_default() += row.message_count;
    }
    counts
        .into_iter()
        .map(|(freq, message_count)| FrequencyCount {
            freq,
            message_count,
        })
        .collect()
}

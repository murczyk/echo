//! Where each position is, consolidated from its coordinate facts.
//!
//! Knowledge is kept per scope so code names reused in other sectors and
//! private groups do not mix: an area of responsibility gathers facts from its
//! non-private groups, and every group (private ones included) has its own
//! scope. A new or removed fact queues a recompute of the affected scopes.

use crate::config::{
    AI_POSITION_KNOWLEDGE_CLUSTER_METERS, AI_POSITION_KNOWLEDGE_CONFLICT_RATIO,
    AI_POSITION_KNOWLEDGE_HALF_LIFE_DAYS,
    AI_POSITION_KNOWLEDGE_LINK_MAX_MESSAGES, AI_POSITION_KNOWLEDGE_WINDOW_DAYS,
    AI_POSITION_WORKER_MAX_ATTEMPTS, AI_POSITION_WORKER_MAX_ERROR_CHARS,
    AI_POSITION_WORKER_RETRY_BASE_SECS, AI_POSITION_WORKER_RETRY_MAX_SECS,
};
use crate::entities::{ai_position_knowledge, ai_position_knowledge_job};
use crate::h;
use crate::types::{error, ShortContext};
use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    Statement, TransactionTrait,
};
use std::collections::BTreeSet;

pub const SCOPE_AOR: &str = "aor";
pub const SCOPE_GROUP: &str = "group";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Scope {
    pub kind: &'static str,
    pub key: String,
}

/// Scopes a fact from this group contributes to. Private groups keep their
/// facts to themselves.
pub fn scopes_for(
    group_master_key: Option<&str>,
    group_is_secret: bool,
    aor_ids: &[i64],
) -> Vec<Scope> {
    let mut scopes = Vec::new();
    if let Some(group) = group_master_key {
        scopes.push(Scope {
            kind: SCOPE_GROUP,
            key: group.to_string(),
        });
    }
    if !group_is_secret {
        scopes.extend(aor_ids.iter().map(|aor_id| Scope {
            kind: SCOPE_AOR,
            key: aor_id.to_string(),
        }));
    }
    scopes
}

pub(crate) async fn enqueue<C>(
    dbx: &C,
    jobs: &BTreeSet<(Scope, String)>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    for (scope, name_key) in jobs {
        // A fresh created_at makes a running recompute keep the job.
        dbx.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
             values ($1, $2, $3)
             on conflict (scope_kind, scope_key, name_key)
             do update set attempts = 0, last_error = null,
                 next_attempt_at = now() at time zone 'utc',
                 created_at = now() at time zone 'utc'",
            [scope.kind.into(), scope.key.clone().into(), name_key.clone().into()],
        ))
        .await
        .c(h!())?;
    }
    Ok(())
}

#[derive(Debug, Clone, FromQueryResult)]
pub(crate) struct Fact {
    pub name: String,
    pub mgrs: String,
    pub lat: f64,
    pub lng: f64,
    pub certainty: String,
    pub message_at: NaiveDateTime,
    pub group_master_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Consolidated {
    pub name: String,
    pub mgrs: String,
    pub lat: f64,
    pub lng: f64,
    pub certainty: &'static str,
    pub fact_count: i32,
    pub conflicting: bool,
    pub first_fact_at: NaiveDateTime,
    pub last_fact_at: NaiveDateTime,
    pub source_group_keys: Vec<String>,
}

fn certainty_weight(certainty: &str) -> f64 {
    match certainty {
        "high" => 1.0,
        "medium" => 0.6,
        _ => 0.25,
    }
}

/// The best-supported place among facts within the window before the latest
/// fact. Every fact that was considered counts as a source group, so the
/// knowledge is only shown to users who can see all of them.
pub(crate) fn consolidate(facts: &[Fact]) -> Option<Consolidated> {
    let latest = facts.iter().map(|fact| fact.message_at).max()?;
    let since =
        latest - ChronoDuration::days(AI_POSITION_KNOWLEDGE_WINDOW_DAYS);
    let facts: Vec<&Fact> = facts
        .iter()
        .filter(|fact| fact.message_at >= since)
        .collect();
    let weight = |fact: &Fact| {
        let age_days =
            (latest - fact.message_at).num_seconds() as f64 / 86_400.0;
        certainty_weight(&fact.certainty)
            * 0.5_f64.powf(age_days / AI_POSITION_KNOWLEDGE_HALF_LIFE_DAYS)
    };
    // Each fact proposes a place; its score is the weight of facts near it.
    let scored: Vec<(f64, &Fact)> = facts
        .iter()
        .map(|center| {
            let score = facts
                .iter()
                .filter(|fact| {
                    distance_m(center, fact)
                        <= AI_POSITION_KNOWLEDGE_CLUSTER_METERS
                })
                .map(|fact| weight(fact))
                .sum::<f64>();
            (score, *center)
        })
        .collect();
    let (best_score, best) = scored.iter().copied().max_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then_with(|| weight(a.1).total_cmp(&weight(b.1)))
            .then_with(|| a.1.message_at.cmp(&b.1.message_at))
    })?;
    let supporting: Vec<&&Fact> = facts
        .iter()
        .filter(|fact| {
            distance_m(best, fact) <= AI_POSITION_KNOWLEDGE_CLUSTER_METERS
        })
        .collect();
    let conflicting = scored.iter().any(|(score, fact)| {
        distance_m(best, fact) > AI_POSITION_KNOWLEDGE_CLUSTER_METERS
            && *score >= best_score * AI_POSITION_KNOWLEDGE_CONFLICT_RATIO
    });
    let certainty = if conflicting {
        "low"
    } else if supporting.iter().any(|fact| fact.certainty == "high") {
        "high"
    } else if supporting.iter().any(|fact| fact.certainty == "medium") {
        "medium"
    } else {
        "low"
    };
    let source_group_keys = facts
        .iter()
        .filter_map(|fact| fact.group_master_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Some(Consolidated {
        name: best.name.clone(),
        mgrs: best.mgrs.clone(),
        lat: best.lat,
        lng: best.lng,
        certainty,
        fact_count: supporting.len() as i32,
        conflicting,
        first_fact_at: facts.iter().map(|fact| fact.message_at).min()?,
        last_fact_at: latest,
        source_group_keys,
    })
}

fn distance_m(a: &Fact, b: &Fact) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;
    let (lat1, lat2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlat = lat2 - lat1;
    let dlng = (b.lng - a.lng).to_radians();
    let h = (dlat / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * (dlng / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

async fn load_facts<C>(
    dbx: &C,
    scope: &Scope,
    name_key: &str,
) -> anyhow::Result<Vec<Fact>>
where
    C: ConnectionTrait,
{
    let scope_condition = if scope.kind == SCOPE_AOR {
        "$2::bigint = any(m.aor_ids) and not m.group_is_secret"
    } else {
        "m.group_master_key = $2"
    };
    let scope_value: sea_orm::Value = if scope.kind == SCOPE_AOR {
        scope.key.parse::<i64>().c(h!())?.into()
    } else {
        scope.key.clone().into()
    };
    Fact::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "select m.name, c.mgrs, c.lat, c.lng, c.certainty, c.message_at, m.group_master_key
             from ai_position_coordinate c
             join ai_position_mention m on m.id = c.mention_id
             where m.name_key = $1 and {scope_condition}"
        ),
        [name_key.into(), scope_value],
    ))
    .all(dbx)
    .await
    .c(h!())
}

/// Recomputes one scope's knowledge of one position.
pub(crate) async fn recompute<C>(
    dbx: &C,
    scope: &Scope,
    name_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let facts = load_facts(dbx, scope, name_key).await.c(h!())?;
    let existing = ai_position_knowledge::Entity::delete_many()
        .filter(ai_position_knowledge::Column::ScopeKind.eq(scope.kind))
        .filter(ai_position_knowledge::Column::ScopeKey.eq(scope.key.clone()))
        .filter(ai_position_knowledge::Column::NameKey.eq(name_key));
    let Some(known) = consolidate(&facts) else {
        existing.exec(dbx).await.c(h!())?;
        return Ok(());
    };
    ai_position_knowledge::Entity::insert(ai_position_knowledge::ActiveModel {
        id: sea_orm::ActiveValue::NotSet,
        scope_kind: Set(scope.kind.to_string()),
        scope_key: Set(scope.key.clone()),
        name_key: Set(name_key.to_string()),
        name: Set(known.name),
        mgrs: Set(known.mgrs),
        lat: Set(known.lat),
        lng: Set(known.lng),
        certainty: Set(known.certainty.to_string()),
        fact_count: Set(known.fact_count),
        conflicting: Set(known.conflicting),
        first_fact_at: Set(known.first_fact_at),
        last_fact_at: Set(known.last_fact_at),
        source_group_keys: Set(known.source_group_keys),
        updated_at: Set(Utc::now().naive_utc()),
    })
    .on_conflict(
        OnConflict::columns([
            ai_position_knowledge::Column::ScopeKind,
            ai_position_knowledge::Column::ScopeKey,
            ai_position_knowledge::Column::NameKey,
        ])
        .update_columns([
            ai_position_knowledge::Column::Name,
            ai_position_knowledge::Column::Mgrs,
            ai_position_knowledge::Column::Lat,
            ai_position_knowledge::Column::Lng,
            ai_position_knowledge::Column::Certainty,
            ai_position_knowledge::Column::FactCount,
            ai_position_knowledge::Column::Conflicting,
            ai_position_knowledge::Column::FirstFactAt,
            ai_position_knowledge::Column::LastFactAt,
            ai_position_knowledge::Column::SourceGroupKeys,
            ai_position_knowledge::Column::UpdatedAt,
        ])
        .to_owned(),
    )
    .exec(dbx)
    .await
    .c(h!())?;
    Ok(())
}

/// Names of the positions these scopes know: `(name, name_key)`.
pub(crate) async fn known_names<C>(
    dbx: &C,
    scopes: &[Scope],
) -> anyhow::Result<Vec<(String, String)>>
where
    C: ConnectionTrait,
{
    if scopes.is_empty() {
        return Ok(Vec::new());
    }
    let mut condition = sea_orm::Condition::any();
    for scope in scopes {
        condition = condition.add(
            sea_orm::Condition::all()
                .add(ai_position_knowledge::Column::ScopeKind.eq(scope.kind))
                .add(
                    ai_position_knowledge::Column::ScopeKey
                        .eq(scope.key.clone()),
                ),
        );
    }
    let rows = ai_position_knowledge::Entity::find()
        .filter(condition)
        .all(dbx)
        .await
        .c(h!())?;
    let mut seen = BTreeSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| seen.insert(row.name_key.clone()))
        .map(|row| (row.name, row.name_key))
        .collect())
}

/// Marks the now-known position in the scope's other messages within the
/// knowledge window that mention it but were not linked to it.
async fn link_window_mentions<C>(
    dbx: &C,
    scope: &Scope,
    name_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    use super::worker::{
        insert_linked_mentions, Source, SOURCE_GROUP_COLUMNS, SOURCE_GROUP_SQL,
    };
    let known = ai_position_knowledge::Entity::find()
        .filter(ai_position_knowledge::Column::ScopeKind.eq(scope.kind))
        .filter(ai_position_knowledge::Column::ScopeKey.eq(scope.key.clone()))
        .filter(ai_position_knowledge::Column::NameKey.eq(name_key))
        .one(dbx)
        .await
        .c(h!())?;
    let Some(known) = known else {
        return Ok(());
    };
    // The longest word is a cheap, selective prefilter for the body.
    let Some(stem) = name_key
        .split(' ')
        .filter(|word| !word.chars().all(|c| c.is_ascii_digit()))
        .max_by_key(|word| word.chars().count())
    else {
        return Ok(());
    };
    let window = ChronoDuration::days(AI_POSITION_KNOWLEDGE_WINDOW_DAYS);
    let scope_condition = if scope.kind == SCOPE_AOR {
        "$1::bigint = any(s.aor_ids) and not s.group_is_secret"
    } else {
        "s.group_master_key = $1"
    };
    let scope_value: sea_orm::Value = if scope.kind == SCOPE_AOR {
        scope.key.parse::<i64>().c(h!())?.into()
    } else {
        scope.key.clone().into()
    };
    let candidates = Source::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "select s.text, s.message_id, s.message_at, s.group_master_key,
                    s.group_is_secret, s.aor_ids
             from (
                 select coalesce(message.body, '') as text, message.id as message_id,
                        coalesce(item.datetime, message.timestamp, message.created_at) as message_at,
                        {SOURCE_GROUP_COLUMNS}
                 from signal_message message
                 join sigint_inbox_item item on item.id = message.id
                 {SOURCE_GROUP_SQL}
                 where not message.deleted
                   and message.created_at >= $2 - interval '1 day'
                   and lower(message.body) like $4
             ) s
             where {scope_condition}
               and s.message_at between $2 and $3
               and not exists (
                   select 1 from ai_position_mention m
                   where m.sigint_inbox_item_id = s.message_id and m.name_key = $5
               )
             order by s.message_at desc
             limit $6"
        ),
        [
            scope_value,
            (known.first_fact_at - window).into(),
            (known.last_fact_at + window).into(),
            format!("%{stem}%").into(),
            name_key.into(),
            AI_POSITION_KNOWLEDGE_LINK_MAX_MESSAGES.into(),
        ],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    for source in candidates {
        let spans = super::normalize::ground(&source.text, &known.name);
        if !spans.is_empty() {
            insert_linked_mentions(dbx, &source, name_key, &spans)
                .await
                .c(h!())?;
        }
    }
    Ok(())
}

/// Processes one due knowledge job; false when none is due.
pub(crate) async fn process_next(
    dbx: &DatabaseConnection,
) -> anyhow::Result<bool> {
    let job = ai_position_knowledge_job::Entity::find()
        .filter(
            ai_position_knowledge_job::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .order_by_asc(ai_position_knowledge_job::Column::NextAttemptAt)
        .order_by_asc(ai_position_knowledge_job::Column::CreatedAt)
        .one(dbx)
        .await
        .c(h!())?;
    let Some(job) = job else {
        return Ok(false);
    };
    let scope = Scope {
        kind: if job.scope_kind == SCOPE_AOR {
            SCOPE_AOR
        } else {
            SCOPE_GROUP
        },
        key: job.scope_key.clone(),
    };
    let result = async {
        let transaction = dbx.begin().await.c(h!())?;
        recompute(&transaction, &scope, &job.name_key)
            .await
            .c(h!())?;
        link_window_mentions(&transaction, &scope, &job.name_key)
            .await
            .c(h!())?;
        finish_job(&transaction, &job).await.c(h!())?;
        transaction.commit().await.c(h!())
    }
    .await;
    if let Err(error) = result {
        fail_job(dbx, &job, format!("{error:#}")).await.c(h!())?;
    }
    Ok(true)
}

/// Deletes the job unless it was re-enqueued while recomputing.
async fn finish_job<C>(
    dbx: &C,
    job: &ai_position_knowledge_job::Model,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    ai_position_knowledge_job::Entity::delete_many()
        .filter(
            ai_position_knowledge_job::Column::ScopeKind
                .eq(job.scope_kind.clone()),
        )
        .filter(
            ai_position_knowledge_job::Column::ScopeKey
                .eq(job.scope_key.clone()),
        )
        .filter(
            ai_position_knowledge_job::Column::NameKey.eq(job.name_key.clone()),
        )
        .filter(ai_position_knowledge_job::Column::CreatedAt.eq(job.created_at))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn fail_job(
    dbx: &DatabaseConnection,
    job: &ai_position_knowledge_job::Model,
    error_text: String,
) -> anyhow::Result<()> {
    let attempts = job.attempts + 1;
    let error_text: String = error_text
        .chars()
        .take(AI_POSITION_WORKER_MAX_ERROR_CHARS)
        .collect();
    if attempts >= AI_POSITION_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_position knowledge dropped {}:{}:{} after {attempts} attempts: {error_text}",
            job.scope_kind, job.scope_key, job.name_key
        );
        return finish_job(dbx, job).await;
    }
    let exponent = u32::try_from(attempts - 1).unwrap_or(0);
    let delay = AI_POSITION_WORKER_RETRY_BASE_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(AI_POSITION_WORKER_RETRY_MAX_SECS);
    ai_position_knowledge_job::Entity::update_many()
        .col_expr(ai_position_knowledge_job::Column::Attempts, attempts.into())
        .col_expr(
            ai_position_knowledge_job::Column::NextAttemptAt,
            (Utc::now().naive_utc() + ChronoDuration::seconds(delay)).into(),
        )
        .col_expr(
            ai_position_knowledge_job::Column::LastError,
            Some(error_text).into(),
        )
        .filter(
            ai_position_knowledge_job::Column::ScopeKind
                .eq(job.scope_kind.clone()),
        )
        .filter(
            ai_position_knowledge_job::Column::ScopeKey
                .eq(job.scope_key.clone()),
        )
        .filter(
            ai_position_knowledge_job::Column::NameKey.eq(job.name_key.clone()),
        )
        .filter(ai_position_knowledge_job::Column::CreatedAt.eq(job.created_at))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{consolidate, scopes_for, Fact, SCOPE_AOR, SCOPE_GROUP};
    use chrono::{Duration, NaiveDateTime};

    fn at(days: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp(1_790_000_000, 0)
            .unwrap()
            .naive_utc()
            + Duration::days(days)
    }

    fn fact(lat: f64, certainty: &str, day: i64, group: &str) -> Fact {
        Fact {
            name: "Циркон 9".to_string(),
            mgrs: format!("M{lat}"),
            lat,
            lng: 35.0,
            certainty: certainty.to_string(),
            message_at: at(day),
            group_master_key: Some(group.to_string()),
        }
    }

    #[test]
    fn private_groups_stay_in_their_own_scope() {
        let scopes = scopes_for(Some("g"), true, &[1, 2]);
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].kind, SCOPE_GROUP);
        let scopes = scopes_for(Some("g"), false, &[1]);
        assert_eq!(scopes[1].kind, SCOPE_AOR);
        assert_eq!(scopes[1].key, "1");
    }

    #[test]
    fn agreeing_recent_facts_win() {
        let known = consolidate(&[
            fact(47.0, "high", 0, "a"),
            fact(47.0005, "medium", 1, "b"),
            fact(48.0, "high", -3, "c"),
        ])
        .unwrap();
        assert_eq!(known.lat, 47.0);
        assert_eq!(known.fact_count, 2);
        assert!(!known.conflicting);
        assert_eq!(known.certainty, "high");
        assert_eq!(known.source_group_keys, vec!["a", "b", "c"]);
    }

    #[test]
    fn old_facts_fall_out_of_the_window() {
        let known = consolidate(&[
            fact(48.0, "high", -40, "old"),
            fact(47.0, "low", 0, "new"),
        ])
        .unwrap();
        assert_eq!(known.lat, 47.0);
        assert_eq!(known.source_group_keys, vec!["new"]);
    }

    #[test]
    fn competing_places_are_conflicting() {
        let known = consolidate(&[
            fact(47.0, "high", 0, "a"),
            fact(48.0, "high", 0, "b"),
        ])
        .unwrap();
        assert!(known.conflicting);
        assert_eq!(known.certainty, "low");
        assert!(consolidate(&[]).is_none());
    }
}

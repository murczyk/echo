//! Where each position is, consolidated from its coordinate facts.
//!
//! Knowledge is kept per scope so code names reused in other sectors and
//! private groups do not mix: an area of responsibility gathers facts from its
//! non-private groups, and every group (private ones included) has its own
//! scope. A new or removed fact queues a recompute of the affected scopes.

use crate::config::{
    AI_POSITION_KNOWLEDGE_CLUSTER_METERS, AI_POSITION_KNOWLEDGE_CONFLICT_RATIO,
    AI_POSITION_KNOWLEDGE_EVENT_MAX_MESSAGES,
    AI_POSITION_KNOWLEDGE_HALF_LIFE_DAYS, AI_POSITION_KNOWLEDGE_LINK_BATCH,
    AI_POSITION_KNOWLEDGE_WINDOW_DAYS, AI_POSITION_WORKER_MAX_ATTEMPTS,
    AI_POSITION_WORKER_MAX_ERROR_CHARS, AI_POSITION_WORKER_RETRY_BASE_SECS,
    AI_POSITION_WORKER_RETRY_MAX_SECS,
};
use crate::entities::{ai_position_knowledge, ai_position_knowledge_job};
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::types::{error, ShortContext};
use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
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

/// Every scope a fact from this group can feed, whatever its privacy is
/// now: recomputes check the group's current privacy and AORs.
pub fn fed_scopes(
    group_master_key: Option<&str>,
    aor_ids: &[i64],
) -> Vec<Scope> {
    scopes_for(group_master_key, false, aor_ids)
}

/// Queues recomputes for everything a group's facts feed, e.g. after its
/// privacy changed. One set-based statement: a long history stays in the
/// database.
pub async fn enqueue_for_group<C>(
    dbx: &C,
    master_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
         select distinct scope.kind, scope.key, fed.name_key
         from (
             select distinct name_key, aor_ids
             from ai_position_mention
             where group_master_key = $1
         ) fed
         cross join lateral (
             select 'group' as kind, $1 as key
             union all
             select 'aor', aor_id::text from unnest(fed.aor_ids) aor_id
             union all
             select 'aor', sga.aor_id::text
             from signal_group_aor sga
             where sga.master_key = $1
         ) scope
         on conflict (scope_kind, scope_key, name_key) do update
             set attempts = 0,
                 last_error = null,
                 next_attempt_at = now() at time zone 'utc',
                 created_at = now() at time zone 'utc'",
        [master_key.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

/// Each group's scopes with its privacy and AOR membership as they are now.
pub(crate) async fn current_scopes<C>(
    dbx: &C,
    group_keys: BTreeSet<String>,
) -> anyhow::Result<std::collections::HashMap<String, Vec<Scope>>>
where
    C: ConnectionTrait,
{
    #[derive(FromQueryResult)]
    struct Group {
        master_key: String,
        is_secret: bool,
        aor_ids: Vec<i64>,
    }
    if group_keys.is_empty() {
        return Ok(Default::default());
    }
    let groups = Group::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select sg.master_key, sg.is_secret,
                coalesce(array(
                    select sga.aor_id
                    from signal_group_aor sga
                    join area_of_responsibility aor on aor.id = sga.aor_id
                    where sga.master_key = sg.master_key and not aor.deleted
                    order by sga.aor_id
                ), '{}') as aor_ids
         from signal_group sg
         where sg.master_key = any($1)",
        [group_keys.into_iter().collect::<Vec<_>>().into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    Ok(groups
        .into_iter()
        .map(|group| {
            let scopes = scopes_for(
                Some(&group.master_key),
                group.is_secret,
                &group.aor_ids,
            );
            (group.master_key, scopes)
        })
        .collect())
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

/// Facts in the scope from the window before the latest one. Privacy and
/// AOR membership are the groups' current ones; deleted messages are out.
async fn load_facts<C>(
    dbx: &C,
    scope: &Scope,
    name_key: &str,
) -> anyhow::Result<Vec<Fact>>
where
    C: ConnectionTrait,
{
    let scope_condition = if scope.kind == SCOPE_AOR {
        "not coalesce(sg.is_secret, false)
         and exists (
             select 1 from signal_group_aor sga
             join area_of_responsibility aor on aor.id = sga.aor_id and not aor.deleted
             where sga.master_key = m.group_master_key and sga.aor_id = $2
         )"
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
            "with facts as (
                 select m.name, c.mgrs, c.lat, c.lng, c.certainty, c.message_at, m.group_master_key
                 from ai_position_coordinate c
                 join ai_position_mention m on m.id = c.mention_id
                 left join signal_group sg on sg.master_key = m.group_master_key
                 left join signal_message_media media on media.id = m.media_id
                 join signal_message message
                     on message.id = coalesce(m.sigint_inbox_item_id, media.signal_message_id)
                 where m.name_key = $1 and not message.deleted and {scope_condition}
             )
             select * from facts
             where message_at >= (select max(message_at) from facts) - make_interval(days => $3)"
        ),
        [
            name_key.into(),
            scope_value,
            (AI_POSITION_KNOWLEDGE_WINDOW_DAYS as i32).into(),
        ],
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

/// Latin look-alike letters folded to Cyrillic, as `position_key` does, so
/// the body prefilter does not reject «Циpкoн-9».
const FOLD_FROM: &str = "aceiopxykmthbё";
const FOLD_TO: &str = "асеіорхукмтнве";

/// Time ranges the knowledge window covers now but did not before; only
/// messages there still lack a link (messages extracted while the knowledge
/// existed got its name from the worker).
fn new_ranges(
    before: Option<&ai_position_knowledge::Model>,
    after: &ai_position_knowledge::Model,
) -> Vec<(NaiveDateTime, NaiveDateTime)> {
    let window = ChronoDuration::days(AI_POSITION_KNOWLEDGE_WINDOW_DAYS);
    let (from, to) =
        (after.first_fact_at - window, after.last_fact_at + window);
    let Some(before) = before else {
        return vec![(from, to)];
    };
    let (old_from, old_to) =
        (before.first_fact_at - window, before.last_fact_at + window);
    let mut ranges = Vec::new();
    if from < old_from {
        ranges.push((from, old_from.min(to)));
    }
    if to > old_to {
        ranges.push((old_to.max(from), to));
    }
    ranges
}

/// Groups whose messages make up the scope now.
async fn scope_groups<C>(dbx: &C, scope: &Scope) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait,
{
    if scope.kind != SCOPE_AOR {
        return Ok(vec![scope.key.clone()]);
    }
    #[derive(FromQueryResult)]
    struct Group {
        master_key: String,
    }
    let groups = Group::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select sga.master_key
         from signal_group_aor sga
         join area_of_responsibility aor on aor.id = sga.aor_id and not aor.deleted
         join signal_group sg on sg.master_key = sga.master_key
         where sga.aor_id = $1 and not sg.is_secret and not sg.deleted",
        [scope.key.parse::<i64>().c(h!())?.into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    Ok(groups.into_iter().map(|group| group.master_key).collect())
}

/// Links the known position to the scope's messages in the given ranges that
/// mention it but have no mention of it yet; returns the linked message ids.
/// Candidates are sought by group and message id
/// (`signal_message_group (group_master_key, signal_message_id)`), starting
/// at the first message created in the range.
async fn link_window_mentions<C>(
    dbx: &C,
    scope: &Scope,
    known: &ai_position_knowledge::Model,
    ranges: &[(NaiveDateTime, NaiveDateTime)],
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    use super::worker::insert_linked_mentions;
    let name_key = known.name_key.as_str();
    // The longest word is a cheap, selective prefilter for the body.
    let Some(stem) = name_key
        .split(' ')
        .filter(|word| !word.chars().all(|c| c.is_ascii_digit()))
        .max_by_key(|word| word.chars().count())
    else {
        return Ok(Vec::new());
    };
    let groups = scope_groups(dbx, scope).await.c(h!())?;
    let mut linked = Vec::new();
    if groups.is_empty() {
        return Ok(linked);
    }
    // Two seeks over event time: items with a parsed time by
    // `sigint_inbox_item.datetime`, the rest (whose time is the message's)
    // by `signal_message.created_at`, which is never before the send time.
    for &(from, to) in ranges {
        for pass in [LinkPass::ParsedTime, LinkPass::MessageTime] {
            let mut cursor: Option<(NaiveDateTime, i64)> = None;
            loop {
                let candidates = link_candidates(
                    dbx,
                    pass,
                    LinkQuery {
                        groups: &groups,
                        stem,
                        name_key,
                        from,
                        to,
                        cursor,
                    },
                )
                .await
                .c(h!())?;
                let Some(last) = candidates.last() else {
                    break;
                };
                cursor = Some((last.seek_at, last.message_id));
                for candidate in candidates {
                    let source = candidate.into_source();
                    // The canonical key also matches inflected or differently
                    // written occurrences.
                    let spans =
                        super::normalize::ground(&source.text, name_key);
                    if spans.is_empty()
                        || !body_unchanged(dbx, &source).await.c(h!())?
                    {
                        continue;
                    }
                    insert_linked_mentions(dbx, &source, name_key, &spans)
                        .await
                        .c(h!())?;
                    linked.push(source.message_id);
                }
            }
        }
    }
    Ok(linked)
}

#[derive(Clone, Copy)]
enum LinkPass {
    ParsedTime,
    MessageTime,
}

struct LinkQuery<'a> {
    groups: &'a [String],
    stem: &'a str,
    name_key: &'a str,
    from: NaiveDateTime,
    to: NaiveDateTime,
    cursor: Option<(NaiveDateTime, i64)>,
}

/// One keyset page of scope messages in the event-time range whose folded
/// body contains the stem and which have no mention of the position yet.
async fn link_candidates<C>(
    dbx: &C,
    pass: LinkPass,
    query: LinkQuery<'_>,
) -> anyhow::Result<Vec<LinkCandidate>>
where
    C: ConnectionTrait,
{
    use super::worker::{SOURCE_GROUP_COLUMNS, SOURCE_GROUP_SQL};
    let (seek, range) = match pass {
        LinkPass::ParsedTime => ("item.datetime", "item.datetime between $6 and $7"),
        LinkPass::MessageTime => (
            "message.created_at",
            "item.datetime is null
             and message.created_at >= $6
             and coalesce(message.timestamp, message.created_at) between $6 and $7",
        ),
    };
    let (cursor_at, cursor_id) = query
        .cursor
        .unwrap_or((query.from - ChronoDuration::days(1), 0));
    LinkCandidate::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "select coalesce(message.body, '') as text, message.id as message_id,
                    coalesce(item.datetime, message.timestamp, message.created_at) as message_at,
                    {seek} as seek_at,
                    {SOURCE_GROUP_COLUMNS}
             from sigint_inbox_item item
             join signal_message message on message.id = item.id
             {SOURCE_GROUP_SQL}
             where {range}
               and ({seek}, message.id) > ($1, $2)
               and grp.group_master_key = any($3)
               and not message.deleted
               and translate(lower(message.body), '{FOLD_FROM}', '{FOLD_TO}') like $4
               and not exists (
                   select 1 from ai_position_mention m
                   where m.sigint_inbox_item_id = message.id and m.name_key = $5
               )
             order by {seek}, message.id
             limit $8"
        ),
        [
            cursor_at.into(),
            cursor_id.into(),
            query.groups.to_vec().into(),
            format!("%{}%", query.stem).into(),
            query.name_key.into(),
            query.from.into(),
            query.to.into(),
            AI_POSITION_KNOWLEDGE_LINK_BATCH.into(),
        ],
    ))
    .all(dbx)
    .await
    .c(h!())
}

/// Locks the message and checks its body is the one grounded, so an edit
/// racing the link cannot leave offsets into the old text.
async fn body_unchanged<C>(
    dbx: &C,
    source: &super::worker::Source,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    #[derive(FromQueryResult)]
    struct Body {
        body: String,
    }
    let current = Body::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select coalesce(body, '') as body from signal_message
         where id = $1 and not deleted
         for share",
        [source.message_id.into()],
    ))
    .one(dbx)
    .await
    .c(h!())?;
    Ok(current.is_some_and(|current| current.body == source.text))
}

#[derive(FromQueryResult)]
struct LinkCandidate {
    text: String,
    message_id: i64,
    message_at: NaiveDateTime,
    seek_at: NaiveDateTime,
    group_master_key: Option<String>,
    group_is_secret: bool,
    aor_ids: Vec<i64>,
}

impl LinkCandidate {
    fn into_source(self) -> super::worker::Source {
        super::worker::Source {
            text: self.text,
            message_id: self.message_id,
            message_at: self.message_at,
            group_master_key: self.group_master_key,
            group_is_secret: self.group_is_secret,
            aor_ids: self.aor_ids,
        }
    }
}

async fn load_knowledge<C>(
    dbx: &C,
    scope: &Scope,
    name_key: &str,
) -> anyhow::Result<Option<ai_position_knowledge::Model>>
where
    C: ConnectionTrait,
{
    ai_position_knowledge::Entity::find()
        .filter(ai_position_knowledge::Column::ScopeKind.eq(scope.kind))
        .filter(ai_position_knowledge::Column::ScopeKey.eq(scope.key.clone()))
        .filter(ai_position_knowledge::Column::NameKey.eq(name_key))
        .one(dbx)
        .await
        .c(h!())
}

/// What a message card shows from this knowledge changed.
fn display_changed(
    before: Option<&ai_position_knowledge::Model>,
    after: Option<&ai_position_knowledge::Model>,
) -> bool {
    match (before, after) {
        (None, None) => false,
        (Some(before), Some(after)) => {
            before.mgrs != after.mgrs
                || before.conflicting != after.conflicting
                || before.first_fact_at != after.first_fact_at
                || before.last_fact_at != after.last_fact_at
                || before.source_group_keys != after.source_group_keys
        }
        _ => true,
    }
}

/// Messages of the scope that mention the position: their cards show the
/// knowledge.
async fn mentioning_messages<C>(
    dbx: &C,
    scope: &Scope,
    name_key: &str,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    let groups = scope_groups(dbx, scope).await.c(h!())?;
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Option<i64>> =
        crate::entities::ai_position_mention::Entity::find()
            .filter(
                crate::entities::ai_position_mention::Column::NameKey
                    .eq(name_key),
            )
            .filter(
                crate::entities::ai_position_mention::Column::GroupMasterKey
                    .is_in(groups),
            )
            .filter(
                crate::entities::ai_position_mention::Column::SigintInboxItemId
                    .is_not_null(),
            )
            .order_by_desc(
                crate::entities::ai_position_mention::Column::MessageAt,
            )
            .limit(AI_POSITION_KNOWLEDGE_EVENT_MAX_MESSAGES)
            .select_only()
            .column(
                crate::entities::ai_position_mention::Column::SigintInboxItemId,
            )
            .into_tuple()
            .all(dbx)
            .await
            .c(h!())?;
    Ok(ids.into_iter().flatten().collect())
}

/// Processes one due knowledge job; false when none is due. Afterwards it
/// announces the messages whose cards changed.
pub(crate) async fn process_next(
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
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
        let before = load_knowledge(&transaction, &scope, &job.name_key)
            .await
            .c(h!())?;
        recompute(&transaction, &scope, &job.name_key)
            .await
            .c(h!())?;
        let after = load_knowledge(&transaction, &scope, &job.name_key)
            .await
            .c(h!())?;
        let mut changed = match &after {
            Some(after) => {
                let ranges = new_ranges(before.as_ref(), after);
                link_window_mentions(&transaction, &scope, after, &ranges)
                    .await
                    .c(h!())?
            }
            None => Vec::new(),
        };
        if display_changed(before.as_ref(), after.as_ref()) {
            changed.extend(
                mentioning_messages(&transaction, &scope, &job.name_key)
                    .await
                    .c(h!())?,
            );
        }
        finish_job(&transaction, &job).await.c(h!())?;
        transaction.commit().await.c(h!())?;
        anyhow::Ok(changed)
    }
    .await;
    match result {
        Ok(changed) => publish_changes(redis, changed).await,
        Err(error) => {
            fail_job(dbx, &job, format!("{error:#}")).await.c(h!())?
        }
    }
    Ok(true)
}

async fn publish_changes(
    redis: &mut redis::aio::ConnectionManager,
    mut message_ids: Vec<i64>,
) {
    message_ids.sort_unstable();
    message_ids.dedup();
    if message_ids.is_empty() {
        return;
    }
    let events = message_ids
        .into_iter()
        .map(|id| EventMsg::new(EventType::ETInboxChanged(id)))
        .collect();
    if let Err(error) = fanout_mult(redis, events).await {
        error!("ai_position knowledge failed to publish message changes: {error:#?}");
    }
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
    fn links_only_newly_covered_ranges() {
        use super::new_ranges;
        let row = |first: i64, last: i64| {
            crate::entities::ai_position_knowledge::Model {
                id: 1,
                scope_kind: "group".to_string(),
                scope_key: "g".to_string(),
                name_key: "циркон 9".to_string(),
                name: "Циркон 9".to_string(),
                mgrs: String::new(),
                lat: 0.0,
                lng: 0.0,
                certainty: "high".to_string(),
                fact_count: 1,
                conflicting: false,
                first_fact_at: at(first),
                last_fact_at: at(last),
                source_group_keys: vec![],
                updated_at: at(0),
            }
        };
        assert_eq!(new_ranges(None, &row(0, 0)), vec![(at(-30), at(30))]);
        assert!(new_ranges(Some(&row(0, 5)), &row(0, 5)).is_empty());
        assert_eq!(
            new_ranges(Some(&row(0, 5)), &row(0, 7)),
            vec![(at(35), at(37))]
        );
        assert_eq!(
            new_ranges(Some(&row(0, 5)), &row(-2, 5)),
            vec![(at(-32), at(-30))]
        );
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

use super::{matching, persistence, tui};
use crate::config::{
    ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE,
    ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE, ORBIT_TEST_LINK_UNITS_MAX_RATING,
    ORBIT_TEST_LINK_UNITS_PERSIST_BATCH_SIZE,
};
use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QuerySelect, RelationTrait, Statement,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReviewMatch {
    pub unit_id: uuid::Uuid,
    pub rating: u8,
    pub distance: usize,
    pub orbit_name: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct PersistSummary {
    already_linked: usize,
    suppressed: usize,
    no_longer_matching: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReviewUnit {
    pub sigint_unit_id: i64,
    pub sigint_unit_name: String,
    pub echelons: Vec<String>,
    pub matches: Vec<ReviewMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReviewInput {
    Accept(usize),
    Deny,
    NextMatchPage,
    PreviousMatchPage,
    ScrollUp,
    ScrollDown,
    PageUp,
    PageDown,
    RequestExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReviewOutcome {
    Completed,
    EarlyExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ReviewSummary {
    pub accepted: usize,
    pub denied: usize,
    pub unreviewed: usize,
    pub outcome: ReviewOutcome,
}

pub(super) struct ReviewSession {
    units: Vec<ReviewUnit>,
    current: usize,
    match_page: usize,
    scroll: usize,
    accepted: usize,
    denied: usize,
    accepted_links: Vec<(i64, uuid::Uuid)>,
}

impl ReviewSession {
    fn new(units: Vec<ReviewUnit>) -> Self {
        Self {
            units,
            current: 0,
            match_page: 0,
            scroll: 0,
            accepted: 0,
            denied: 0,
            accepted_links: Vec::new(),
        }
    }

    pub fn current_unit(&self) -> Option<&ReviewUnit> {
        self.units.get(self.current)
    }

    pub fn progress(&self) -> (usize, usize) {
        ((self.current + 1).min(self.units.len()), self.units.len())
    }

    pub fn scroll(&self) -> usize {
        self.scroll
    }

    pub fn visible_matches(&self) -> &[ReviewMatch] {
        let Some(unit) = self.current_unit() else {
            return &[];
        };
        let start = self.match_page * ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE;
        let end = (start + ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE)
            .min(unit.matches.len());
        &unit.matches[start..end]
    }

    pub fn match_page_progress(&self) -> (usize, usize) {
        let match_count =
            self.current_unit().map_or(0, |unit| unit.matches.len());
        let page_count =
            match_count.div_ceil(ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE);
        ((self.match_page + 1).min(page_count), page_count)
    }

    pub fn first_visible_match_number(&self) -> usize {
        self.match_page * ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE + 1
    }

    pub fn clamp_scroll(&mut self, maximum: usize) {
        self.scroll = self.scroll.min(maximum);
    }

    pub fn accepted_links(&self) -> &[(i64, uuid::Uuid)] {
        &self.accepted_links
    }

    pub fn apply(
        &mut self,
        input: ReviewInput,
        maximum_scroll: usize,
        page_size: usize,
    ) -> Option<ReviewSummary> {
        match input {
            ReviewInput::Accept(option) => {
                let orbit_unit_id = self
                    .visible_matches()
                    .get(option)
                    .map(|candidate| candidate.unit_id)?;
                let sigint_unit_id = self
                    .current_unit()
                    .expect("review unit must exist")
                    .sigint_unit_id;
                self.accepted_links.push((sigint_unit_id, orbit_unit_id));
                self.accepted += 1;
                self.advance();
            }
            ReviewInput::Deny => {
                self.denied += 1;
                self.advance();
            }
            ReviewInput::NextMatchPage => {
                let (_, page_count) = self.match_page_progress();
                if self.match_page + 1 < page_count {
                    self.match_page += 1;
                    self.scroll = 0;
                }
            }
            ReviewInput::PreviousMatchPage => {
                self.match_page = self.match_page.saturating_sub(1);
                self.scroll = 0;
            }
            ReviewInput::ScrollUp => {
                self.scroll = self.scroll.saturating_sub(1)
            }
            ReviewInput::ScrollDown => {
                self.scroll = (self.scroll + 1).min(maximum_scroll)
            }
            ReviewInput::PageUp => {
                self.scroll = self.scroll.saturating_sub(page_size)
            }
            ReviewInput::PageDown => {
                self.scroll = (self.scroll + page_size).min(maximum_scroll)
            }
            ReviewInput::RequestExit => return None,
        }
        self.is_complete()
            .then(|| self.summary(ReviewOutcome::Completed))
    }

    pub fn is_complete(&self) -> bool {
        self.current >= self.units.len()
    }

    pub fn finish_early(&self) -> ReviewSummary {
        self.summary(ReviewOutcome::EarlyExit)
    }

    pub fn completed_summary(&self) -> ReviewSummary {
        self.summary(ReviewOutcome::Completed)
    }

    fn advance(&mut self) {
        self.current += 1;
        self.match_page = 0;
        self.scroll = 0;
    }

    fn summary(&self, outcome: ReviewOutcome) -> ReviewSummary {
        ReviewSummary {
            accepted: self.accepted,
            denied: self.denied,
            unreviewed: self.units.len().saturating_sub(self.current),
            outcome,
        }
    }
}

pub async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(link_mode) = tui::prompt_link_mode().c(h!())? else {
        return Ok(());
    };
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&dbx, link_mode).await.c(h!())?;
    Ok(())
}

pub(super) async fn run_with_database(
    dbx: &sea_orm::DatabaseConnection,
    link_mode: tui::LinkMode,
) -> anyhow::Result<()> {
    let units = load_linkable_sigint_units(dbx, link_mode).await.c(h!())?;
    let orbit_units = persistence::load_latest_synced_source_units(dbx)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::new(&orbit_units);
    let suppressed_links = load_suppressed_links(dbx).await.c(h!())?;
    let review_units =
        prepare_review_units(&units, &matcher, link_mode, &suppressed_links);
    let (summary, links) = match link_mode {
        tui::LinkMode::Manual => review_manually(review_units).c(h!())?,
        tui::LinkMode::Automatic => approve_automatic(review_units),
    };
    let reviewed_sigint_unit_ids =
        units.iter().map(|unit| unit.id).collect::<Vec<_>>();
    let persist_summary = persist_links(
        dbx,
        &links,
        &reviewed_sigint_unit_ids,
        link_mode,
        &suppressed_links,
    )
    .await
    .c(h!())?;
    print_summary(summary, persist_summary);
    Ok(())
}

async fn load_suppressed_links<C>(
    dbx: &C,
) -> anyhow::Result<BTreeSet<(i64, uuid::Uuid)>>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(true))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| (link.sigint_unit_id, link.orbit_unit_id))
        .collect())
}

async fn load_linkable_sigint_units<C>(
    dbx: &C,
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    sigint_unit::Model::find_by_statement(Statement::from_sql_and_values(
        dbx.get_database_backend(),
        r#"
select sigint_unit.*
from sigint_unit
where sigint_unit.active = true
    and sigint_unit.deleted = false
    and not exists (
        select 1
        from orbit_unit_sigint_unit link
        inner join orbit_unit
            on orbit_unit.unit_id = link.orbit_unit_id
        where link.sigint_unit_id = sigint_unit.id
            and link.is_suppressed = false
            and orbit_unit.deleted = false
            and (link.is_manual = true or $1 = false)
    )
order by sigint_unit.id
"#,
        [matches!(link_mode, tui::LinkMode::Automatic).into()],
    ))
    .all(dbx)
    .await
    .c(h!())
}

fn review_manually(
    review_units: Vec<ReviewUnit>,
) -> anyhow::Result<(ReviewSummary, Vec<(i64, uuid::Uuid)>)> {
    let mut session = ReviewSession::new(review_units);
    let mut terminal = tui::setup_terminal().c(h!())?;
    let review_result = tui::run_test_link_review(&mut terminal, &mut session);
    tui::restore_terminal(&mut terminal).c(h!())?;
    let summary = review_result.c(h!())?;
    Ok((summary, session.accepted_links().to_vec()))
}

fn approve_automatic(
    review_units: Vec<ReviewUnit>,
) -> (ReviewSummary, Vec<(i64, uuid::Uuid)>) {
    let total = review_units.len();
    let links = review_units
        .into_iter()
        .filter_map(|unit| automatically_approved_link(&unit))
        .collect::<Vec<_>>();
    (
        ReviewSummary {
            accepted: links.len(),
            denied: 0,
            unreviewed: total.saturating_sub(links.len()),
            outcome: ReviewOutcome::Completed,
        },
        links,
    )
}

fn automatically_approved_link(unit: &ReviewUnit) -> Option<(i64, uuid::Uuid)> {
    let [candidate] = unit.matches.as_slice() else {
        return None;
    };
    (candidate.rating == ORBIT_TEST_LINK_UNITS_MAX_RATING
        && candidate.distance <= ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE)
        .then_some((unit.sigint_unit_id, candidate.unit_id))
}

async fn persist_links(
    dbx: &sea_orm::DatabaseConnection,
    links: &[(i64, uuid::Uuid)],
    reviewed_sigint_unit_ids: &[i64],
    link_mode: tui::LinkMode,
    review_suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> anyhow::Result<PersistSummary> {
    match link_mode {
        tui::LinkMode::Manual => {
            persist_manual_link_batch(dbx, links, review_suppressed_links)
                .await
                .c(h!())
        }
        tui::LinkMode::Automatic => {
            persist_automatic_link_batches(dbx, links, reviewed_sigint_unit_ids)
                .await
                .c(h!())
        }
    }
}

async fn persist_manual_link_batch(
    dbx: &sea_orm::DatabaseConnection,
    links: &[(i64, uuid::Uuid)],
    review_suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> anyhow::Result<PersistSummary> {
    if links.is_empty() {
        return Ok(PersistSummary::default());
    }
    let transaction = super::acquire_import_lock(dbx).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let orbit_units =
        persistence::load_latest_synced_source_units(&transaction)
            .await
            .c(h!())?;
    let matcher = matching::TestLinkMatcher::new(&orbit_units);
    let suppressed_links = load_suppressed_links(&transaction).await.c(h!())?;
    let suppressed_links = suppressions_to_preserve(
        suppressed_links,
        review_suppressed_links,
        tui::LinkMode::Manual,
    );
    let (summary, links_changed) = persist_manual_links(
        &transaction,
        &login,
        links,
        &matcher,
        &suppressed_links,
    )
    .await
    .c(h!())?;
    if links_changed {
        super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(summary)
}

async fn persist_automatic_link_batches(
    dbx: &sea_orm::DatabaseConnection,
    links: &[(i64, uuid::Uuid)],
    reviewed_sigint_unit_ids: &[i64],
) -> anyhow::Result<PersistSummary> {
    let mut summary = PersistSummary::default();
    for sigint_unit_ids in reviewed_sigint_unit_ids
        .chunks(ORBIT_TEST_LINK_UNITS_PERSIST_BATCH_SIZE)
    {
        let batch_summary =
            persist_automatic_link_batch(dbx, links, sigint_unit_ids)
                .await
                .c(h!())?;
        summary.already_linked += batch_summary.already_linked;
        summary.suppressed += batch_summary.suppressed;
        summary.no_longer_matching += batch_summary.no_longer_matching;
    }
    if !reviewed_sigint_unit_ids.is_empty() {
        let transaction = super::acquire_import_lock(dbx).await.c(h!())?;
        super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
            .await
            .c(h!())?;
        transaction.commit().await.c(h!())?;
    }
    Ok(summary)
}

async fn persist_automatic_link_batch(
    dbx: &sea_orm::DatabaseConnection,
    links: &[(i64, uuid::Uuid)],
    reviewed_sigint_unit_ids: &[i64],
) -> anyhow::Result<PersistSummary> {
    let transaction = super::acquire_import_lock(dbx).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let orbit_units =
        persistence::load_latest_synced_source_units(&transaction)
            .await
            .c(h!())?;
    let matcher = matching::TestLinkMatcher::new(&orbit_units);
    let suppressed_links = load_suppressed_links(&transaction).await.c(h!())?;
    let (summary, _) = revalidate_automatic_links(
        &transaction,
        &login,
        links,
        reviewed_sigint_unit_ids,
        &matcher,
        &suppressed_links,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(summary)
}

async fn persist_manual_links<C>(
    dbx: &C,
    login: &uuid::Uuid,
    links: &[(i64, uuid::Uuid)],
    matcher: &matching::TestLinkMatcher<'_>,
    suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> anyhow::Result<(PersistSummary, bool)>
where
    C: ConnectionTrait,
{
    let mut summary = PersistSummary::default();
    let mut links_changed = false;
    for (sigint_unit_id, orbit_unit_id) in links {
        if suppressed_links.contains(&(*sigint_unit_id, *orbit_unit_id)) {
            summary.suppressed += 1;
            continue;
        }
        if super::sigint_unit_has_active_orbit_link(dbx, *sigint_unit_id)
            .await
            .c(h!())?
        {
            summary.already_linked += 1;
            continue;
        }
        let Some(sigint_unit) =
            load_reviewable_sigint_unit(dbx, *sigint_unit_id)
                .await
                .c(h!())?
        else {
            summary.no_longer_matching += 1;
            continue;
        };
        if !accepted_link_is_current_match(
            &sigint_unit,
            *orbit_unit_id,
            matcher,
            tui::LinkMode::Manual,
            suppressed_links,
        ) {
            summary.no_longer_matching += 1;
            continue;
        }
        crate::sigint::unit::orbit::link_orbit_unit_with_deferred_deduplicate_reconciliation(
            dbx,
            login,
            *sigint_unit_id,
            *orbit_unit_id,
            super::LinkProvenance::Manual,
        )
        .await
        .c(h!())?;
        links_changed = true;
    }
    Ok((summary, links_changed))
}

async fn revalidate_automatic_links<C>(
    dbx: &C,
    login: &uuid::Uuid,
    links: &[(i64, uuid::Uuid)],
    reviewed_sigint_unit_ids: &[i64],
    matcher: &matching::TestLinkMatcher<'_>,
    suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> anyhow::Result<(PersistSummary, bool)>
where
    C: ConnectionTrait,
{
    let proposed_links = links.iter().copied().collect::<BTreeMap<_, _>>();
    let mut summary = PersistSummary::default();
    let mut links_changed = false;
    for sigint_unit_id in reviewed_sigint_unit_ids {
        let Some(sigint_unit) =
            load_reviewable_sigint_unit(dbx, *sigint_unit_id)
                .await
                .c(h!())?
        else {
            summary.no_longer_matching += 1;
            continue;
        };
        if sigint_unit_has_active_manual_link(dbx, *sigint_unit_id)
            .await
            .c(h!())?
        {
            summary.already_linked += 1;
            continue;
        }
        let orbit_unit_id = match proposed_links.get(sigint_unit_id).copied() {
            Some(orbit_unit_id)
                if suppressed_links
                    .contains(&(*sigint_unit_id, orbit_unit_id)) =>
            {
                summary.suppressed += 1;
                None
            }
            Some(orbit_unit_id)
                if accepted_link_is_current_match(
                    &sigint_unit,
                    orbit_unit_id,
                    matcher,
                    tui::LinkMode::Automatic,
                    suppressed_links,
                ) =>
            {
                Some(orbit_unit_id)
            }
            Some(_) => {
                summary.no_longer_matching += 1;
                None
            }
            None => None,
        };
        let removed =
            delete_automatic_links(dbx, *sigint_unit_id).await.c(h!())?;
        links_changed |= removed;
        let Some(orbit_unit_id) = orbit_unit_id else {
            if removed {
                crate::sigint::unit::orbit::reconcile_sigint_unit_orbit(
                    dbx,
                    login,
                    *sigint_unit_id,
                    true,
                )
                .await
                .c(h!())?;
            }
            continue;
        };
        crate::sigint::unit::orbit::link_orbit_unit_with_deferred_deduplicate_reconciliation(
            dbx,
            login,
            *sigint_unit_id,
            orbit_unit_id,
            super::LinkProvenance::Automatic,
        )
        .await
        .c(h!())?;
        links_changed = true;
    }
    Ok((summary, links_changed))
}

async fn sigint_unit_has_active_manual_link<C>(
    dbx: &C,
    sigint_unit_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsManual.eq(true))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn delete_automatic_links<C>(
    dbx: &C,
    sigint_unit_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::delete_many()
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsManual.eq(false))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .exec(dbx)
        .await
        .c(h!())?
        .rows_affected
        > 0)
}

fn suppressions_to_preserve(
    mut current: BTreeSet<(i64, uuid::Uuid)>,
    review: &BTreeSet<(i64, uuid::Uuid)>,
    link_mode: tui::LinkMode,
) -> BTreeSet<(i64, uuid::Uuid)> {
    if link_mode == tui::LinkMode::Manual {
        current.retain(|link| !review.contains(link));
    }
    current
}

async fn load_reviewable_sigint_unit<C>(
    dbx: &C,
    sigint_unit_id: i64,
) -> anyhow::Result<Option<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(dbx)
        .await
        .c(h!())
}

fn accepted_link_is_current_match(
    sigint_unit: &sigint_unit::Model,
    orbit_unit_id: uuid::Uuid,
    matcher: &matching::TestLinkMatcher<'_>,
    link_mode: tui::LinkMode,
    suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> bool {
    let Some(review_unit) =
        prepare_review_unit(sigint_unit, matcher, link_mode, suppressed_links)
    else {
        return false;
    };
    match link_mode {
        tui::LinkMode::Manual => review_unit
            .matches
            .iter()
            .any(|candidate| candidate.unit_id == orbit_unit_id),
        tui::LinkMode::Automatic => {
            automatically_approved_link(&review_unit)
                == Some((sigint_unit.id, orbit_unit_id))
        }
    }
}

fn prepare_review_units(
    units: &[sigint_unit::Model],
    matcher: &matching::TestLinkMatcher<'_>,
    link_mode: tui::LinkMode,
    suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> Vec<ReviewUnit> {
    let mut review_units = units
        .iter()
        .filter_map(|unit| {
            prepare_review_unit(unit, matcher, link_mode, suppressed_links)
        })
        .collect::<Vec<_>>();
    sort_review_units(&mut review_units);
    review_units
}

fn sort_review_units(review_units: &mut [ReviewUnit]) {
    review_units.sort_by_key(|unit| {
        (
            unit.matches.len() == 1,
            unit.matches
                .first()
                .map_or(usize::MAX, |candidate| candidate.distance),
        )
    });
}

fn prepare_review_unit(
    unit: &sigint_unit::Model,
    matcher: &matching::TestLinkMatcher<'_>,
    link_mode: tui::LinkMode,
    suppressed_links: &BTreeSet<(i64, uuid::Uuid)>,
) -> Option<ReviewUnit> {
    let hierarchy = matching::sigint_hierarchy(unit);
    let echelons = hierarchy
        .iter()
        .map(|(_, name)| name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let normalized_sigint_full_name = hierarchy
        .iter()
        .map(|(echelon, name)| {
            matching::normalize_sigint_name_for_echelon(*echelon, name)
        })
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let candidates = match link_mode {
        tui::LinkMode::Manual => matcher.potential_matches(&hierarchy),
        tui::LinkMode::Automatic => matcher
            .best_matches(&hierarchy)
            .into_iter()
            .filter(|(orbit_unit, _)| {
                !suppressed_links.contains(&(unit.id, orbit_unit.unit_id))
            })
            .collect(),
    };
    let mut matches = candidates
        .into_iter()
        .map(|(orbit_unit, rating)| {
            let (orbit_name, distance) =
                closest_orbit_name(&normalized_sigint_full_name, orbit_unit);
            ReviewMatch {
                unit_id: orbit_unit.unit_id,
                rating,
                distance,
                orbit_name,
            }
        })
        .collect::<Vec<_>>();
    sort_review_matches(&mut matches);
    (!matches.is_empty()).then(|| ReviewUnit {
        sigint_unit_id: unit.id,
        sigint_unit_name: unit.name.clone(),
        echelons,
        matches,
    })
}

fn closest_orbit_name(
    normalized_sigint_full_name: &str,
    orbit_unit: &crate::orbit::types::SourceUnit,
) -> (String, usize) {
    orbit_unit
        .operational_unit_name_full
        .iter()
        .chain(&orbit_unit.generative_unit_name_full)
        .filter(|name| !name.trim().is_empty())
        .map(|name| {
            (
                name.clone(),
                levenshtein::levenshtein(
                    normalized_sigint_full_name,
                    &matching::normalize_orbit_hierarchy_name(orbit_unit, name),
                ),
            )
        })
        .min_by_key(|(_, distance)| *distance)
        .expect("matched ORBIT unit must have a hierarchy name")
}

fn sort_review_matches(matches: &mut [ReviewMatch]) {
    matches.sort_by_key(|candidate| candidate.distance);
}

fn print_summary(summary: ReviewSummary, persist_summary: PersistSummary) {
    let status = match summary.outcome {
        ReviewOutcome::Completed => "Review complete",
        ReviewOutcome::EarlyExit => "Review stopped early",
    };
    println!(
        "{status}: accepted {}, denied {}, unreviewed {}, skipped {} already-linked, {} suppressed, and {} no-longer-matching.",
        summary.accepted,
        summary.denied,
        summary.unreviewed,
        persist_summary.already_linked,
        persist_summary.suppressed,
        persist_summary.no_longer_matching,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::SourceUnit;
    use sea_orm::{ActiveValue::Set, TransactionTrait};
    use serde_json::json;

    fn review_unit(match_count: usize) -> ReviewUnit {
        ReviewUnit {
            sigint_unit_id: 1,
            sigint_unit_name: "unit".to_string(),
            echelons: vec!["3 мсб".to_string()],
            matches: (0..match_count)
                .map(|index| ReviewMatch {
                    unit_id: uuid::Uuid::from_u128(index as u128),
                    rating: 100,
                    distance: index,
                    orbit_name: format!("match {index}"),
                })
                .collect(),
        }
    }

    #[test]
    fn accept_and_deny_advance_one_unit_and_update_summary() {
        let mut session =
            ReviewSession::new(vec![review_unit(1), review_unit(1)]);

        assert_eq!(session.progress(), (1, 2));
        assert_eq!(session.apply(ReviewInput::Accept(0), 0, 1), None);
        assert_eq!(session.progress(), (2, 2));
        assert_eq!(
            session.apply(ReviewInput::Deny, 0, 1),
            Some(ReviewSummary {
                accepted: 1,
                denied: 1,
                unreviewed: 0,
                outcome: ReviewOutcome::Completed,
            })
        );
    }

    #[test]
    fn units_without_matches_are_skipped() {
        let units = [sigint_unit("3 мсб")];
        let matcher = matching::TestLinkMatcher::new(&[]);

        assert!(prepare_review_units(
            &units,
            &matcher,
            tui::LinkMode::Manual,
            &BTreeSet::new(),
        )
        .is_empty());
    }

    #[test]
    fn manual_mode_keeps_matches_above_the_automatic_distance_limit() {
        let units = [sigint_unit("3 мсб")];
        let orbit_units = [orbit_unit(
            "3 мсб / a deliberately very long generative parent hierarchy",
        )];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units = prepare_review_units(
            &units,
            &matcher,
            tui::LinkMode::Manual,
            &BTreeSet::new(),
        );

        assert_eq!(review_units.len(), 1);
        assert!(
            review_units[0].matches[0].distance
                > ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE
        );
    }

    #[test]
    fn automatic_mode_uses_operational_name_when_generative_name_is_missing() {
        let units = [sigint_unit("3 мсб")];
        let mut orbit_unit = orbit_unit("3 мсб");
        orbit_unit.generative_unit_name_full = None;
        let orbit_units = [orbit_unit];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units = prepare_review_units(
            &units,
            &matcher,
            tui::LinkMode::Automatic,
            &BTreeSet::new(),
        );

        assert_eq!(review_units[0].matches[0].distance, 0);
        assert_eq!(review_units[0].matches[0].orbit_name, "3 мсб");
        assert_eq!(approve_automatic(review_units).1.len(), 1);
    }

    #[test]
    fn automatic_mode_uses_closest_available_hierarchy_name() {
        let units = [sigint_unit("3 мсб")];
        let mut orbit_unit = orbit_unit(
            "3 мсб / a deliberately different generative parent hierarchy",
        );
        orbit_unit.operational_unit_name_full = Some("3 мсб".to_string());
        let orbit_units = [orbit_unit];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units = prepare_review_units(
            &units,
            &matcher,
            tui::LinkMode::Automatic,
            &BTreeSet::new(),
        );

        assert_eq!(review_units[0].matches[0].distance, 0);
        assert_eq!(review_units[0].matches[0].orbit_name, "3 мсб");
        assert_eq!(approve_automatic(review_units).1.len(), 1);
    }

    #[test]
    fn automatic_mode_normalizes_hierarchy_names_before_distance_cutoff() {
        let mut unit = sigint_unit("3 МСБ");
        unit.company = "9 МСР".to_string();
        unit.regiment = "1 МСП".to_string();
        unit.division = "2 МСД".to_string();
        unit.army = "1 ТА".to_string();
        unit.military_district = "МВО".to_string();
        let orbit_units = [orbit_hierarchy_unit(
            uuid::Uuid::new_v4(),
            "9 мср / 3 мсб / 1 мсп / 2 мсд / 1 та / мво",
            &[
                ("company", "9 мср"),
                ("battalion", "3 мсб"),
                ("regiment", "1 мсп"),
                ("division", "2 мсд"),
                ("fieldArmy", "1 та"),
                ("militaryDistrict", "мво"),
            ],
        )];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units = prepare_review_units(
            &[unit],
            &matcher,
            tui::LinkMode::Automatic,
            &BTreeSet::new(),
        );

        assert_eq!(review_units[0].matches[0].rating, 100);
        assert_eq!(review_units[0].matches[0].distance, 0);
        assert_eq!(approve_automatic(review_units).1.len(), 1);
    }

    #[test]
    fn automatic_mode_normalizes_descriptorless_army_parent() {
        let mut unit = sigint_unit("3 мсб");
        unit.army = "58 ЗВА".to_string();
        let mut orbit_unit = orbit_hierarchy_unit(
            uuid::Uuid::new_v4(),
            "3 мсб / 58 загальновійськова армія",
            &[("battalion", "3 мсб"), ("fieldArmy", "unused")],
        );
        let army = &mut orbit_unit.operational_parent_units[0];
        army.unit_name = None;
        army.unit_name_short = None;
        army.unit_number = None;
        let orbit_units = [orbit_unit];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units = prepare_review_units(
            &[unit],
            &matcher,
            tui::LinkMode::Automatic,
            &BTreeSet::new(),
        );

        assert_eq!(review_units[0].matches[0].rating, 100);
        assert_eq!(review_units[0].matches[0].distance, 0);
        assert_eq!(approve_automatic(review_units).1.len(), 1);
    }

    #[test]
    fn automatic_mode_excludes_suppressed_links() {
        let units = [sigint_unit("3 мсб")];
        let orbit_units = [orbit_unit("3 мсб")];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);
        let suppressed_links =
            BTreeSet::from([(units[0].id, orbit_units[0].unit_id)]);

        assert!(prepare_review_units(
            &units,
            &matcher,
            tui::LinkMode::Automatic,
            &suppressed_links,
        )
        .is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn automatic_mode_revalidates_automatic_links_and_preserves_manual_links(
    ) {
        crate::tests::test::init().await;
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let login = crate::users::system_login_id(&db).await.unwrap();
        let imported_at = chrono::Utc::now().naive_utc();
        let orbit_unit = persistence::ImportUnit {
            unit_id: uuid::Uuid::new_v4(),
            unit_name: Some("changed unit".to_string()),
            unit_name_original: None,
            unit_name_short: Some("changed unit".to_string()),
            operational_unit_name_full: Some("changed unit".to_string()),
            generative_unit_name_full: Some("changed unit".to_string()),
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon_id: None,
            combat_unit_type_id: None,
            grouping_of_forces_ids: None,
            generative_parent_unit_id: None,
            operational_parent_unit_id: None,
            partial: false,
        };
        persistence::insert_unit(&db, &orbit_unit, imported_at)
            .await
            .unwrap();
        let automatic_unit = crate::functest::tests::mk_sigint_unit(
            &db,
            sigint_unit::ActiveModel {
                created_by_login_id: Set(login),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let manual_unit = crate::functest::tests::mk_sigint_unit(
            &db,
            sigint_unit::ActiveModel {
                created_by_login_id: Set(login),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for (sigint_unit_id, is_manual) in
            [(automatic_unit.id, false), (manual_unit.id, true)]
        {
            orbit_unit_sigint_unit::Entity::insert(
                orbit_unit_sigint_unit::ActiveModel {
                    orbit_unit_id: Set(orbit_unit.unit_id),
                    sigint_unit_id: Set(sigint_unit_id),
                    is_manual: Set(is_manual),
                    is_suppressed: Set(false),
                },
            )
            .exec(&db)
            .await
            .unwrap();
        }

        let automatic_ids =
            load_linkable_sigint_units(&db, tui::LinkMode::Automatic)
                .await
                .unwrap()
                .into_iter()
                .map(|unit| unit.id)
                .collect::<BTreeSet<_>>();
        let manual_ids = load_linkable_sigint_units(&db, tui::LinkMode::Manual)
            .await
            .unwrap()
            .into_iter()
            .map(|unit| unit.id)
            .collect::<BTreeSet<_>>();
        assert!(automatic_ids.contains(&automatic_unit.id));
        assert!(!automatic_ids.contains(&manual_unit.id));
        assert!(!manual_ids.contains(&automatic_unit.id));
        assert!(!manual_ids.contains(&manual_unit.id));

        let transaction = db.begin().await.unwrap();
        let (summary, links_changed) = revalidate_automatic_links(
            &transaction,
            &login,
            &[],
            &[automatic_unit.id, manual_unit.id],
            &matching::TestLinkMatcher::new(&[]),
            &BTreeSet::new(),
        )
        .await
        .unwrap();
        transaction.commit().await.unwrap();

        assert!(links_changed);
        assert_eq!(summary.already_linked, 1);
        assert!(orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId
                    .eq(automatic_unit.id),
            )
            .one(&db)
            .await
            .unwrap()
            .is_none());
        let manual_link = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId.eq(manual_unit.id),
            )
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(manual_link.is_manual);

        orbit_unit_sigint_unit::Entity::delete_many()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId
                    .is_in([automatic_unit.id, manual_unit.id]),
            )
            .exec(&db)
            .await
            .unwrap();
        sigint_unit::Entity::delete_many()
            .filter(
                sigint_unit::Column::Id
                    .is_in([automatic_unit.id, manual_unit.id]),
            )
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(orbit_unit.unit_id)
            .exec(&db)
            .await
            .unwrap();
    }

    #[test]
    fn manual_mode_preserves_only_suppressions_added_during_review() {
        let existing = (1, uuid::Uuid::new_v4());
        let concurrent = (2, uuid::Uuid::new_v4());
        let review = BTreeSet::from([existing]);
        let current = BTreeSet::from([existing, concurrent]);

        assert_eq!(
            suppressions_to_preserve(current, &review, tui::LinkMode::Manual),
            BTreeSet::from([concurrent])
        );
    }

    #[test]
    fn accepted_link_requires_current_hierarchy_match() {
        let orbit_units = [orbit_unit("3 мсб")];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);
        let orbit_unit_id = orbit_units[0].unit_id;
        let mut unit = sigint_unit("3 мсб");

        assert!(accepted_link_is_current_match(
            &unit,
            orbit_unit_id,
            &matcher,
            tui::LinkMode::Manual,
            &BTreeSet::new(),
        ));

        unit.battalion = "4 мсб".to_string();

        assert!(!accepted_link_is_current_match(
            &unit,
            orbit_unit_id,
            &matcher,
            tui::LinkMode::Manual,
            &BTreeSet::new(),
        ));
    }

    #[test]
    fn review_units_are_sorted_by_match_count_then_distance() {
        let mut single_close = review_unit(1);
        single_close.matches[0].distance = 1;
        let mut multiple = review_unit(2);
        multiple.matches[0].distance = 2;
        multiple.matches[1].distance = 3;
        let mut single_far = review_unit(1);
        single_far.matches[0].distance = 4;
        let mut units =
            vec![single_close.clone(), multiple.clone(), single_far.clone()];

        sort_review_units(&mut units);

        assert_eq!(units, vec![multiple, single_close, single_far]);
    }

    #[test]
    fn matches_are_sorted_by_distance_ascending() {
        let mut matches = review_unit(3).matches;
        matches[0].distance = 1;
        matches[1].distance = 4;
        matches[2].distance = 2;

        sort_review_matches(&mut matches);

        assert_eq!(
            matches
                .into_iter()
                .map(|candidate| candidate.distance)
                .collect::<Vec<_>>(),
            vec![1, 2, 4]
        );
    }

    #[test]
    fn match_options_are_paged_five_at_a_time() {
        let mut session = ReviewSession::new(vec![review_unit(12)]);

        assert_eq!(session.match_page_progress(), (1, 3));
        assert_eq!(session.visible_matches().len(), 5);
        assert_eq!(session.first_visible_match_number(), 1);

        session.apply(ReviewInput::NextMatchPage, 0, 1);
        assert_eq!(session.match_page_progress(), (2, 3));
        assert_eq!(session.first_visible_match_number(), 6);

        session.apply(ReviewInput::NextMatchPage, 0, 1);
        session.apply(ReviewInput::NextMatchPage, 0, 1);
        assert_eq!(session.match_page_progress(), (3, 3));
        assert_eq!(session.visible_matches().len(), 2);
        assert_eq!(session.first_visible_match_number(), 11);

        session.apply(ReviewInput::PreviousMatchPage, 0, 1);
        assert_eq!(session.match_page_progress(), (2, 3));
    }

    #[test]
    fn only_visible_options_can_be_accepted_and_page_resets() {
        let mut session =
            ReviewSession::new(vec![review_unit(12), review_unit(1)]);
        session.apply(ReviewInput::NextMatchPage, 0, 1);
        session.apply(ReviewInput::NextMatchPage, 0, 1);

        assert_eq!(session.apply(ReviewInput::Accept(2), 0, 1), None);
        assert_eq!(session.progress(), (1, 2));
        assert_eq!(session.apply(ReviewInput::Accept(1), 0, 1), None);
        assert_eq!(session.progress(), (2, 2));
        assert_eq!(session.match_page_progress(), (1, 1));
    }

    #[test]
    fn scrolling_is_clamped_and_reset_after_a_decision() {
        let mut session =
            ReviewSession::new(vec![review_unit(20), review_unit(1)]);

        session.apply(ReviewInput::PageDown, 8, 5);
        session.apply(ReviewInput::PageDown, 8, 5);
        assert_eq!(session.scroll(), 8);
        session.clamp_scroll(3);
        assert_eq!(session.scroll(), 3);
        session.apply(ReviewInput::Accept(0), 3, 5);
        assert_eq!(session.scroll(), 0);
        assert_eq!(session.progress(), (2, 2));
    }

    #[test]
    fn early_exit_leaves_current_and_remaining_units_unreviewed() {
        let mut session = ReviewSession::new(vec![review_unit(1); 3]);
        session.apply(ReviewInput::Deny, 0, 1);

        assert_eq!(
            session.finish_early(),
            ReviewSummary {
                accepted: 0,
                denied: 1,
                unreviewed: 2,
                outcome: ReviewOutcome::EarlyExit,
            }
        );
    }

    #[test]
    fn automatic_mode_accepts_only_one_close_match() {
        let mut close = review_unit(1);
        close.sigint_unit_id = 1;
        close.matches[0].distance = ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE;
        let mut far = review_unit(1);
        far.sigint_unit_id = 2;
        far.matches[0].distance = ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE + 1;
        let mut ambiguous = review_unit(2);
        ambiguous.sigint_unit_id = 3;

        let (summary, links) = approve_automatic(vec![close, far, ambiguous]);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, 1);
        assert_eq!(summary.accepted, 1);
        assert_eq!(summary.unreviewed, 2);
    }

    #[test]
    fn automatic_mode_rejects_a_close_but_inexact_unit_match() {
        let mut unit = sigint_unit("3 мсб");
        unit.id = 1396;
        unit.name = "9 шр 3 мсб 1 мсп 2 мсд 1 ТА".to_string();
        unit.company = "9 шр".to_string();
        unit.regiment = "1 мсп".to_string();
        unit.division = "2 мсд".to_string();
        unit.army = "1 ТА".to_string();
        let expected_orbit_unit_id =
            uuid::Uuid::parse_str("ecd8da54-edff-468c-90bb-dded3fcba3cd")
                .unwrap();
        let orbit_units = [
            orbit_hierarchy_unit(
                expected_orbit_unit_id,
                "9 мср / 3 мсб / 1 мсп / 2 мсд / 1 ТА / МВО",
                &[
                    ("company", "9 мср"),
                    ("battalion", "3 мсб"),
                    ("regiment", "1 мсп"),
                    ("division", "2 мсд"),
                    ("fieldArmy", "1 ТА"),
                    ("militaryDistrict", "МВО"),
                ],
            ),
            orbit_hierarchy_unit(
                uuid::Uuid::parse_str("5931fe1b-d373-4264-8557-765e5ae162fd")
                    .unwrap(),
                "9 тр / 3 тб / 1 тп / 2 мсд / 1 ТА / МВО",
                &[
                    ("company", "9 тр"),
                    ("battalion", "3 тб"),
                    ("regiment", "1 тп"),
                    ("division", "2 мсд"),
                    ("fieldArmy", "1 ТА"),
                    ("militaryDistrict", "МВО"),
                ],
            ),
        ];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units = prepare_review_units(
            &[unit],
            &matcher,
            tui::LinkMode::Automatic,
            &BTreeSet::new(),
        );

        assert_eq!(review_units.len(), 1);
        assert_eq!(review_units[0].matches.len(), 1);
        assert_eq!(review_units[0].matches[0].unit_id, expected_orbit_unit_id);
        assert_eq!(review_units[0].matches[0].rating, 99);
        assert_eq!(review_units[0].matches[0].distance, 6);
        let (summary, links) = approve_automatic(review_units);
        assert!(links.is_empty());
        assert_eq!(summary.accepted, 0);
        assert_eq!(summary.unreviewed, 1);
    }

    fn sigint_unit(battalion: &str) -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            battalion: battalion.to_string(),
            active: true,
            deleted: false,
            created_at: Default::default(),
            created_by_login_id: uuid::Uuid::nil(),
            name: "unit".to_string(),
            updated_at: Default::default(),
            company: String::new(),
            regiment: String::new(),
            division: String::new(),
            army: String::new(),
            comment: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            army_region: String::new(),
            military_district: String::new(),
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            brigade: String::new(),
            corps: String::new(),
            is_inconsistent: false,
        }
    }

    fn orbit_unit(generative_name: &str) -> SourceUnit {
        orbit_hierarchy_unit(
            uuid::Uuid::new_v4(),
            generative_name,
            &[("battalion", "3 мсб")],
        )
    }

    fn orbit_hierarchy_unit(
        unit_id: uuid::Uuid,
        generative_name: &str,
        echelons: &[(&str, &str)],
    ) -> SourceUnit {
        let (echelon, name) = echelons[0];
        let parents = echelons
            .iter()
            .skip(1)
            .enumerate()
            .map(|(path_level, (echelon, name))| {
                json!({
                    "unit_id": uuid::Uuid::new_v4(),
                    "unit_name": name,
                    "unit_name_short": name,
                    "unit_echelon": { "key": echelon, "name": echelon },
                    "path_level": path_level
                })
            })
            .collect::<Vec<_>>();
        serde_json::from_value(json!({
            "unit_id": unit_id,
            "unit_name": name,
            "unit_name_short": name,
            "operational_unit_name_full": generative_name,
            "generative_unit_name_full": generative_name,
            "unit_echelon": { "key": echelon, "name": echelon },
            "operational_parent_units": parents
        }))
        .unwrap()
    }
}

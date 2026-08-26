use super::{matching, persistence, tui};
use crate::config::{
    ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE,
    ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE, ORBIT_TEST_LINK_UNITS_MAX_RATING,
};
use crate::entities::sigint_unit;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{ConnectionTrait, FromQueryResult, Statement};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReviewMatch {
    pub unit_id: uuid::Uuid,
    pub rating: u8,
    pub distance: usize,
    pub generative_name: String,
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
    run_with_database(&dbx, link_mode).await
}

pub(super) async fn run_with_database(
    dbx: &sea_orm::DatabaseConnection,
    link_mode: tui::LinkMode,
) -> anyhow::Result<()> {
    let units = load_unlinked_sigint_units(dbx).await.c(h!())?;
    let orbit_units = persistence::load_latest_synced_source_units(dbx)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::new(&orbit_units);
    let review_units = prepare_review_units(&units, &matcher, link_mode);
    let (summary, links) = match link_mode {
        tui::LinkMode::Manual => review_manually(review_units).c(h!())?,
        tui::LinkMode::Automatic => approve_automatic(review_units),
    };
    let already_linked = persist_links(dbx, &links).await.c(h!())?;
    print_summary(summary, already_linked);
    Ok(())
}

async fn load_unlinked_sigint_units<C>(
    dbx: &C,
) -> anyhow::Result<Vec<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    sigint_unit::Model::find_by_statement(Statement::from_string(
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
    )
order by sigint_unit.id
"#,
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
        .filter_map(|unit| {
            let [candidate] = unit.matches.as_slice() else {
                return None;
            };
            (candidate.rating == ORBIT_TEST_LINK_UNITS_MAX_RATING
                && candidate.distance
                    <= ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE)
                .then_some((unit.sigint_unit_id, candidate.unit_id))
        })
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

async fn persist_links(
    dbx: &sea_orm::DatabaseConnection,
    links: &[(i64, uuid::Uuid)],
) -> anyhow::Result<usize> {
    if links.is_empty() {
        return Ok(0);
    }
    let transaction = super::acquire_import_lock(dbx).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let mut already_linked = 0;
    for (sigint_unit_id, orbit_unit_id) in links {
        if super::sigint_unit_has_active_orbit_link(
            &transaction,
            *sigint_unit_id,
        )
        .await
        .c(h!())?
        {
            already_linked += 1;
            continue;
        }
        crate::sigint::unit::orbit::link_orbit_unit_in_transaction(
            &transaction,
            &login,
            *sigint_unit_id,
            *orbit_unit_id,
        )
        .await
        .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(already_linked)
}

fn prepare_review_units(
    units: &[sigint_unit::Model],
    matcher: &matching::TestLinkMatcher<'_>,
    link_mode: tui::LinkMode,
) -> Vec<ReviewUnit> {
    let mut review_units = units
        .iter()
        .filter_map(|unit| prepare_review_unit(unit, matcher, link_mode))
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
) -> Option<ReviewUnit> {
    let hierarchy = matching::sigint_hierarchy(unit);
    let echelons = hierarchy
        .iter()
        .map(|(_, name)| name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let sigint_full_name = echelons.join(" / ");
    let candidates = match link_mode {
        tui::LinkMode::Manual => matcher.potential_matches(&hierarchy),
        tui::LinkMode::Automatic => matcher.best_matches(&hierarchy),
    };
    let mut matches = candidates
        .into_iter()
        .map(|(orbit_unit, rating)| {
            let generative_name =
                orbit_unit.generative_unit_name_full.clone().unwrap_or_else(
                    || "<missing generative full name>".to_string(),
                );
            ReviewMatch {
                unit_id: orbit_unit.unit_id,
                rating,
                distance: levenshtein::levenshtein(
                    &sigint_full_name,
                    &generative_name,
                ),
                generative_name,
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

fn sort_review_matches(matches: &mut [ReviewMatch]) {
    matches.sort_by_key(|candidate| candidate.distance);
}

fn print_summary(summary: ReviewSummary, already_linked: usize) {
    let status = match summary.outcome {
        ReviewOutcome::Completed => "Review complete",
        ReviewOutcome::EarlyExit => "Review stopped early",
    };
    println!(
        "{status}: accepted {}, denied {}, unreviewed {}, skipped {} already-linked.",
        summary.accepted, summary.denied, summary.unreviewed, already_linked
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::SourceUnit;
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
                    generative_name: format!("match {index}"),
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

        assert!(
            prepare_review_units(&units, &matcher, tui::LinkMode::Manual)
                .is_empty()
        );
    }

    #[test]
    fn manual_mode_keeps_matches_above_the_automatic_distance_limit() {
        let units = [sigint_unit("3 мсб")];
        let orbit_units = [orbit_unit(
            "3 мсб / a deliberately very long generative parent hierarchy",
        )];
        let matcher = matching::TestLinkMatcher::new(&orbit_units);

        let review_units =
            prepare_review_units(&units, &matcher, tui::LinkMode::Manual);

        assert_eq!(review_units.len(), 1);
        assert!(
            review_units[0].matches[0].distance
                > ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE
        );
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

        let review_units =
            prepare_review_units(&[unit], &matcher, tui::LinkMode::Automatic);

        assert_eq!(review_units.len(), 1);
        assert_eq!(review_units[0].matches.len(), 1);
        assert_eq!(review_units[0].matches[0].unit_id, expected_orbit_unit_id);
        assert_eq!(review_units[0].matches[0].rating, 99);
        assert_eq!(review_units[0].matches[0].distance, 8);
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

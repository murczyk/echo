use crate::config::{
    UNIT_TAG_QUEUE_WORKER_BATCH_SIZE, UNIT_TAG_QUEUE_WORKER_SLEEP_SECS,
    UNIT_TAG_RECALC_HISTORY_DAYS,
};
use crate::entities::sea_orm_active_enums::InterseptionKind;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::types::{error, Mode, ShortContext};
use crate::utils::worker_watch;
use chrono::{Duration, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use std::collections::HashSet;

pub async fn enqueue_unit_tag_recalculation_for_inbox_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_unit_tag_queue::Entity::insert(
        sigint_inbox_item_unit_tag_queue::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(sigint_inbox_item_id),
            created_at: NotSet,
        },
    )
    .on_conflict(
        OnConflict::column(
            sigint_inbox_item_unit_tag_queue::Column::SigintInboxItemId,
        )
        .do_nothing()
        .to_owned(),
    )
    .do_nothing()
    .exec(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn enqueue_recent_non_rer_unit_tag_recalculation<C>(
    db: &C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let since =
        Utc::now().naive_utc() - Duration::days(UNIT_TAG_RECALC_HISTORY_DAYS);
    let item_ids = sigint_inbox_item::Entity::find()
        .distinct()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(
            signal_group::Column::InterseptionKind.eq(InterseptionKind::Other),
        )
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    for item_id in item_ids {
        enqueue_unit_tag_recalculation_for_inbox_item(db, item_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn enqueue_recent_unit_tag_recalculation_for_group<C>(
    db: &C,
    master_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let since =
        Utc::now().naive_utc() - Duration::days(UNIT_TAG_RECALC_HISTORY_DAYS);
    let item_ids = sigint_inbox_item::Entity::find()
        .distinct()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(signal_message_group::Column::GroupMasterKey.eq(master_key))
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    for item_id in item_ids {
        enqueue_unit_tag_recalculation_for_inbox_item(db, item_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn run_unit_tag_queue_worker_nofail(mode: Mode) {
    let (_config, _settlements, _rq, _redis, dbx) =
        crate::utils::setup_worker(mode).await.unwrap();
    loop {
        let _loop_guard = worker_watch::loop_guard("unit_tag_queue_worker");
        match run_unit_tag_queue_worker_once(&dbx).await {
            Ok(has_work) => {
                if !has_work {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        UNIT_TAG_QUEUE_WORKER_SLEEP_SECS,
                    ))
                    .await;
                }
            }
            Err(err) => {
                error!("unit_tag_queue_worker failed: {err:#?}");
                tokio::time::sleep(std::time::Duration::from_secs(
                    UNIT_TAG_QUEUE_WORKER_SLEEP_SECS,
                ))
                .await;
            }
        }
    }
}

async fn run_unit_tag_queue_worker_once(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    if !crate::system_settings::support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(false);
    }
    let queue_items = sigint_inbox_item_unit_tag_queue::Entity::find()
        .order_by_asc(sigint_inbox_item_unit_tag_queue::Column::CreatedAt)
        .order_by_asc(sigint_inbox_item_unit_tag_queue::Column::Id)
        .limit(UNIT_TAG_QUEUE_WORKER_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())?;
    if queue_items.is_empty() {
        return Ok(false);
    }
    for queue_item in queue_items {
        recalculate_inbox_item_unit_tags(dbx, queue_item.sigint_inbox_item_id)
            .await
            .c(h!())?;
        sigint_inbox_item_unit_tag_queue::Entity::delete_by_id(queue_item.id)
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(true)
}

pub async fn recalculate_inbox_item_unit_tags<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    if !inbox_item_is_non_rer(db, sigint_inbox_item_id)
        .await
        .c(h!())?
    {
        delete_network_links_for_item(db, sigint_inbox_item_id)
            .await
            .c(h!())?;
        recalculate_regular_networks_for_item(db, sigint_inbox_item_id)
            .await
            .c(h!())?;
        return Ok(());
    }
    let Some((sigint_inbox_item, device_name)) =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .find_also_related(device_name::Entity)
            .one(db)
            .await
            .c(h!())?
    else {
        delete_network_links_for_item(db, sigint_inbox_item_id)
            .await
            .c(h!())?;
        return Ok(());
    };
    let active_networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    let matched_networks = match_networks_by_device_name_or_body_noheader(
        active_networks,
        device_name
            .as_ref()
            .and_then(|device_name| device_name.name.as_deref()),
        sigint_inbox_item.body_noheader.as_ref(),
    )
    .c(h!())?;
    sync_network_links(db, sigint_inbox_item_id, matched_networks)
        .await
        .c(h!())?;
    Ok(())
}

async fn recalculate_regular_networks_for_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let Some(sigint_inbox_item) =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .one(db)
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![sigint_inbox_item],
        db,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn sync_network_links<C>(
    db: &C,
    sigint_inbox_item_id: i64,
    matched_networks: Vec<sigint_network::Model>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let desired_network_ids = matched_networks
        .iter()
        .map(|network| network.id)
        .collect::<HashSet<_>>();
    let existing_network_links = sigint_inbox_item_network::Entity::find()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .all(db)
        .await
        .c(h!())?;
    let stale_network_link_ids = collect_stale_network_link_ids(
        &existing_network_links,
        &desired_network_ids,
    );
    if !stale_network_link_ids.is_empty() {
        sigint_inbox_item_network::Entity::delete_many()
            .filter(
                sigint_inbox_item_network::Column::Id
                    .is_in(stale_network_link_ids),
            )
            .exec(db)
            .await
            .c(h!())?;
    }
    let existing_network_ids = existing_network_links
        .into_iter()
        .map(|link| link.sigint_network_id)
        .collect::<HashSet<_>>();
    for network_id in desired_network_ids {
        if !existing_network_ids.contains(&network_id) {
            sigint_inbox_item_network::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(sigint_inbox_item_id),
                sigint_network_id: Set(network_id),
                created_at: NotSet,
            }
            .insert(db)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

fn collect_stale_network_link_ids(
    existing_network_links: &[sigint_inbox_item_network::Model],
    desired_network_ids: &HashSet<i64>,
) -> Vec<i64> {
    existing_network_links
        .iter()
        .filter(|link| !desired_network_ids.contains(&link.sigint_network_id))
        .map(|link| link.id)
        .collect()
}

async fn delete_network_links_for_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_network::Entity::delete_many()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn inbox_item_is_non_rer<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let count = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(
            signal_message_group::Column::SignalMessageId
                .eq(sigint_inbox_item_id),
        )
        .filter(
            signal_group::Column::InterseptionKind.eq(InterseptionKind::Other),
        )
        .count(db)
        .await
        .c(h!())?;
    Ok(count > 0)
}

fn match_networks_by_unit_tag_precedence(
    networks: Vec<sigint_network::Model>,
    match_text: &str,
) -> Vec<sigint_network::Model> {
    let matches = networks
        .into_iter()
        .flat_map(|network| network_unit_tag_matches(network, match_text))
        .collect::<Vec<_>>();
    let mut network_ids = HashSet::new();
    let mut matched_networks = Vec::new();
    for (idx, tag_match) in matches.iter().enumerate() {
        if unit_tag_match_is_shadowed(idx, &matches) {
            continue;
        }
        if network_ids.insert(tag_match.network.id) {
            matched_networks.push(tag_match.network.clone());
        }
    }
    matched_networks
}

fn match_networks_by_device_name_or_body_noheader(
    networks: Vec<sigint_network::Model>,
    device_name: Option<&str>,
    body_noheader: Option<&serde_json::Value>,
) -> anyhow::Result<Vec<sigint_network::Model>> {
    if let Some(device_name) = device_name
        .map(str::trim)
        .filter(|device_name| !device_name.is_empty())
    {
        let matched_networks = match_networks_by_unit_tag_precedence(
            networks.clone(),
            device_name,
        );
        if !matched_networks.is_empty() {
            return Ok(matched_networks);
        }
    }
    let body_noheader = body_noheader_text(body_noheader).c(h!())?;
    Ok(match_networks_by_unit_tag_precedence(
        networks,
        &body_noheader,
    ))
}

fn body_noheader_text(
    body_noheader: Option<&serde_json::Value>,
) -> anyhow::Result<String> {
    let Some(body_noheader) = body_noheader else {
        return Ok(String::new());
    };
    let body_noheader: NoHeadersBody =
        serde_json::from_value(body_noheader.clone()).c(h!())?;
    Ok(body_noheader.body)
}

fn network_unit_tag_matches(
    network: sigint_network::Model,
    match_text: &str,
) -> Vec<UnitTagMatch> {
    sigint_network_unit_mask(&network)
        .into_iter()
        .flat_map(|tag| {
            let tag_key = tag.trim().to_lowercase();
            let tag_len = tag_key.chars().count();
            find_word_matches_case_insensitive(match_text, &tag)
                .into_iter()
                .map({
                    let network = network.clone();
                    move |span| UnitTagMatch {
                        network: network.clone(),
                        tag_key: tag_key.clone(),
                        tag_len,
                        span,
                    }
                })
        })
        .collect()
}

fn unit_tag_match_is_shadowed(idx: usize, matches: &[UnitTagMatch]) -> bool {
    let tag_match = &matches[idx];
    matches.iter().enumerate().any(|(other_idx, other)| {
        other_idx != idx
            && other.tag_len > tag_match.tag_len
            && other.tag_key.contains(&tag_match.tag_key)
            && other.span.contains(&tag_match.span)
    })
}

struct UnitTagMatch {
    network: sigint_network::Model,
    tag_key: String,
    tag_len: usize,
    span: MatchSpan,
}

#[derive(Clone, Copy)]
struct MatchSpan {
    start: usize,
    end: usize,
}

impl MatchSpan {
    fn contains(&self, other: &Self) -> bool {
        self.start <= other.start && self.end >= other.end
    }
}

#[cfg(test)]
fn contains_word_case_insensitive(text: &str, needle: &str) -> bool {
    !find_word_matches_case_insensitive(text, needle).is_empty()
}

fn find_word_matches_case_insensitive(
    text: &str,
    needle: &str,
) -> Vec<MatchSpan> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Vec::new();
    }
    let text = text.to_lowercase();
    let needle = needle.to_lowercase();
    let mut matches = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find(&needle) {
        let start = cursor + offset;
        let end = start + needle.len();
        if is_boundary(&text, start, true) && is_boundary(&text, end, false) {
            matches.push(MatchSpan { start, end });
        }
        cursor = end;
    }
    matches
}

fn is_boundary(text: &str, byte_idx: usize, before: bool) -> bool {
    if before {
        text[..byte_idx]
            .chars()
            .next_back()
            .map(|ch| !ch.is_alphanumeric())
            .unwrap_or(true)
    } else {
        text[byte_idx..]
            .chars()
            .next()
            .map(|ch| !ch.is_alphanumeric())
            .unwrap_or(true)
    }
}

pub fn normalize_unit_mask(
    unit_mask: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for unit_mask in unit_mask {
        let unit_mask = unit_mask.trim().to_string();
        if unit_mask.is_empty() {
            return Err(AppError::BL {
                msg: "unit_mask must not contain empty values".to_string(),
            });
        }
        let key = unit_mask.to_lowercase();
        if seen.insert(key) {
            out.push(unit_mask);
        }
    }
    Ok(out)
}

pub fn sigint_network_unit_mask(
    sigint_network: &sigint_network::Model,
) -> Vec<String> {
    serde_json::from_value(sigint_network.unit_mask.clone()).unwrap_or_default()
}

pub async fn non_rer_item_ids_from_items<C>(
    db: &C,
    sigint_inbox_item_ids: Vec<i64>,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait,
{
    if sigint_inbox_item_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let ids = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(
            signal_message_group::Column::SignalMessageId
                .is_in(sigint_inbox_item_ids),
        )
        .filter(
            signal_group::Column::InterseptionKind.eq(InterseptionKind::Other),
        )
        .select_only()
        .column(signal_message_group::Column::SignalMessageId)
        .distinct()
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_tag_match_requires_word_boundaries() {
        assert!(contains_word_case_insensitive(
            "prefix 50 обрБпС suffix",
            "50 обрБпС"
        ));
        assert!(!contains_word_case_insensitive(
            "prefix x50 обрБпС suffix",
            "50 обрБпС"
        ));
    }

    #[test]
    fn unit_tag_match_prefers_longer_containing_tag() {
        let matched_network_ids = match_networks_by_unit_tag_precedence(
            vec![
                test_network(1, vec!["alpha/bravo"]),
                test_network(2, vec!["alpha"]),
                test_network(3, vec!["bravo"]),
            ],
            "hello alpha/bravo goodbye",
        )
        .into_iter()
        .map(|network| network.id)
        .collect::<Vec<_>>();

        assert_eq!(matched_network_ids, vec![1]);
    }

    #[test]
    fn unit_tag_match_keeps_shorter_tag_when_matched_independently() {
        let matched_network_ids = match_networks_by_unit_tag_precedence(
            vec![
                test_network(1, vec!["alpha/bravo"]),
                test_network(2, vec!["alpha"]),
            ],
            "hello alpha and alpha/bravo goodbye",
        )
        .into_iter()
        .map(|network| network.id)
        .collect::<Vec<_>>();

        assert_eq!(matched_network_ids, vec![1, 2]);
    }

    #[test]
    fn device_name_match_wins_over_body_noheader() {
        let matched_network_ids =
            match_networks_by_device_name_or_body_noheader(
                vec![
                    test_network(1, vec!["device-label"]),
                    test_network(2, vec!["body-label"]),
                ],
                Some("device-label"),
                Some(&test_body_noheader("body-label")),
            )
            .unwrap()
            .into_iter()
            .map(|network| network.id)
            .collect::<Vec<_>>();

        assert_eq!(matched_network_ids, vec![1]);
    }

    #[test]
    fn body_noheader_match_is_used_when_device_name_has_no_label() {
        let matched_network_ids =
            match_networks_by_device_name_or_body_noheader(
                vec![
                    test_network(1, vec!["device-label"]),
                    test_network(2, vec!["body-label"]),
                ],
                Some("unmatched device"),
                Some(&test_body_noheader("body-label")),
            )
            .unwrap()
            .into_iter()
            .map(|network| network.id)
            .collect::<Vec<_>>();

        assert_eq!(matched_network_ids, vec![2]);
    }

    #[test]
    fn stale_network_links_include_non_unit_tag_networks() {
        let existing_network_links =
            vec![test_network_link(10, 1), test_network_link(11, 2)];
        let desired_network_ids = HashSet::from([2]);

        assert_eq!(
            collect_stale_network_link_ids(
                &existing_network_links,
                &desired_network_ids
            ),
            vec![10]
        );
    }

    fn test_body_noheader(body: &str) -> serde_json::Value {
        serde_json::to_value(NoHeadersBody {
            body: body.to_string(),
            start: 0,
            end: body.chars().count(),
        })
        .unwrap()
    }

    fn test_network(id: i64, unit_mask: Vec<&str>) -> sigint_network::Model {
        let dt = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        sigint_network::Model {
            id,
            name: format!("network {id}"),
            location: String::new(),
            deleted: false,
            created_at: dt,
            updated_by: None,
            updated_at: dt,
            radio_station: None,
            purpose: None,
            operation_mode: None,
            operation_type: None,
            operation_period: None,
            merged_to: None,
            active_from: None,
            active_to: None,
            sigint_origin_id: None,
            original_id: None,
            do_not_archive: false,
            unit_mask: serde_json::json!(unit_mask),
        }
    }

    fn test_network_link(
        id: i64,
        sigint_network_id: i64,
    ) -> sigint_inbox_item_network::Model {
        sigint_inbox_item_network::Model {
            id,
            sigint_inbox_item_id: 100,
            sigint_network_id,
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        }
    }
}

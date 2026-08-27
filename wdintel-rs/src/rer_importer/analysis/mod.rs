use super::types::*;
use crate::config::*;
use crate::delta::types::GeoJson;
use crate::entities::sea_orm_active_enums;
use crate::entities::*;
use crate::kml::types::*;
use crate::location::utils::*;
use crate::messenger::group::collect_group_admin_data;
use crate::messenger::group::types::SignalGroupEntry;
use crate::messenger::group::types::*;
use crate::messenger::group::*;
use crate::rer_importer::report_chunking::{
    report_period_chunks, ReportPeriodEnd,
};
use crate::sigint::aor::bl::collect_group_aors;
use crate::sigint::sender::{
    preferred_group_sender_expr, preferred_message_author_expr,
};
use crate::types::*;
use crate::users::{
    ensure_rer_role, ensure_rer_role_by_id, has_any_role, has_role,
    login_id_from_identity,
};
use crate::utils::string::*;
use crate::utils::*;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpResponse;
use chrono::prelude::*;
use itertools::Itertools;
use redis::AsyncCommands;
use rust_xlsxwriter::{Format, Workbook};
use sea_orm::{prelude::Expr, sea_query::Alias, *};
use sea_query::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::error::Error as StdError;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

pub(in crate::rer_importer) mod analytics_unit;
pub mod geojson;
pub mod kmz;
pub mod search;
pub mod stats;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AnalyticsMessageIdScope {
    Empty,
    From(i64),
    Inclusive { min_id: i64, max_id: i64 },
}

impl AnalyticsMessageIdScope {
    pub(super) fn is_empty(self) -> bool {
        matches!(self, Self::Empty)
    }

    pub(super) fn condition<C>(self, column: C) -> SimpleExpr
    where
        C: IntoColumnRef,
    {
        match self {
            Self::Empty => Expr::cust("FALSE"),
            Self::From(min_id) => Expr::col(column).gte(min_id),
            Self::Inclusive { min_id, max_id } => {
                Expr::col(column).between(min_id, max_id)
            }
        }
    }
}

pub fn filter_selected_groups<Q>(
    q: Q,
    selected_groups: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_groups) = selected_groups.as_ref() {
        if !selected_groups.is_empty() {
            let exists_expr = message_in_groups_exists(selected_groups.clone());
            return Ok(q.filter(exists_expr));
        }
    }
    Ok(q)
}

pub fn filter_selected_groups_with_access<Q>(
    q: Q,
    selected_groups: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_groups) = selected_groups.as_ref() {
        if !selected_groups.is_empty() {
            let allowed: HashSet<&String> =
                allowed_groups.iter().collect::<HashSet<_>>();
            let filtered = selected_groups
                .iter()
                .filter(|key| allowed.contains(key))
                .cloned()
                .collect::<Vec<_>>();
            let exists_expr = message_in_groups_exists(filtered);
            return Ok(q.filter(exists_expr));
        }
    }
    Ok(q)
}

pub fn filter_selected_groups_and_senders_with_access<Q>(
    q: Q,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_selected_groups_and_senders_with_access_and_scope(
        q,
        selected_groups,
        selected_senders,
        allowed_groups,
        None,
    )
}

pub(super) fn filter_selected_groups_and_senders_with_access_and_scope<Q>(
    q: Q,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    allowed_groups: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let allowed: HashSet<&String> =
        allowed_groups.iter().collect::<HashSet<_>>();
    let selected_groups = selected_groups.as_ref().map(|groups| {
        groups
            .iter()
            .filter(|key| allowed.contains(key))
            .cloned()
            .collect::<Vec<_>>()
    });
    let selected_groups = selected_groups.filter(|groups| !groups.is_empty());
    let selected_senders = selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
        .cloned();

    match (selected_groups, selected_senders) {
        (Some(groups), Some(senders)) => Ok(q.filter(
            message_in_groups_with_senders_exists(&groups, &senders, scope),
        )),
        (Some(groups), None) => {
            Ok(q.filter(message_in_groups_exists_with_scope(groups, scope)))
        }
        (None, Some(senders)) => {
            Ok(q.filter(message_has_sender_in_groups_exists(
                &senders,
                allowed_groups,
                scope,
            )))
        }
        (None, None) => Ok(q),
    }
}

pub fn filter_denied_groups_with_access<Q>(
    q: Q,
    denied_groups: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_denied_groups_with_access_and_scope(
        q,
        denied_groups,
        allowed_groups,
        None,
    )
}

pub(super) fn filter_denied_groups_with_access_and_scope<Q>(
    q: Q,
    denied_groups: &Option<Vec<String>>,
    allowed_groups: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let Some(denied_groups) = denied_groups.as_ref() else {
        return Ok(q);
    };
    if denied_groups.is_empty() {
        return Ok(q);
    }

    let allowed: HashSet<&String> =
        allowed_groups.iter().collect::<HashSet<_>>();
    let filtered = denied_groups
        .iter()
        .filter(|key| allowed.contains(key))
        .cloned()
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        return Ok(q);
    }

    Ok(q.filter(message_in_groups_exists_with_scope(filtered, scope).not()))
}

pub fn message_in_groups_exists(keys: Vec<String>) -> SimpleExpr {
    message_in_groups_exists_with_scope(keys, None)
}

pub(super) fn message_in_groups_exists_with_scope(
    keys: Vec<String>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    if keys.is_empty() {
        return Expr::cust("FALSE");
    }

    let subquery = signal_message_group::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(signal_message_group::Column::GroupMasterKey.eq_any(keys));
    let subquery = match scope {
        Some(scope) => subquery.filter(scope.condition((
            signal_message_group::Entity,
            signal_message_group::Column::SignalMessageId,
        ))),
        None => subquery,
    }
    .into_query();

    Expr::exists(subquery)
}

fn message_in_groups_with_senders_exists(
    keys: &[String],
    senders: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    if keys.is_empty() || senders.is_empty() {
        return Expr::cust("FALSE");
    }

    let subquery = signal_message_group::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey.eq_any(keys.to_vec()),
        )
        .filter(preferred_group_sender_expr(None).is_in(senders.to_vec()));
    let subquery = match scope {
        Some(scope) => subquery.filter(scope.condition((
            signal_message_group::Entity,
            signal_message_group::Column::SignalMessageId,
        ))),
        None => subquery,
    }
    .into_query();

    Expr::exists(subquery)
}

pub fn filter_selected_senders<Q>(
    q: Q,
    selected_senders: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_senders) = selected_senders.as_ref() {
        if !selected_senders.is_empty() {
            return Ok(
                q.filter(message_has_sender_exists(selected_senders, None))
            );
        }
    }
    Ok(q)
}

pub fn filter_denied_senders<Q>(
    q: Q,
    denied_senders: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_denied_senders_with_scope(q, denied_senders, None)
}

pub(super) fn filter_denied_senders_with_scope<Q>(
    q: Q,
    denied_senders: &Option<Vec<String>>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(denied_senders) = denied_senders.as_ref() {
        if !denied_senders.is_empty() {
            return Ok(q.filter(
                message_has_sender_exists(denied_senders, scope).not(),
            ));
        }
    }
    Ok(q)
}

fn message_has_sender_in_groups_exists(
    senders: &[String],
    allowed_groups: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    if senders.is_empty() || allowed_groups.is_empty() {
        return Expr::cust("FALSE");
    }

    let subquery = signal_message_group::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(allowed_groups.to_vec()),
        )
        .filter(preferred_group_sender_expr(None).is_in(senders.to_vec()));
    let subquery = match scope {
        Some(scope) => subquery.filter(scope.condition((
            signal_message_group::Entity,
            signal_message_group::Column::SignalMessageId,
        ))),
        None => subquery,
    }
    .into_query();

    Expr::exists(subquery)
}

fn message_has_sender_exists(
    senders: &[String],
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    if senders.is_empty() {
        return Expr::cust("FALSE");
    }

    let subquery = signal_message_group::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(preferred_group_sender_expr(None).is_in(senders.to_vec()));
    let subquery = match scope {
        Some(scope) => subquery.filter(scope.condition((
            signal_message_group::Entity,
            signal_message_group::Column::SignalMessageId,
        ))),
        None => subquery,
    }
    .into_query();

    Expr::exists(subquery)
}

fn message_has_peleng_exists() -> SimpleExpr {
    let coords_exists = Expr::col((
        sigint_inbox_item::Entity,
        sigint_inbox_item::Column::Coords,
    ))
    .is_not_null()
    .and(
        Expr::col((
            sigint_inbox_item::Entity,
            sigint_inbox_item::Column::Coords,
        ))
        .ne(""),
    );
    let peleng_exists =
        crate::location::peleng::inbox_item_has_active_peleng_exists();
    coords_exists.or(peleng_exists)
}

fn message_has_no_peleng_exists() -> SimpleExpr {
    message_has_peleng_exists().not()
}

pub fn filter_selected_posts<Q>(
    q: Q,
    selected_posts: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_posts) = selected_posts.as_ref() {
        let include_empty =
            selected_posts.iter().any(|post| post.as_str().is_empty());
        let selected_nonempty = selected_posts
            .iter()
            .filter(|post| !post.as_str().is_empty())
            .cloned()
            .collect_vec();
        let post_name_col =
            Expr::col((sigint_post::Entity, sigint_post::Column::Name));

        if selected_nonempty.is_empty() {
            if include_empty {
                return Ok(q.filter(
                    post_name_col.clone().is_null().or(post_name_col.eq("")),
                ));
            }
            return Ok(q.filter(Expr::cust("FALSE")));
        }

        if include_empty {
            return Ok(q.filter(
                post_name_col
                    .clone()
                    .is_in(selected_nonempty)
                    .or(post_name_col.clone().is_null())
                    .or(post_name_col.eq("")),
            ));
        }

        return Ok(q.filter(post_name_col.is_in(selected_nonempty)));
    }
    Ok(q)
}

pub fn filter_selected_freqs<Q>(
    q: Q,
    selected_freqs: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_freqs) = selected_freqs.as_ref() {
        if !selected_freqs.is_empty() {
            let include_empty =
                selected_freqs.iter().any(|freq| freq.as_str().is_empty());
            let selected_nonempty = selected_freqs
                .iter()
                .filter(|freq| !freq.as_str().is_empty())
                .cloned()
                .collect_vec();
            let freq_col = Expr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Freq,
            ));

            if selected_nonempty.is_empty() {
                if include_empty {
                    return Ok(q.filter(
                        freq_col.clone().is_null().or(freq_col.eq("")),
                    ));
                }
                return Ok(q.filter(Expr::cust("FALSE")));
            }

            if include_empty {
                return Ok(q.filter(
                    freq_col
                        .clone()
                        .is_in(selected_nonempty)
                        .or(freq_col.clone().is_null())
                        .or(freq_col.eq("")),
                ));
            }

            return Ok(q.filter(freq_col.is_in(selected_nonempty)));
        }
    }
    Ok(q)
}

pub fn filter_denied_freqs<Q>(
    q: Q,
    denied_freqs: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(denied_freqs) = denied_freqs.as_ref() {
        if !denied_freqs.is_empty() {
            let include_empty =
                denied_freqs.iter().any(|freq| freq.as_str().is_empty());
            let denied_nonempty = denied_freqs
                .iter()
                .filter(|freq| !freq.as_str().is_empty())
                .cloned()
                .collect_vec();
            let freq_col = Expr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Freq,
            ));

            if include_empty {
                let mut filter =
                    freq_col.clone().is_not_null().and(freq_col.clone().ne(""));
                if !denied_nonempty.is_empty() {
                    filter = filter.and(freq_col.is_not_in(denied_nonempty));
                }
                return Ok(q.filter(filter));
            }

            return Ok(q.filter(
                freq_col
                    .clone()
                    .is_null()
                    .or(freq_col.is_not_in(denied_nonempty)),
            ));
        }
    }
    Ok(q)
}
pub fn filter_denied_posts<Q>(
    q: Q,
    denied_posts: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(denied_posts) = denied_posts.as_ref() {
        if !denied_posts.is_empty() {
            let include_empty =
                denied_posts.iter().any(|post| post.as_str().is_empty());
            let denied_nonempty = denied_posts
                .iter()
                .filter(|post| !post.as_str().is_empty())
                .cloned()
                .collect_vec();
            let post_name_col =
                Expr::col((sigint_post::Entity, sigint_post::Column::Name));

            if include_empty {
                let mut filter = post_name_col
                    .clone()
                    .is_not_null()
                    .and(post_name_col.clone().ne(""));
                if !denied_nonempty.is_empty() {
                    filter =
                        filter.and(post_name_col.is_not_in(denied_nonempty));
                }
                return Ok(q.filter(filter));
            }

            return Ok(q.filter(
                post_name_col
                    .clone()
                    .is_null()
                    .or(post_name_col.is_not_in(denied_nonempty)),
            ));
        }
    }
    Ok(q)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ExpandedUnitFilter {
    pub(crate) ordinary_names: Vec<String>,
    pub(crate) includes_undefined: bool,
    pub(crate) present: bool,
}

pub(crate) fn expand_unit_filter_values(
    units: &Option<Vec<String>>,
) -> ExpandedUnitFilter {
    let Some(units) = units.as_ref().filter(|units| !units.is_empty()) else {
        return ExpandedUnitFilter::default();
    };
    let mut ordinary_names = BTreeSet::new();
    let mut includes_undefined = false;
    for unit in units {
        if unit.is_empty() || unit == "Не визначено" {
            includes_undefined = true;
            continue;
        }
        add_unit_filter_aliases(&mut ordinary_names, unit);
    }
    ExpandedUnitFilter {
        ordinary_names: ordinary_names.into_iter().collect(),
        includes_undefined,
        present: true,
    }
}

fn add_unit_filter_aliases(aliases: &mut BTreeSet<String>, unit: &str) {
    let army_suffixes = numeric_army_suffix_aliases(unit)
        .unwrap_or_else(|| vec![unit.to_string()]);
    for alias in army_suffixes {
        aliases.insert(alias.clone());
        aliases.insert(alias.to_lowercase());
        aliases.insert(alias.to_uppercase());
    }
}

fn numeric_army_suffix_aliases(unit: &str) -> Option<Vec<String>> {
    let suffix_separator = unit.rfind(char::is_whitespace)?;
    let prefix = unit[..suffix_separator].trim_end();
    let suffix = unit[suffix_separator..].trim();
    if !matches!(suffix.to_uppercase().as_str(), "А" | "ЗА" | "ЗВА") {
        return None;
    }
    let army_number = prefix
        .rsplit_once(char::is_whitespace)
        .map_or(prefix, |(_, army_number)| army_number);
    if army_number.is_empty()
        || !army_number
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    Some(
        ["А", "ЗА", "ЗВА"]
            .into_iter()
            .map(|suffix| format!("{prefix} {suffix}"))
            .collect(),
    )
}

/// Фільтрує запит по підрозділам, які вказані в шапці повідомлення або прив'язані через Еталонні мережі
///
/// Якщо вказано прапорець `units_exact_match_only`, то фільтрує ТІЛЬКИ по підрозділам, які вказані через прив'язку по Еталонці
/// інакше або по підрозділам, які було вказано в шапці повідомлення або по еталонній прив'язці
pub fn filter_selected_units<Q>(
    q: Q,
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_selected_units_with_correlation(
        q,
        selected_units,
        units_exact_match_only,
        false,
    )
}

pub(crate) fn filter_selected_units_correlated<Q>(
    q: Q,
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_selected_units_with_correlation(
        q,
        selected_units,
        units_exact_match_only,
        true,
    )
}

fn filter_selected_units_with_correlation<Q>(
    q: Q,
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
    force_correlation: bool,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let mut m_empty_filter = None;
    let mut m_filter = None;
    let selected_units = expand_unit_filter_values(selected_units);
    if selected_units.present {
        if selected_units.includes_undefined {
            // повідомлення без жодного прив'язаного підрозділу мережі
            let no_sigint_units = message_has_linked_unit(
                Expr::col((
                    Alias::new("selected_unit"),
                    sigint_unit::Column::Name,
                ))
                .is_not_null(),
                force_correlation,
            )
            .not();
            let unit_is_not_in_message = sigint_inbox_item::Column::UnitV2
                .is_null()
                .or(sigint_inbox_item::Column::UnitV2.eq(""));
            let contains_empty = unit_is_not_in_message.and(no_sigint_units);
            m_empty_filter = Some(contains_empty);
        }
        if !selected_units.ordinary_names.is_empty() {
            let selected_units = selected_units.ordinary_names;
            let exact_match_only = units_exact_match_only.unwrap_or(false);
            let linked_unit_match = linked_unit_matches_selected_units(
                selected_units.clone(),
                !exact_match_only,
            );
            let in_subquery_condition =
                message_has_linked_unit(linked_unit_match, force_correlation);

            // якщо встановлено прапорець `units_exact_match_only`, то фільтруємо ТІЛЬКИ по підрозділам, які вказані через прив'язку по Еталонці
            let expr = if exact_match_only {
                in_subquery_condition
            } else {
                // інакше фільтруємо по підрозділам які було вказано в шапці повідомлення, або по прив'язаним через Еталонні мережі
                sigint_inbox_item::Column::UnitV2
                    .eq_any(selected_units.clone())
                    .or(in_subquery_condition)
            };

            m_filter = Some(expr);
        }
    }
    match (m_filter, m_empty_filter) {
        (None, None) => Ok(q),
        (None, Some(f)) => Ok(q.filter(f)),
        (Some(f), None) => Ok(q.filter(f)),
        (Some(f1), Some(f2)) => Ok(q.filter(f1.or(f2))),
    }
}

/// Фільтрує запит, виключаючи повідомлення, що відповідають вказаним підрозділам.
///
/// Симетрична до [`filter_selected_units`]: «окрім» = NOT(умова, що дала б «лише»).
/// Прапорець `units_exact_match_only` працює так само — звужує область виключення
/// лише до прив'язки через Еталонні мережі (інакше — також за `unit_v2` з шапки).
///
/// Спецзначення `"Не визначено"` / `""` виключає повідомлення без відомого підрозділу
/// (немає `unit_v2` І немає прив'язки через Еталонку).
pub fn filter_denied_units<Q>(
    q: Q,
    denied_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_denied_units_with_correlation(
        q,
        denied_units,
        units_exact_match_only,
        false,
    )
}

pub(crate) fn filter_denied_units_correlated<Q>(
    q: Q,
    denied_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_denied_units_with_correlation(
        q,
        denied_units,
        units_exact_match_only,
        true,
    )
}

fn filter_denied_units_with_correlation<Q>(
    q: Q,
    denied_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
    force_correlation: bool,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let mut m_empty_filter = None;
    let mut m_filter = None;
    let denied_units = expand_unit_filter_values(denied_units);
    if denied_units.present {
        if denied_units.includes_undefined {
            // повідомлення без жодного прив'язаного підрозділу мережі
            let no_sigint_units = message_has_linked_unit(
                Expr::col((
                    Alias::new("selected_unit"),
                    sigint_unit::Column::Name,
                ))
                .is_not_null(),
                force_correlation,
            )
            .not();
            let unit_is_not_in_message = sigint_inbox_item::Column::UnitV2
                .is_null()
                .or(sigint_inbox_item::Column::UnitV2.eq(""));
            let contains_empty = unit_is_not_in_message.and(no_sigint_units);
            m_empty_filter = Some(contains_empty.not());
        }
        if !denied_units.ordinary_names.is_empty() {
            let selected_units = denied_units.ordinary_names;
            let exact_match_only = units_exact_match_only.unwrap_or(false);
            let linked_unit_match = linked_unit_matches_selected_units(
                selected_units.clone(),
                !exact_match_only,
            );
            let in_subquery_condition =
                message_has_linked_unit(linked_unit_match, force_correlation)
                    .not();

            let expr = if exact_match_only {
                in_subquery_condition
            } else {
                // якщо встановлено прапорець `units_exact_match_only`, то фільтруємо ТІЛЬКИ по підрозділам, які вказані через прив'язку по Еталонці
                let header_unit_not_denied = sigint_inbox_item::Column::UnitV2
                    .is_null()
                    .or(sigint_inbox_item::Column::UnitV2.eq(""))
                    .or(sigint_inbox_item::Column::UnitV2
                        .ne_all(selected_units));

                // інакше фільтруємо по підрозділам які було вказано в шапці повідомлення, або по прив'язаним через Еталонні мережі
                header_unit_not_denied.and(in_subquery_condition)
            };

            m_filter = Some(expr);
        }
    }
    match (m_filter, m_empty_filter) {
        (None, None) => Ok(q),
        (None, Some(f)) => Ok(q.filter(f)),
        (Some(f), None) => Ok(q.filter(f)),
        (Some(f1), Some(f2)) => Ok(q.filter(f1.and(f2))),
    }
}

fn linked_unit_matches_selected_units(
    selected_units: Vec<String>,
    include_hierarchy: bool,
) -> SimpleExpr {
    let selected_units =
        expand_unit_filter_values(&Some(selected_units)).ordinary_names;
    let unit_alias = Alias::new("selected_unit");
    let unit_matches =
        Expr::col((unit_alias.clone(), sigint_unit::Column::Name))
            .is_in(selected_units.clone());

    if !include_hierarchy {
        return unit_matches;
    }

    unit_matches
        .or(unresolved_hierarchy_column_matches_selected_units(
            &selected_units,
            unit_alias.clone(),
        ))
        .or(selected_parent_unit_matches_linked_unit(
            selected_units,
            unit_alias,
        ))
}

fn unresolved_hierarchy_column_matches_selected_units(
    selected_units: &[String],
    linked_unit_alias: Alias,
) -> SimpleExpr {
    let columns = sigint_unit_hierarchy_columns();
    columns[1..].iter().fold(
        unresolved_hierarchy_column_matches_selected_unit(
            selected_units,
            linked_unit_alias.clone(),
            columns[0],
        ),
        |expr, column| {
            expr.or(unresolved_hierarchy_column_matches_selected_unit(
                selected_units,
                linked_unit_alias.clone(),
                *column,
            ))
        },
    )
}

fn unresolved_hierarchy_column_matches_selected_unit(
    selected_units: &[String],
    linked_unit_alias: Alias,
    column: sigint_unit::Column,
) -> SimpleExpr {
    Expr::col((linked_unit_alias.clone(), column))
        .is_in(selected_units.to_vec())
        .and(
            catalog_hierarchy_unit_exists_for_column_value(
                linked_unit_alias,
                column,
            )
            .not(),
        )
}

fn catalog_hierarchy_unit_exists_for_column_value(
    linked_unit_alias: Alias,
    column: sigint_unit::Column,
) -> SimpleExpr {
    let catalog_unit_alias = Alias::new("selected_hierarchy_unit");
    Expr::exists(
        Query::select()
            .expr(Expr::value(1))
            .from_as(sigint_unit::Entity, catalog_unit_alias.clone())
            .and_where(
                Expr::col((
                    catalog_unit_alias.clone(),
                    sigint_unit::Column::Name,
                ))
                .equals((linked_unit_alias, column)),
            )
            .and_where(
                Expr::col((
                    catalog_unit_alias.clone(),
                    sigint_unit::Column::Deleted,
                ))
                .eq(false),
            )
            .and_where(sigint_unit_has_any_hierarchy_value(catalog_unit_alias))
            .to_owned(),
    )
}

fn selected_parent_unit_matches_linked_unit(
    selected_units: Vec<String>,
    linked_unit_alias: Alias,
) -> SimpleExpr {
    let parent_unit_alias = Alias::new("selected_parent_unit");
    let mut query = Query::select();
    query
        .expr(Expr::value(1))
        .from_as(sigint_unit::Entity, parent_unit_alias.clone())
        .and_where(
            Expr::col((parent_unit_alias.clone(), sigint_unit::Column::Name))
                .is_in(selected_units),
        )
        .and_where(
            Expr::col((
                parent_unit_alias.clone(),
                sigint_unit::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(sigint_unit_has_any_hierarchy_value(
            parent_unit_alias.clone(),
        ));
    for column in sigint_unit_hierarchy_columns() {
        query.and_where(parent_hierarchy_column_matches_linked_unit(
            parent_unit_alias.clone(),
            linked_unit_alias.clone(),
            column,
        ));
    }

    Expr::exists(query.to_owned())
}

fn parent_hierarchy_column_matches_linked_unit(
    parent_unit_alias: Alias,
    linked_unit_alias: Alias,
    column: sigint_unit::Column,
) -> SimpleExpr {
    let parent_column = Expr::col((parent_unit_alias, column));
    parent_column
        .clone()
        .eq("")
        .or(parent_column.equals((linked_unit_alias, column)))
}

fn sigint_unit_has_any_hierarchy_value(unit_alias: Alias) -> SimpleExpr {
    let columns = sigint_unit_hierarchy_columns();
    columns[1..].iter().fold(
        Expr::col((unit_alias.clone(), columns[0])).ne(""),
        |expr, column| expr.or(Expr::col((unit_alias.clone(), *column)).ne("")),
    )
}

fn sigint_unit_hierarchy_columns() -> [sigint_unit::Column; 5] {
    [
        sigint_unit::Column::Company,
        sigint_unit::Column::Battalion,
        sigint_unit::Column::Regiment,
        sigint_unit::Column::Division,
        sigint_unit::Column::Army,
    ]
}

fn message_has_linked_unit(
    filter_expr: SimpleExpr,
    force_correlation: bool,
) -> SimpleExpr {
    let mut query = select_sigint_units_by_names(filter_expr);
    if force_correlation {
        query.offset(0);
    }
    Expr::exists(query)
}

pub(super) fn selected_unit_network_ids_query(
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
) -> Option<SelectStatement> {
    let selected_units = expand_unit_filter_values(selected_units);
    if selected_units.includes_undefined {
        return None;
    }
    if selected_units.ordinary_names.is_empty() {
        return None;
    }
    let exact_match_only = units_exact_match_only.unwrap_or(false);
    Some(select_network_ids_by_unit(
        linked_unit_matches_selected_units(
            selected_units.ordinary_names,
            !exact_match_only,
        ),
    ))
}

pub(super) fn selected_unit_inbox_item_ids_query(
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
    matching_network_ids_alias: Alias,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<SelectStatement, AppError> {
    let selected_units = expand_unit_filter_values(selected_units);
    let selected_units = (!selected_units.ordinary_names.is_empty())
        .then_some(selected_units.ordinary_names)
        .context(h!())?;

    let linked_inbox_item_ids = select_linked_unit_inbox_item_ids(
        matching_network_ids_alias,
        dt_since,
        dt_till,
    );
    if units_exact_match_only.unwrap_or(false) {
        return Ok(linked_inbox_item_ids);
    }

    let mut inbox_item_ids =
        select_header_unit_inbox_item_ids(selected_units, dt_since, dt_till);
    inbox_item_ids.union(UnionType::All, linked_inbox_item_ids);
    Ok(inbox_item_ids)
}

pub(super) fn filter_selected_units_for_period<Q>(
    q: Q,
    selected_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let Some(matching_ids) = unit_match_ids_for_period(
        selected_units,
        units_exact_match_only,
        dt_since,
        dt_till,
    )?
    else {
        return filter_selected_units(
            q,
            selected_units,
            units_exact_match_only,
        );
    };
    Ok(q.filter(Expr::cust(format!(
        r#""sigint_inbox_item"."id" IN ({matching_ids})"#
    ))))
}

pub(super) fn filter_denied_units_for_period<Q>(
    q: Q,
    denied_units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let Some(matching_ids) = unit_match_ids_for_period(
        denied_units,
        units_exact_match_only,
        dt_since,
        dt_till,
    )?
    else {
        return filter_denied_units(q, denied_units, units_exact_match_only);
    };
    Ok(q.filter(Expr::cust(format!(
        r#""sigint_inbox_item"."id" NOT IN ({matching_ids})"#
    ))))
}

fn unit_match_ids_for_period(
    units: &Option<Vec<String>>,
    units_exact_match_only: &Option<bool>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Option<String>, AppError> {
    let matching_network_ids_alias = Alias::new("matching_unit_network_ids");
    let matching_inbox_item_ids_alias =
        Alias::new("matching_unit_inbox_item_ids");
    let Some(matching_network_ids) =
        selected_unit_network_ids_query(units, units_exact_match_only)
    else {
        return Ok(None);
    };
    let matching_inbox_item_ids = selected_unit_inbox_item_ids_query(
        units,
        units_exact_match_only,
        matching_network_ids_alias.clone(),
        dt_since,
        dt_till,
    )?;
    let matching_ids = Query::select()
        .column((
            matching_inbox_item_ids_alias.clone(),
            sigint_inbox_item::Column::Id,
        ))
        .from(matching_inbox_item_ids_alias.clone())
        .to_owned();
    let mut with_clause = Query::with();
    with_clause
        .cte(
            CommonTableExpression::new()
                .query(matching_network_ids)
                .table_name(matching_network_ids_alias)
                .materialized(true)
                .to_owned(),
        )
        .cte(
            CommonTableExpression::new()
                .query(matching_inbox_item_ids)
                .table_name(matching_inbox_item_ids_alias)
                .materialized(true)
                .to_owned(),
        );
    let matching_ids = with_clause
        .query(matching_ids)
        .to_string(PostgresQueryBuilder);
    Ok(Some(matching_ids))
}

fn select_header_unit_inbox_item_ids(
    selected_units: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> SelectStatement {
    let inbox_item_alias = Alias::new("selected_header_unit_inbox_item");
    Query::select()
        .column((inbox_item_alias.clone(), sigint_inbox_item::Column::Id))
        .from_as(sigint_inbox_item::Entity, inbox_item_alias.clone())
        .and_where(
            Expr::col((
                inbox_item_alias.clone(),
                sigint_inbox_item::Column::Datetime,
            ))
            .gte(dt_since),
        )
        .and_where(
            Expr::col((
                inbox_item_alias.clone(),
                sigint_inbox_item::Column::Datetime,
            ))
            .lt(dt_till),
        )
        .and_where(
            Expr::col((inbox_item_alias, sigint_inbox_item::Column::UnitV2))
                .is_in(selected_units),
        )
        .to_owned()
}

fn select_linked_unit_inbox_item_ids(
    matching_network_ids_alias: Alias,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> SelectStatement {
    let inbox_item_alias = Alias::new("selected_linked_unit_inbox_item");
    let inbox_network_alias = Alias::new("selected_linked_unit_inbox_network");
    let network_alias = Alias::new("selected_linked_unit_network");
    let network_freq_alias = Alias::new("selected_linked_unit_network_freq");
    Query::select()
        .column((inbox_item_alias.clone(), sigint_inbox_item::Column::Id))
        .from(matching_network_ids_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            inbox_network_alias.clone(),
            Expr::col((
                inbox_network_alias.clone(),
                sigint_inbox_item_network::Column::SigintNetworkId,
            ))
            .equals((
                matching_network_ids_alias,
                sigint_network_unit::Column::NetworkId,
            )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Entity,
            inbox_item_alias.clone(),
            Expr::col((
                inbox_item_alias.clone(),
                sigint_inbox_item::Column::Id,
            ))
            .equals((
                inbox_network_alias.clone(),
                sigint_inbox_item_network::Column::SigintInboxItemId,
            )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((
                    inbox_network_alias,
                    sigint_inbox_item_network::Column::SigintNetworkId,
                )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_freq::Entity,
            network_freq_alias.clone(),
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::NetworkId,
            ))
            .equals((network_alias.clone(), sigint_network::Column::Id))
            .and(
                Expr::col((
                    network_freq_alias.clone(),
                    sigint_network_freq::Column::Freq,
                ))
                .equals((
                    inbox_item_alias.clone(),
                    sigint_inbox_item::Column::Freq,
                )),
            ),
        )
        .cond_where(linked_unit_inbox_item_is_active(
            inbox_item_alias,
            network_alias,
            network_freq_alias,
            dt_since,
            dt_till,
        ))
        .to_owned()
}

fn linked_unit_inbox_item_is_active(
    inbox_item_alias: Alias,
    network_alias: Alias,
    network_freq_alias: Alias,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Condition {
    let message_datetime =
        Expr::col((inbox_item_alias, sigint_inbox_item::Column::Datetime));
    Condition::all()
        .add(message_datetime.clone().gte(dt_since))
        .add(message_datetime.clone().lt(dt_till))
        .add(
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::ActiveFrom,
            ))
            .lte(message_datetime.clone()),
        )
        .add(
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::ActiveTo,
            ))
            .is_null()
            .or(Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::ActiveTo,
            ))
            .gte(message_datetime.clone())),
        )
        .add(
            Expr::col((network_alias.clone(), sigint_network::Column::Deleted))
                .eq(false),
        )
        .add(
            Expr::col((
                network_freq_alias,
                sigint_network_freq::Column::Deleted,
            ))
            .eq(false),
        )
        .add(
            Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveFrom,
            ))
            .is_null()
            .or(Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveFrom,
            ))
            .lte(message_datetime.clone())),
        )
        .add(
            Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveTo,
            ))
            .is_null()
            .or(Expr::col((
                network_alias,
                sigint_network::Column::ActiveTo,
            ))
            .gte(message_datetime)),
        )
}

/// Ця функція обирає тільки ті повідомлення, для яких є активна мережа
/// з прив'язаним підрозділом, який задовольняє `filter_expr`.
fn select_sigint_units_by_names(filter_expr: SimpleExpr) -> SelectStatement {
    select_sigint_units_by_network_ids(select_network_ids_by_unit(filter_expr))
}

fn select_sigint_units_by_network_ids(
    matching_network_ids: SelectStatement,
) -> SelectStatement {
    let inbox_network_alias = Alias::new("selected_unit_inbox_network");
    let network_alias = Alias::new("selected_unit_network");
    let network_freq_alias = Alias::new("selected_unit_network_freq");
    let message_datetime = Expr::col((
        sigint_inbox_item::Entity,
        sigint_inbox_item::Column::Datetime,
    ));
    Query::select()
        .expr(Expr::value(1))
        .from_as(
            sigint_inbox_item_network::Entity,
            inbox_network_alias.clone(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((
                    inbox_network_alias.clone(),
                    sigint_inbox_item_network::Column::SigintNetworkId,
                )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_freq::Entity,
            network_freq_alias.clone(),
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::NetworkId,
            ))
            .equals((network_alias.clone(), sigint_network::Column::Id)),
        )
        .and_where(
            Expr::col((
                inbox_network_alias.clone(),
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .and_where(
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::Freq,
            ))
            .equals((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Freq,
            )),
        )
        .and_where(
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::ActiveFrom,
            ))
            .lte(message_datetime.clone()),
        )
        .and_where(
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::ActiveTo,
            ))
            .is_null()
            .or(Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::ActiveTo,
            ))
            .gte(message_datetime.clone())),
        )
        .and_where(
            Expr::col((network_alias.clone(), sigint_network::Column::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((
                network_freq_alias.clone(),
                sigint_network_freq::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(
            Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveFrom,
            ))
            .is_null()
            .or(Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveFrom,
            ))
            .lte(message_datetime.clone())),
        )
        .and_where(
            Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveTo,
            ))
            .is_null()
            .or(Expr::col((
                network_alias.clone(),
                sigint_network::Column::ActiveTo,
            ))
            .gte(message_datetime.clone())),
        )
        .and_where(
            Expr::col((network_alias, sigint_network::Column::Id))
                .in_subquery(matching_network_ids),
        )
        .to_owned()
}

fn select_network_ids_by_unit(filter_expr: SimpleExpr) -> SelectStatement {
    let network_unit_alias = Alias::new("selected_unit_network_unit");
    let unit_alias = Alias::new("selected_unit");
    Query::select()
        .distinct()
        .column((
            network_unit_alias.clone(),
            sigint_network_unit::Column::NetworkId,
        ))
        .from_as(sigint_network_unit::Entity, network_unit_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_unit::Entity,
            unit_alias.clone(),
            Expr::col((unit_alias.clone(), sigint_unit::Column::Id)).equals((
                network_unit_alias,
                sigint_network_unit::Column::UnitId,
            )),
        )
        .and_where(
            Expr::col((unit_alias, sigint_unit::Column::Deleted)).eq(false),
        )
        .and_where(filter_expr)
        .to_owned()
}

pub fn filter_selected_locations<Q>(
    q: Q,
    selected_locations: &Option<Vec<String>>,
    include_peleng_locations: bool,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_locations) = selected_locations.as_ref() {
        if !selected_locations.is_empty() {
            let mut nonempty_locations = vec![];
            let mut expressions = vec![];
            let mut include_empty = false;
            for location in selected_locations {
                if location_is_empty(location) {
                    include_empty = true;
                } else {
                    nonempty_locations.push(location.clone());
                    let loc = format_location(location);
                    expressions.push(sea_orm::ColumnTrait::contains(
                        &sigint_inbox_item::Column::LocationV2,
                        loc,
                    ));
                }
            }
            if include_peleng_locations && !nonempty_locations.is_empty() {
                expressions.push(
                    sigint_inbox_item::Column::Freq.in_subquery(
                        Query::select()
                            .column(freq_location::Column::Freq)
                            .from(freq_location::Entity)
                            .and_where(
                                freq_location::Column::Location
                                    .eq_any(nonempty_locations),
                            )
                            .to_owned(),
                    ),
                )
            }
            if include_empty {
                expressions
                    .push(sigint_inbox_item::Column::LocationV2.is_null());
            }
            let expr = expressions.into_iter().reduce(|a, b| a.or(b));
            if let Some(expr) = expr {
                return Ok(q.filter(expr));
            }
        }
    }
    Ok(q)
}

pub fn filter_selected_callsigns<Q>(
    q: Q,
    selected_callsigns: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(selected_callsigns) = selected_callsigns.as_ref() {
        if !selected_callsigns.is_empty() {
            return Ok(q.filter(SimpleExpr::Custom(
                crate::inbox::callsigns::sql_filter_condition(
                    selected_callsigns,
                )
                .into(),
            )));
        }
    }
    Ok(q)
}

pub fn filter_selected_device_names<Q>(
    q: Q,
    selected_device_names: &Option<Vec<String>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let Some(selected_device_names) = selected_device_names
        .as_ref()
        .filter(|names| !names.is_empty())
    else {
        return Ok(q);
    };

    let device_name_ids = device_name::Entity::find()
        .select_only()
        .column(device_name::Column::Id)
        .filter(device_name::Column::Name.is_in(selected_device_names.clone()))
        .into_query();
    Ok(q.filter(
        sigint_inbox_item::Column::DeviceNameId.in_subquery(device_name_ids),
    ))
}

fn get_related_tag_items_filter(
    unique_tags: BTreeSet<i64>,
    tag_filter_option: TagFilterOption,
    without_model_tags: bool,
    report_tags_only_this_unit: bool,
    access: TagFilterAccess<'_>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    let expected_count = unique_tags.len();

    let mut q = sigint_inbox_item_tag::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_tag::Relation::Tag.def(),
        )
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .filter(
            sigint_inbox_item_tag::Column::TagId
                .eq_any(unique_tags.into_iter().collect::<Vec<_>>()),
        )
        .filter(
            sigint_inbox_item_tag::Column::Confidence
                .gte(TAG_MINIMUM_CONFIDENCE),
        )
        .filter(access.owner_condition())
        .select_only();

    if let Some(scope) = scope {
        q = q.filter(scope.condition((
            sigint_inbox_item_tag::Entity,
            sigint_inbox_item_tag::Column::SigintInboxItemId,
        )));
    }

    if without_model_tags {
        q = q.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }

    if report_tags_only_this_unit {
        q = q.filter(access.unit_login_condition("u2", true));
    }

    match tag_filter_option {
        TagFilterOption::OneOfTags => {
            Expr::exists(q.expr(Expr::value(1)).into_query())
        }
        TagFilterOption::AllTags => {
            let subquery = q
                .expr(
                    Expr::col((
                        sigint_inbox_item_tag::Entity,
                        sigint_inbox_item_tag::Column::Id,
                    ))
                    .count(),
                )
                .into_query()
                .into_sub_query_statement();
            SimpleExpr::SubQuery(None, Box::new(subquery))
                .eq(expected_count as u64)
        }
    }
}

pub(crate) fn accessible_tag_owner_condition(
    user_id: &uuid::Uuid,
) -> Condition {
    let mut organism_query = Query::select();
    organism_query
        .column(login::Column::OrganismId)
        .from(login::Entity)
        .and_where(login::Column::Id.eq(*user_id))
        .and_where(login::Column::DeletedPermanently.eq(false));

    Condition::any()
        .add(tag::Column::OwnerOrganismId.is_null())
        .add(tag::Column::OwnerOrganismId.in_subquery(organism_query))
}

pub(crate) fn accessible_tag_ids_condition(
    accessible_tag_ids: &[i64],
) -> Condition {
    if accessible_tag_ids.is_empty() {
        Condition::all().add(Expr::cust("FALSE"))
    } else {
        Condition::all()
            .add(tag::Column::Id.eq_any(accessible_tag_ids.to_vec()))
    }
}

fn tag_presence_exists(
    without_model_tags: bool,
    report_tags_only_this_unit: bool,
    access: TagFilterAccess<'_>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    let mut q = sigint_inbox_item_tag::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .filter(
            sigint_inbox_item_tag::Column::Confidence
                .gte(TAG_MINIMUM_CONFIDENCE),
        );

    if let Some(scope) = scope {
        q = q.filter(scope.condition((
            sigint_inbox_item_tag::Entity,
            sigint_inbox_item_tag::Column::SigintInboxItemId,
        )));
    }

    if without_model_tags {
        q = q.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }

    if report_tags_only_this_unit {
        q = q.filter(access.unit_login_condition("t_user", false));
    }

    Expr::exists(q.into_query())
}

pub fn filter_selected_tags<Q>(
    q: Q,
    selected_tags: &Option<Vec<i64>>,
    denied_tags: &Option<Vec<i64>>,
    tag_presence: &Option<TagPresenceFilter>,
    or_bookmarked: &Option<bool>,
    or_important: &Option<bool>,
    or_with_coords: &Option<bool>,
    or_without_coords: &Option<bool>,
    or_with_extended_form: &Option<bool>,
    filter_tags_option: &Option<TagFilterOption>,
    without_model_tags: &Option<bool>,
    user_id: &uuid::Uuid,
    report_tags_only_this_unit: bool,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect + Clone,
{
    filter_selected_tags_with_access(
        q,
        selected_tags,
        denied_tags,
        tag_presence,
        or_bookmarked,
        or_important,
        or_with_coords,
        or_without_coords,
        or_with_extended_form,
        filter_tags_option,
        without_model_tags,
        report_tags_only_this_unit,
        TagFilterAccess::Unresolved { user_id },
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn filter_selected_tags_with_scope<Q>(
    q: Q,
    selected_tags: &Option<Vec<i64>>,
    denied_tags: &Option<Vec<i64>>,
    tag_presence: &Option<TagPresenceFilter>,
    or_bookmarked: &Option<bool>,
    or_important: &Option<bool>,
    or_with_coords: &Option<bool>,
    or_without_coords: &Option<bool>,
    or_with_extended_form: &Option<bool>,
    filter_tags_option: &Option<TagFilterOption>,
    without_model_tags: &Option<bool>,
    user_id: &uuid::Uuid,
    report_tags_only_this_unit: bool,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect + Clone,
{
    filter_selected_tags_with_access(
        q,
        selected_tags,
        denied_tags,
        tag_presence,
        or_bookmarked,
        or_important,
        or_with_coords,
        or_without_coords,
        or_with_extended_form,
        filter_tags_option,
        without_model_tags,
        report_tags_only_this_unit,
        TagFilterAccess::Unresolved { user_id },
        scope,
    )
}

pub(super) fn filter_selected_tags_analytics<Q>(
    q: Q,
    selected_tags: &Option<Vec<i64>>,
    denied_tags: &Option<Vec<i64>>,
    tag_presence: &Option<TagPresenceFilter>,
    or_bookmarked: &Option<bool>,
    or_important: &Option<bool>,
    or_with_coords: &Option<bool>,
    or_without_coords: &Option<bool>,
    or_with_extended_form: &Option<bool>,
    filter_tags_option: &Option<TagFilterOption>,
    without_model_tags: &Option<bool>,
    user_id: &uuid::Uuid,
    report_tags_only_this_unit: bool,
    accessible_tag_ids: &[i64],
    unit_login_ids: &[uuid::Uuid],
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect + Clone,
{
    filter_selected_tags_with_access(
        q,
        selected_tags,
        denied_tags,
        tag_presence,
        or_bookmarked,
        or_important,
        or_with_coords,
        or_without_coords,
        or_with_extended_form,
        filter_tags_option,
        without_model_tags,
        report_tags_only_this_unit,
        TagFilterAccess::Resolved {
            user_id,
            accessible_tag_ids,
            unit_login_ids,
        },
        scope,
    )
}

#[allow(clippy::too_many_arguments)]
fn filter_selected_tags_with_access<Q>(
    q: Q,
    selected_tags: &Option<Vec<i64>>,
    denied_tags: &Option<Vec<i64>>,
    tag_presence: &Option<TagPresenceFilter>,
    or_bookmarked: &Option<bool>,
    or_important: &Option<bool>,
    or_with_coords: &Option<bool>,
    or_without_coords: &Option<bool>,
    or_with_extended_form: &Option<bool>,
    filter_tags_option: &Option<TagFilterOption>,
    without_model_tags: &Option<bool>,
    report_tags_only_this_unit: bool,
    access: TagFilterAccess<'_>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect + Clone,
{
    let mut q = q.clone();
    let mut m_inner_expr = None;
    let mut m_access_expr = None;
    if let Some(selected_tags) = selected_tags.as_ref() {
        if !selected_tags.is_empty() {
            let unique_tags: BTreeSet<i64> =
                selected_tags.iter().cloned().collect();
            m_access_expr = Some(selected_tags_accessible_expr(
                unique_tags.clone(),
                access,
            ));
            let tag_filter_option =
                filter_tags_option.unwrap_or(TagFilterOption::OneOfTags);
            let without_model_tags = without_model_tags.unwrap_or(false);
            m_inner_expr = Some(get_related_tag_items_filter(
                unique_tags,
                tag_filter_option,
                without_model_tags,
                report_tags_only_this_unit,
                access,
                scope,
            ));
        }
    }
    if or_bookmarked == &Some(true) {
        let bookmark_exists = sigint_bookmark::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                Expr::col((
                    sigint_bookmark::Entity,
                    sigint_bookmark::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(sigint_bookmark::Column::Deleted.eq(false))
            .filter(sigint_bookmark::Column::LoginId.eq(*access.user_id()))
            .into_query();
        let bookmark_exists_expr = Expr::exists(bookmark_exists);

        m_inner_expr = m_inner_expr
            .map(|x| x.or(bookmark_exists_expr.clone()))
            .or(Some(bookmark_exists_expr.clone()));
    }
    if or_important == &Some(true) {
        let important_exists = sigint_important::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                Expr::col((
                    sigint_important::Entity,
                    sigint_important::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(sigint_important::Column::Deleted.eq(false))
            .into_query();
        let important_exists_expr = Expr::exists(important_exists);

        m_inner_expr = m_inner_expr
            .map(|x| x.or(important_exists_expr.clone()))
            .or(Some(important_exists_expr.clone()));
    }
    if or_with_coords == &Some(true) {
        let y = message_has_peleng_exists();
        m_inner_expr =
            m_inner_expr.map(|x| x.or(y.clone())).or(Some(y.clone()));
    }
    if or_without_coords == &Some(true) {
        let y = message_has_no_peleng_exists();
        m_inner_expr =
            m_inner_expr.map(|x| x.or(y.clone())).or(Some(y.clone()));
    }
    if or_with_extended_form == &Some(true) {
        let legacy_comment_exists = sigint_comment::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                Expr::col((
                    sigint_comment::Entity,
                    sigint_comment::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(sigint_comment::Column::MigratedSignalMessageId.is_null())
            .filter(sigint_comment::Column::Comment.eq("").not())
            .into_query();
        let linked_message = Alias::new("linked_message");
        let linked_comment_exists = intel_product::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(intel_product::relation_kind_eq(
                intel_product::RELATION_KIND_COMMENT,
            ))
            .join_as(
                JoinType::InnerJoin,
                intel_product::Relation::SignalMessage1.def(),
                linked_message.clone(),
            )
            .filter(
                Expr::col((
                    intel_product::Entity,
                    intel_product::Column::SourceMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(
                Expr::col((
                    linked_message.clone(),
                    signal_message::Column::Deleted,
                ))
                .eq(false),
            )
            .filter(
                Expr::col((linked_message, signal_message::Column::Body))
                    .ne(""),
            )
            .into_query();

        q = q.filter(
            Expr::exists(legacy_comment_exists)
                .or(Expr::exists(linked_comment_exists)),
        );
    }

    if let Some(ref inner_expr) = m_inner_expr {
        q = q.filter(inner_expr.clone());
    }
    if let Some(ref access_expr) = m_access_expr {
        q = q.filter(access_expr.clone());
    }

    if let Some(denied_tags) = denied_tags.as_ref() {
        if !denied_tags.is_empty() {
            let unique_tags: BTreeSet<i64> =
                denied_tags.iter().cloned().collect();
            let without_model_tags = without_model_tags.unwrap_or(false);
            q = q.filter(
                get_related_tag_items_filter(
                    unique_tags,
                    TagFilterOption::OneOfTags,
                    without_model_tags,
                    report_tags_only_this_unit,
                    access,
                    scope,
                )
                .not(),
            );
        }
    }

    if let Some(tag_presence) = tag_presence {
        let exists = tag_presence_exists(
            without_model_tags.unwrap_or(false),
            report_tags_only_this_unit,
            access,
            scope,
        );
        q = match tag_presence {
            TagPresenceFilter::WithTags => q.filter(exists),
            TagPresenceFilter::WithoutTags => q.filter(exists.not()),
        };
    }

    if report_tags_only_this_unit
        && m_inner_expr.is_none()
        && tag_presence.is_none()
    {
        q = q.filter(tag_presence_exists(false, true, access, scope));
    }
    // println!(
    //     "> filter_selected_tags q sql: {}",
    //     q.build(DbBackend::Postgres).to_string()
    // );
    Ok(q)
}

fn selected_tags_accessible_expr(
    unique_tags: BTreeSet<i64>,
    access: TagFilterAccess<'_>,
) -> SimpleExpr {
    let expected_count = unique_tags.len();
    let subquery = tag::Entity::find()
        .filter(
            tag::Column::Id.eq_any(unique_tags.into_iter().collect::<Vec<_>>()),
        )
        .filter(access.owner_condition())
        .select_only()
        .expr(Expr::col((tag::Entity, tag::Column::Id)).count())
        .into_query()
        .into_sub_query_statement();

    SimpleExpr::SubQuery(None, Box::new(subquery)).eq(expected_count as u64)
}

#[derive(Clone, Copy)]
enum TagFilterAccess<'a> {
    Unresolved {
        user_id: &'a uuid::Uuid,
    },
    Resolved {
        user_id: &'a uuid::Uuid,
        accessible_tag_ids: &'a [i64],
        unit_login_ids: &'a [uuid::Uuid],
    },
}

impl<'a> TagFilterAccess<'a> {
    fn user_id(self) -> &'a uuid::Uuid {
        match self {
            Self::Unresolved { user_id } | Self::Resolved { user_id, .. } => {
                user_id
            }
        }
    }

    fn owner_condition(self) -> Condition {
        match self {
            Self::Unresolved { user_id } => {
                accessible_tag_owner_condition(user_id)
            }
            Self::Resolved {
                accessible_tag_ids, ..
            } => accessible_tag_ids_condition(accessible_tag_ids),
        }
    }

    fn unit_login_condition(
        self,
        user_alias: &str,
        log_query: bool,
    ) -> SimpleExpr {
        match self {
            Self::Unresolved { user_id } => {
                let user_alias = Alias::new(user_alias);
                let allowed_logins = Query::select()
                    .column((login::Entity, login::Column::Id))
                    .from(login::Entity)
                    .join_as(
                        JoinType::InnerJoin,
                        login::Entity,
                        user_alias.clone(),
                        Expr::col((login::Entity, login::Column::OrganismId))
                            .equals((
                                user_alias.clone(),
                                login::Column::OrganismId,
                            )),
                    )
                    .and_where(
                        Expr::col((user_alias, login::Column::Id)).eq(*user_id),
                    )
                    .to_owned();
                if log_query {
                    info!(
                        "filtering tags for {user_id}: {}",
                        allowed_logins.to_string(PostgresQueryBuilder)
                    );
                }
                sigint_inbox_item_tag::Column::LoginId
                    .in_subquery(allowed_logins)
            }
            Self::Resolved { unit_login_ids, .. } => {
                if unit_login_ids.is_empty() {
                    Expr::cust("FALSE")
                } else {
                    sigint_inbox_item_tag::Column::LoginId
                        .is_in(unit_login_ids.to_vec())
                }
            }
        }
    }
}

fn build_selected_aor_overlap_exists(
    linked_aor_alias: Alias,
    selected_aors: &[i64],
) -> SelectStatement {
    let selected_aor_alias = Alias::new("selected_aor_filter");
    Query::select()
        .expr(Expr::val(1))
        .from_as(area_of_responsibility::Entity, selected_aor_alias.clone())
        .cond_where(
            Cond::all()
                .add(
                    Expr::col((
                        selected_aor_alias.clone(),
                        area_of_responsibility::Column::Id,
                    ))
                    .is_in(selected_aors.to_vec()),
                )
                .add(aor_bounds_overlap_condition(
                    linked_aor_alias,
                    selected_aor_alias,
                )),
        )
        .to_owned()
}

pub(super) fn aor_bounds_overlap_condition(
    linked_aor_alias: Alias,
    selected_aor_alias: Alias,
) -> Condition {
    Cond::any()
        .add(
            Expr::col((
                linked_aor_alias.clone(),
                area_of_responsibility::Column::LeftBound,
            ))
            .between(
                Expr::col((
                    selected_aor_alias.clone(),
                    area_of_responsibility::Column::LeftBound,
                )),
                Expr::col((
                    selected_aor_alias.clone(),
                    area_of_responsibility::Column::RightBound,
                )),
            ),
        )
        .add(
            Expr::col((
                linked_aor_alias.clone(),
                area_of_responsibility::Column::RightBound,
            ))
            .between(
                Expr::col((
                    selected_aor_alias.clone(),
                    area_of_responsibility::Column::LeftBound,
                )),
                Expr::col((
                    selected_aor_alias.clone(),
                    area_of_responsibility::Column::RightBound,
                )),
            ),
        )
        .add(
            Cond::all()
                .add(
                    Expr::col((
                        linked_aor_alias.clone(),
                        area_of_responsibility::Column::LeftBound,
                    ))
                    .lte(Expr::col((
                        selected_aor_alias.clone(),
                        area_of_responsibility::Column::LeftBound,
                    ))),
                )
                .add(
                    Expr::col((
                        linked_aor_alias,
                        area_of_responsibility::Column::RightBound,
                    ))
                    .gte(Expr::col((
                        selected_aor_alias,
                        area_of_responsibility::Column::RightBound,
                    ))),
                ),
        )
}

pub fn selected_aor_overlap_condition(
    linked_aor_alias: Alias,
    selected_aors: &Option<Vec<i64>>,
) -> Option<Condition> {
    let selected_aors =
        selected_aors.as_ref().filter(|aors| !aors.is_empty())?;
    Some(
        Expr::exists(build_selected_aor_overlap_exists(
            linked_aor_alias,
            selected_aors,
        ))
        .into_condition(),
    )
}

fn build_group_selected_aor_exists(selected_aors: &[i64]) -> SelectStatement {
    let group_aor_alias = Alias::new("group_aor_filter");
    let linked_aor_alias = Alias::new("group_linked_aor_filter");
    let message_group_alias = Alias::new("message_group_aor_filter");
    let overlap_exists = build_selected_aor_overlap_exists(
        linked_aor_alias.clone(),
        selected_aors,
    );

    Query::select()
        .expr(Expr::val(1))
        .from_as(signal_message_group::Entity, message_group_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            signal_group_aor::Entity,
            group_aor_alias.clone(),
            Condition::all().add(
                Expr::col((
                    group_aor_alias.clone(),
                    signal_group_aor::Column::MasterKey,
                ))
                .equals((
                    message_group_alias.clone(),
                    signal_message_group::Column::GroupMasterKey,
                )),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            linked_aor_alias.clone(),
            Expr::col((group_aor_alias, signal_group_aor::Column::AorId))
                .equals((linked_aor_alias, area_of_responsibility::Column::Id)),
        )
        .and_where(
            Expr::col((
                message_group_alias,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .and_where(Expr::exists(overlap_exists))
        .to_owned()
}

fn build_network_selected_aor_exists(selected_aors: &[i64]) -> SelectStatement {
    let inbox_network_alias = Alias::new("inbox_network_aor_filter");
    let network_alias = Alias::new("network_aor_filter");
    let network_aor_alias = Alias::new("network_aor_link_filter");
    let linked_aor_alias = Alias::new("network_linked_aor_filter");
    let overlap_exists = build_selected_aor_overlap_exists(
        linked_aor_alias.clone(),
        selected_aors,
    );

    Query::select()
        .expr(Expr::val(1))
        .from_as(
            sigint_inbox_item_network::Entity,
            inbox_network_alias.clone(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Condition::all().add(
                Expr::col((network_alias.clone(), sigint_network::Column::Id))
                    .equals((
                        inbox_network_alias.clone(),
                        sigint_inbox_item_network::Column::SigintNetworkId,
                    )),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Entity,
            network_aor_alias.clone(),
            Condition::all().add(
                Expr::col((
                    network_aor_alias.clone(),
                    sigint_network_aor::Column::NetworkId,
                ))
                .equals((network_alias.clone(), sigint_network::Column::Id)),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            linked_aor_alias.clone(),
            Expr::col((network_aor_alias, sigint_network_aor::Column::AorId))
                .equals((linked_aor_alias, area_of_responsibility::Column::Id)),
        )
        .and_where(
            Expr::col((
                inbox_network_alias,
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .and_where(
            Expr::col((network_alias, sigint_network::Column::Deleted))
                .eq(false),
        )
        .and_where(Expr::exists(overlap_exists))
        .to_owned()
}

pub fn selected_aor_group_facet_condition(
    selected_aors: &Option<Vec<i64>>,
) -> Option<Condition> {
    let selected_aors =
        selected_aors.as_ref().filter(|aors| !aors.is_empty())?;

    let group_aor_alias = Alias::new("facet_group_aor_filter");
    let linked_aor_alias = Alias::new("facet_group_linked_aor_filter");
    let overlap_exists = build_selected_aor_overlap_exists(
        linked_aor_alias.clone(),
        selected_aors,
    );

    let joined_group_matches = Query::select()
        .expr(Expr::val(1))
        .from_as(signal_group_aor::Entity, group_aor_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            linked_aor_alias.clone(),
            Expr::col((
                group_aor_alias.clone(),
                signal_group_aor::Column::AorId,
            ))
            .equals((linked_aor_alias, area_of_responsibility::Column::Id)),
        )
        .and_where(
            Expr::col((group_aor_alias, signal_group_aor::Column::MasterKey))
                .equals((
                    signal_message_group::Entity,
                    signal_message_group::Column::GroupMasterKey,
                )),
        )
        .and_where(Expr::exists(overlap_exists))
        .to_owned();

    Some(Expr::exists(joined_group_matches).into_condition())
}

pub fn selected_aors_filter_condition(
    selected_aors: &Option<Vec<i64>>,
) -> Option<Condition> {
    let selected_aors =
        selected_aors.as_ref().filter(|aors| !aors.is_empty())?;
    let group_exists = build_group_selected_aor_exists(selected_aors);
    let network_exists = build_network_selected_aor_exists(selected_aors);
    Some(
        Cond::any()
            .add(Expr::exists(group_exists))
            .add(Expr::exists(network_exists)),
    )
}

pub fn filter_selected_aors<Q>(
    q: Q,
    selected_aors: &Option<Vec<i64>>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    if let Some(condition) = selected_aors_filter_condition(selected_aors) {
        return Ok(q.filter(condition));
    }
    Ok(q)
}

pub fn filter_selected_networks<Q>(
    mut q: Q,
    selected_networks: &Option<Vec<i64>>,
    without_network: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QueryTrait,
{
    if let Some(expr) = network_filter_expr(selected_networks, without_network)
    {
        q = q.filter(expr);
    }
    Ok(q)
}

pub(super) fn filter_selected_networks_analytics<E>(
    q: Select<E>,
    selected_networks: &Option<Vec<i64>>,
    without_network: &Option<bool>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    let selected_network_ids =
        selected_networks.as_ref().filter(|ids| !ids.is_empty());
    if without_network.unwrap_or(false) && selected_network_ids.is_some() {
        return Ok(q.filter(Expr::cust("FALSE")));
    }
    if without_network.unwrap_or(false) {
        return Ok(q.filter(without_network_filter_expr_with_scope(scope)));
    }
    if selected_network_ids.is_none() {
        return Ok(q);
    }

    let inbox_network_alias = Alias::new("analytics_network_filter_link");
    let network_alias = Alias::new("analytics_network_filter");
    let q = q
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
            inbox_network_alias.clone(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork
                .def()
                .from_alias(inbox_network_alias.clone()),
            network_alias.clone(),
        )
        .filter(
            Expr::col((
                inbox_network_alias.clone(),
                sigint_inbox_item_network::Column::SigintNetworkId,
            ))
            .is_in(selected_network_ids.cloned().unwrap_or_default()),
        )
        .filter(
            Expr::col((network_alias, sigint_network::Column::Deleted))
                .eq(false),
        );
    Ok(match scope {
        Some(scope) => q.filter(scope.condition((
            inbox_network_alias,
            sigint_inbox_item_network::Column::SigintInboxItemId,
        ))),
        None => q,
    })
}

pub fn filter_selected_networks_stmt(
    mut q: SelectStatement,
    selected_networks: &Option<Vec<i64>>,
    without_network: &Option<bool>,
) -> Result<SelectStatement, AppError> {
    if let Some(expr) = network_filter_expr(selected_networks, without_network)
    {
        q.and_where(expr);
    }
    Ok(q)
}

fn network_filter_expr(
    selected_networks: &Option<Vec<i64>>,
    without_network: &Option<bool>,
) -> Option<SimpleExpr> {
    let without_network = without_network.unwrap_or(false);
    let selected_networks =
        selected_networks.as_ref().filter(|v| !v.is_empty());

    if without_network && selected_networks.is_some() {
        return Some(Expr::cust("FALSE"));
    }

    if without_network {
        return Some(without_network_filter_expr());
    }

    selected_networks.map(|ids| {
        let iin = Alias::new("iin_network_filter");
        let n = Alias::new("n_network_filter");
        let sub = Query::select()
            .expr(Expr::value(1))
            .from_as(sigint_inbox_item_network::Entity, iin.clone())
            .join_as(
                JoinType::InnerJoin,
                sigint_network::Entity,
                n.clone(),
                Condition::all().add(
                    Expr::col((n.clone(), sigint_network::Column::Id)).equals(
                        (
                            iin.clone(),
                            sigint_inbox_item_network::Column::SigintNetworkId,
                        ),
                    ),
                ),
            )
            .and_where(
                Expr::col((
                    iin.clone(),
                    sigint_inbox_item_network::Column::SigintInboxItemId,
                ))
                .equals((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Id,
                )),
            )
            .and_where(
                Expr::col((n.clone(), sigint_network::Column::Id))
                    .is_in(ids.clone()),
            )
            .and_where(
                Expr::col((n.clone(), sigint_network::Column::Deleted))
                    .eq(false),
            )
            .to_owned();

        Expr::exists(sub)
    })
}

fn without_network_filter_expr() -> SimpleExpr {
    without_network_filter_expr_with_scope(None)
}

fn without_network_filter_expr_with_scope(
    scope: Option<&AnalyticsMessageIdScope>,
) -> SimpleExpr {
    Expr::exists(network_exists_subquery(scope)).not().and(
        Expr::col((sigint_inbox_item::Entity, sigint_inbox_item::Column::Freq))
            .is_not_null()
            .and(
                Expr::col((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Freq,
                ))
                .ne(""),
            ),
    )
}

fn network_exists_subquery(
    scope: Option<&AnalyticsMessageIdScope>,
) -> SelectStatement {
    let network_alias = Alias::new("network_filter");
    let network_table_alias = Alias::new("network_filter_table");
    let mut subquery = Query::select();
    subquery
        .expr(Expr::value(1))
        .from_as(sigint_inbox_item_network::Entity, network_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_table_alias.clone(),
            Condition::all().add(
                Expr::col((
                    network_table_alias.clone(),
                    sigint_network::Column::Id,
                ))
                .equals((
                    network_alias.clone(),
                    sigint_inbox_item_network::Column::SigintNetworkId,
                )),
            ),
        )
        .and_where(
            Expr::col((
                network_alias.clone(),
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .and_where(
            Expr::col((network_table_alias, sigint_network::Column::Deleted))
                .eq(false),
        );
    if let Some(scope) = scope {
        subquery.and_where(scope.condition((
            network_alias,
            sigint_inbox_item_network::Column::SigintInboxItemId,
        )));
    }
    subquery.to_owned()
}

fn metadata_text_match_expr<C>(
    column: C,
    value: &str,
    exact: bool,
) -> SimpleExpr
where
    C: IntoColumnRef,
{
    if exact {
        Expr::col(column).eq(value.to_string())
    } else {
        Expr::col(column).like(format!("%{value}%"))
    }
}

fn normalized_metadata_values(
    values: &Option<Vec<String>>,
) -> Option<Vec<String>> {
    values.as_ref().and_then(|values| {
        let values = values
            .iter()
            .filter_map(|value| m_str_trim(&Some(value.clone())))
            .collect_vec();
        if values.is_empty() {
            None
        } else {
            Some(values)
        }
    })
}

fn metadata_text_match_any_expr<C>(
    column: C,
    values: &[String],
    exact: bool,
) -> Option<SimpleExpr>
where
    C: IntoColumnRef + Clone,
{
    values.iter().fold(None, |acc, value| {
        let expr = metadata_text_match_expr(column.clone(), value, exact);
        Some(match acc {
            Some(acc) => acc.or(expr),
            None => expr,
        })
    })
}

fn metadata_sender_match_expr(
    alias: Alias,
    value: &str,
    exact: bool,
) -> SimpleExpr {
    metadata_text_match_expr(
        (alias.clone(), sigint_inbox_item_metadata::Column::SenderId),
        value,
        exact,
    )
    .or(metadata_text_match_expr(
        (alias, sigint_inbox_item_metadata::Column::SenderName),
        value,
        exact,
    ))
}

fn rer_duty_short_state_key(id: &str) -> String {
    format!("{RER_DUTY_SHORT_STATE_REDIS_KEY_PREFIX}{id}")
}

fn rer_duty_short_state_hash_key(hash: &str) -> String {
    format!("{RER_DUTY_SHORT_STATE_REDIS_HASH_KEY_PREFIX}{hash}")
}

async fn rer_duty_short_state_create_or_reuse(
    redis: &mut redis::aio::ConnectionManager,
    state: RerDutyQueryState,
) -> Result<(String, bool), AppError> {
    let payload =
        serde_json::to_string(&RerDutyShortStateGetRsp { state }).c(h!())?;
    let hash = sha256::digest(payload.as_bytes());
    let hash_key = rer_duty_short_state_hash_key(&hash);
    let existing_id: Option<String> = redis.get(&hash_key).await.c(h!())?;
    if let Some(existing_id) = existing_id {
        let key = rer_duty_short_state_key(&existing_id);
        let raw: Option<String> = redis.get(&key).await.c(h!())?;
        if let Some(raw) = raw {
            if raw == payload {
                let _: () = redis
                    .expire(&key, RER_DUTY_SHORT_STATE_TTL_SEC as i64)
                    .await
                    .c(h!())?;
                let _: () = redis
                    .expire(&hash_key, RER_DUTY_SHORT_STATE_TTL_SEC as i64)
                    .await
                    .c(h!())?;
                return Ok((existing_id, true));
            }
        }
    }
    let id = Uuid::now_v7().to_string();
    let key = rer_duty_short_state_key(&id);
    let _: () = redis
        .set_ex(&key, payload, RER_DUTY_SHORT_STATE_TTL_SEC)
        .await
        .c(h!())?;
    let _: () = redis
        .set_ex(&hash_key, id.clone(), RER_DUTY_SHORT_STATE_TTL_SEC)
        .await
        .c(h!())?;
    Ok((id, false))
}

async fn rer_duty_short_state_get_and_refresh(
    redis: &mut redis::aio::ConnectionManager,
    id: &str,
) -> Result<RerDutyShortStateGetRsp, AppError> {
    let key = rer_duty_short_state_key(id);
    let raw: Option<String> = redis.get(&key).await.c(h!())?;
    let Some(raw) = raw else {
        return Err(AppError::NotFound);
    };
    let payload: RerDutyShortStateGetRsp =
        serde_json::from_str(&raw).c(h!())?;
    let _: () = redis
        .expire(&key, RER_DUTY_SHORT_STATE_TTL_SEC as i64)
        .await
        .c(h!())?;
    Ok(payload)
}

#[post("/api/rer-duty/filters/create")]
pub async fn rer_duty_filters_create(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerDutyShortStateCreateReq>,
) -> Result<Json<RerDutyShortStateCreateRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let mut redis = env.redis.clone();
    let (id, reused) =
        rer_duty_short_state_create_or_reuse(&mut redis, req.state.clone())
            .await?;
    if reused {
        info!("rer duty short-state reused id={id} login={login}");
    } else {
        info!("rer duty short-state created id={id} login={login}");
    }
    Ok(Json(RerDutyShortStateCreateRsp { id }))
}

#[post("/api/rer-duty/filters/get")]
pub async fn rer_duty_filters_get(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerDutyShortStateGetReq>,
) -> Result<Json<RerDutyShortStateGetRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();
    let mut redis = env.redis.clone();
    let payload =
        match rer_duty_short_state_get_and_refresh(&mut redis, &req.id).await {
            Ok(payload) => payload,
            Err(AppError::NotFound) => {
                warn!(
                    "rer duty short-state missing id={} login={login}",
                    req.id
                );
                return Err(AppError::NotFound);
            }
            Err(err) => return Err(err),
        };
    info!("rer duty short-state loaded id={} login={login}", req.id);
    Ok(Json(payload))
}

fn metadata_receiver_match_expr(
    alias: Alias,
    value: &str,
    exact: bool,
) -> SimpleExpr {
    metadata_text_match_expr(
        (
            alias.clone(),
            sigint_inbox_item_metadata::Column::CallGroupId,
        ),
        value,
        exact,
    )
    .or(metadata_text_match_expr(
        (alias, sigint_inbox_item_metadata::Column::CallGroupName),
        value,
        exact,
    ))
}

fn metadata_sender_match_any_expr(
    alias: Alias,
    values: &[String],
    exact: bool,
) -> Option<SimpleExpr> {
    values.iter().fold(None, |acc, value| {
        let expr = metadata_sender_match_expr(alias.clone(), value, exact);
        Some(match acc {
            Some(acc) => acc.or(expr),
            None => expr,
        })
    })
}

fn metadata_receiver_match_any_expr(
    alias: Alias,
    values: &[String],
    exact: bool,
) -> Option<SimpleExpr> {
    values.iter().fold(None, |acc, value| {
        let expr = metadata_receiver_match_expr(alias.clone(), value, exact);
        Some(match acc {
            Some(acc) => acc.or(expr),
            None => expr,
        })
    })
}

fn metadata_exists_subquery() -> SelectStatement {
    let metadata_alias = Alias::new("metadata_filter");
    let mut subquery = Query::select();
    subquery
        .expr(Expr::value(1))
        .from_as(sigint_inbox_item_metadata::Entity, metadata_alias.clone())
        .and_where(
            Expr::col((
                metadata_alias,
                sigint_inbox_item_metadata::Column::SigintInboxItemId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        );
    subquery.to_owned()
}

pub fn filter_selected_metadata<Q>(
    q: Q,
    metadata_cc: &Option<Vec<String>>,
    metadata_sender: &Option<Vec<String>>,
    metadata_receiver: &Option<Vec<String>>,
    metadata_hash: &Option<Vec<String>>,
    only_with_metadata: &Option<bool>,
    without_metadata: &Option<bool>,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let only_with_metadata = only_with_metadata.unwrap_or(false);
    let without_metadata = without_metadata.unwrap_or(false);
    let metadata_cc = normalized_metadata_values(metadata_cc);
    let metadata_sender = normalized_metadata_values(metadata_sender);
    let metadata_receiver = normalized_metadata_values(metadata_receiver);
    let metadata_hash = normalized_metadata_values(metadata_hash);

    if without_metadata && only_with_metadata {
        return Ok(q.filter(Expr::cust("FALSE")));
    }

    if without_metadata {
        let metadata_exists = Expr::exists(metadata_exists_subquery());
        return Ok(q.filter(metadata_exists.not()));
    }

    if !without_metadata
        && !only_with_metadata
        && metadata_cc.is_none()
        && metadata_sender.is_none()
        && metadata_receiver.is_none()
        && metadata_hash.is_none()
    {
        return Ok(q);
    }

    let metadata_alias = Alias::new("metadata_filter");
    let mut subquery = metadata_exists_subquery();

    if let Some(metadata_cc) = metadata_cc.as_ref() {
        if let Some(expr) = metadata_text_match_any_expr(
            (
                metadata_alias.clone(),
                sigint_inbox_item_metadata::Column::ColorCode,
            ),
            metadata_cc,
            true,
        ) {
            subquery.and_where(expr);
        }
    }

    if let Some(metadata_sender) = metadata_sender.as_ref() {
        if let Some(expr) = metadata_sender_match_any_expr(
            metadata_alias.clone(),
            metadata_sender,
            true,
        ) {
            subquery.and_where(expr);
        }
    }

    if let Some(metadata_receiver) = metadata_receiver.as_ref() {
        if let Some(expr) = metadata_receiver_match_any_expr(
            metadata_alias.clone(),
            metadata_receiver,
            true,
        ) {
            subquery.and_where(expr);
        }
    }

    if let Some(metadata_hash) = metadata_hash.as_ref() {
        if let Some(expr) = metadata_text_match_any_expr(
            (
                metadata_alias.clone(),
                sigint_inbox_item_metadata::Column::HashId,
            ),
            metadata_hash,
            true,
        ) {
            subquery.and_where(expr);
        }
    }

    let metadata_exists = Expr::exists(subquery.to_owned());

    Ok(q.filter(metadata_exists))
}

pub fn filter_selected_metadata_for_analysis_stats<Q>(
    q: Q,
    req: &AnalysisStatsReq,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_selected_metadata(
        q,
        &req.metadata_cc,
        &req.metadata_sender,
        &req.metadata_receiver,
        &req.metadata_hash,
        &req.only_with_metadata,
        &req.without_metadata,
    )
}

pub fn filter_selected_metadata_for_inbox_messages<Q>(
    q: Q,
    req: &InboxMessagesReq,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_selected_metadata(
        q,
        &req.metadata_cc,
        &req.metadata_sender,
        &req.metadata_receiver,
        &req.metadata_hash,
        &req.only_with_metadata,
        &req.without_metadata,
    )
}

pub fn filter_selected_metadata_for_callsigns_graph<Q>(
    q: Q,
    req: &CallsignsGraphReq,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    filter_selected_metadata(
        q,
        &req.metadata_cc,
        &req.metadata_sender,
        &req.metadata_receiver,
        &req.metadata_hash,
        &req.only_with_metadata,
        &req.without_metadata,
    )
}

pub fn filter_search<Q>(q: Q, search: &Option<String>) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect,
{
    let mut q2 = q;
    if let Some(ref search) = m_str_trim(search) {
        let search_parts = search::parse_search_parts(search).context(h!())?;
        if !search_parts.ts_query.is_empty() {
            let search_tsv = Expr::cust("sigint_search.search_tsv");
            let search_filter =
                sea_orm::sea_query::extension::postgres::PgExpr::matches(
                    search_tsv.clone(),
                    Expr::cust_with_values(
                        "websearch_to_tsquery('russian', $1)",
                        vec![search_parts.ts_query.clone()],
                    ),
                );
            let search_filter = match search::ts_prefix_query(
                &search_parts.ts_query,
            ) {
                Some(ts_prefix_query) => search_filter.or(
                    sea_orm::sea_query::extension::postgres::PgExpr::matches(
                        search_tsv,
                        Expr::cust_with_values(
                            "to_tsquery('russian', $1)",
                            vec![ts_prefix_query],
                        ),
                    ),
                ),
                None => search_filter,
            };
            q2 = q2
                .join(
                    JoinType::InnerJoin,
                    sigint_inbox_item::Relation::SigintSearch.def(),
                )
                .filter(search_filter);
        }
        for ilike in search_parts.ilike {
            q2 = q2.filter(body_noheader_body_ilike(ilike));
        }
        for not_ilike in search_parts.not_ilike {
            q2 = q2.filter(body_noheader_body_not_ilike(not_ilike));
        }

        if !search_parts.freq.is_empty() {
            q2 = filter_selected_freqs(q2, &Some(search_parts.freq))?;
        }

        if !search_parts.not_freq.is_empty() {
            q2 = filter_denied_freqs(q2, &Some(search_parts.not_freq))?;
        }

        if !search_parts.message_uids.is_empty() {
            q2 = q2.filter(
                signal_message::Column::MessageUid
                    .eq_any(search_parts.message_uids),
            )
        }

        return Ok(q2);
    }
    Ok(q2)
}

fn body_noheader_body_ilike(pattern: String) -> SimpleExpr {
    Expr::cust_with_values(
        "coalesce(jsonb_extract_path_text(sigint_inbox_item.body_noheader, 'body'), '') ILIKE $1 ESCAPE '\\'",
        vec![pattern],
    )
}

fn body_noheader_body_not_ilike(pattern: String) -> SimpleExpr {
    Expr::cust_with_values(
        "coalesce(jsonb_extract_path_text(sigint_inbox_item.body_noheader, 'body'), '') NOT ILIKE $1 ESCAPE '\\'",
        vec![pattern],
    )
}

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/summary-table-freq")]
pub async fn summary_table_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<SummaryTableFreq>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    Ok(Json(summary_table_freq_1(&user, &env, &req).await.c(h!())?))
}

pub async fn summary_table_freq_1(
    user: &Identity,
    env: &Env,
    req: &AnalysisStatsReq,
) -> Result<SummaryTableFreq, AppError> {
    let master_keys =
        get_identity_sigint_groups_noimport(&env.dbx, user, &env.config)
            .await
            .c(h!())?;
    let login = login_id_from_identity(user)?;
    summary_table_freq_by_login(&login, env, req, &master_keys).await
}

#[derive(Default)]
struct SummaryTableCoordinateData {
    coords: Vec<LatLng>,
    locality_coords: Vec<LocalityCoords>,
}

#[derive(FromQueryResult)]
struct SummaryTableCoordinateRow {
    freq: Option<String>,
    lat: f64,
    lng: f64,
    nominatimres_id: Option<i64>,
    count: i64,
}

async fn summary_table_freq_by_login(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<SummaryTableFreq, AppError> {
    summary_table_freq_by_login_with_coordinate_loading(
        login,
        env,
        req,
        master_keys,
        true,
    )
    .await
}

async fn summary_table_freq_without_coordinates_by_login(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<SummaryTableFreq, AppError> {
    summary_table_freq_by_login_with_coordinate_loading(
        login,
        env,
        req,
        master_keys,
        false,
    )
    .await
}

async fn summary_table_freq_by_login_with_coordinate_loading(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
    load_coordinates: bool,
) -> Result<SummaryTableFreq, AppError> {
    let analytics_supported = analytics_summary_table_request_supported(req);
    let analytics_tag_access = if env.analytics.is_some() && analytics_supported
    {
        Some(
            stats::resolve_analytics_tag_access(
                &env.dbx,
                login,
                req.report_tags_only_this_unit.unwrap_or(false),
            )
            .await?,
        )
    } else {
        None
    };
    with_analytics_read_fallback(
        env,
        "analysis summary table freq",
        analytics_supported,
        |db| async move {
            query_summary_table_freq_analytics(
                login,
                env,
                req,
                master_keys,
                &db,
                analytics_tag_access.as_ref().c(h!())?,
                load_coordinates,
            )
            .await
        },
        |db| async move {
            let rows = query_summary_table_freq_rows(
                login,
                req,
                master_keys,
                &db,
                None,
            )
            .await?;
            let coordinate_data = if load_coordinates {
                summary_table_coordinate_data_by_freq(
                    login,
                    env,
                    req,
                    master_keys,
                )
                .await?
            } else {
                BTreeMap::new()
            };
            build_summary_table_freq(rows, coordinate_data)
        },
    )
    .await
}

#[derive(FromQueryResult)]
struct SummaryTableFreqQueryRow {
    freq: Option<String>,
    count: i64,
    callsigns: Vec<String>,
    units: Vec<String>,
    locations: Vec<String>,
}

#[derive(FromQueryResult)]
struct SummaryTableFreqDbRow {
    freq: Option<String>,
    count: i64,
    inbox_item_ids: Vec<i64>,
    units: Vec<String>,
    locations: Vec<String>,
}

#[derive(FromQueryResult)]
struct SummaryTableFreqCountRow {
    freq: Option<String>,
    count: i64,
}

#[derive(FromQueryResult)]
struct SummaryTableFreqValueRow {
    freq: Option<String>,
    value: Option<String>,
}

async fn query_summary_table_freq_analytics(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
    db: &DatabaseConnection,
    tag_access: &stats::AnalyticsTagAccess,
    load_coordinates: bool,
) -> Result<SummaryTableFreq, AppError> {
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let (scope, resolved_units) = tokio::try_join!(
        stats::resolve_analytics_message_id_scope(
            req,
            db,
            freshness_max_age_ms,
        ),
        analytics_unit::resolve_analytics_unit_filters(
            &env.dbx,
            &req.selected_units,
            &None,
            req.units_exact_match_only,
        ),
    )
    .context(h!())?;
    if scope.is_empty() {
        return Ok(SummaryTableFreq { rows: Vec::new() });
    }
    let mut analytics_req = req.clone();
    analytics_req.selected_units = None;
    let filtered_messages =
        build_summary_table_filtered_messages_query_with_access(
            login,
            &analytics_req,
            master_keys,
            Some(tag_access),
            Some(&scope),
        )
        .context(h!())?;
    let filtered_messages =
        analytics_unit::apply_resolved_analytics_unit_filters(
            filtered_messages,
            &resolved_units,
            &scope,
            req.units_exact_match_only.unwrap_or(false),
        );
    let counts = filtered_messages
        .clone()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column_as(
            Expr::cust_with_expr(
                "COUNT(DISTINCT $1)",
                Expr::col((signal_message::Entity, signal_message::Column::Id)),
            ),
            "count",
        )
        .group_by(sigint_inbox_item::Column::Freq)
        .into_model::<SummaryTableFreqCountRow>()
        .all(db);
    let units = summary_table_freq_distinct_values_query(
        filtered_messages.clone(),
        sigint_inbox_item::Column::UnitV2,
    )
    .into_model::<SummaryTableFreqValueRow>()
    .all(db);
    let locations = summary_table_freq_distinct_values_query(
        filtered_messages.clone(),
        sigint_inbox_item::Column::LocationV2,
    )
    .into_model::<SummaryTableFreqValueRow>()
    .all(db);
    let callsigns = summary_table_freq_callsigns_query(
        filtered_messages.clone(),
        Some(&scope),
    )
    .into_model::<SummaryTableFreqValueRow>()
    .all(db);
    let coordinate_rows = async {
        if load_coordinates {
            summary_table_freq_coordinate_query(filtered_messages)
                .into_model::<SummaryTableCoordinateRow>()
                .all(db)
                .await
        } else {
            Ok(vec![])
        }
    };
    let (counts, units, locations, callsigns, coordinate_rows) =
        tokio::try_join!(counts, units, locations, callsigns, coordinate_rows)
            .c(h!())?;
    let nominatimres_by_id =
        load_summary_table_nominatimres(&env.dbx, &coordinate_rows).await?;
    let coordinate_data = collect_summary_table_coordinate_data(
        coordinate_rows,
        &nominatimres_by_id,
    );

    Ok(build_summary_table_freq_from_analytics_rows(
        counts,
        units,
        locations,
        callsigns,
        coordinate_data,
    ))
}

fn summary_table_freq_distinct_values_query(
    filtered_messages: Select<signal_message::Entity>,
    column: sigint_inbox_item::Column,
) -> Select<signal_message::Entity> {
    filtered_messages
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column_as(column, "value")
        .distinct()
}

fn summary_table_freq_callsigns_query(
    mut filtered_messages: Select<signal_message::Entity>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Select<signal_message::Entity> {
    let callsign_alias = Alias::new("summary_table_callsign");
    let mut join_condition = Condition::all().add(
        Expr::col((callsign_alias.clone(), Alias::new("sigint_inbox_item_id")))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
    );
    if let Some(scope) = scope {
        join_condition = join_condition.add(scope.condition((
            callsign_alias.clone(),
            Alias::new("sigint_inbox_item_id"),
        )));
    }
    QuerySelect::query(&mut filtered_messages).join_as(
        JoinType::InnerJoin,
        (
            Alias::new("echo_clickhouse_derived"),
            Alias::new("message_callsign"),
        ),
        callsign_alias.clone(),
        join_condition,
    );
    filtered_messages
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column_as(Expr::col((callsign_alias, Alias::new("callsign"))), "value")
        .distinct()
}

fn summary_table_freq_coordinate_query(
    filtered_messages: Select<signal_message::Entity>,
) -> Select<signal_message::Entity> {
    filtered_messages
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Lat)
        .column(sigint_inbox_item::Column::Lng)
        .column(sigint_inbox_item::Column::NominatimresId)
        .column_as(
            Expr::cust_with_expr(
                "COUNT(DISTINCT $1)",
                Expr::col((signal_message::Entity, signal_message::Column::Id)),
            ),
            "count",
        )
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .filter(sigint_inbox_item::Column::Lng.is_not_null())
        .group_by(sigint_inbox_item::Column::Freq)
        .group_by(sigint_inbox_item::Column::Lat)
        .group_by(sigint_inbox_item::Column::Lng)
        .group_by(sigint_inbox_item::Column::NominatimresId)
}

fn build_summary_table_freq_from_analytics_rows(
    counts: Vec<SummaryTableFreqCountRow>,
    units: Vec<SummaryTableFreqValueRow>,
    locations: Vec<SummaryTableFreqValueRow>,
    callsigns: Vec<SummaryTableFreqValueRow>,
    mut coordinate_data: BTreeMap<String, SummaryTableCoordinateData>,
) -> SummaryTableFreq {
    let mut rows = counts
        .into_iter()
        .filter_map(|row| {
            row.freq.map(|freq| {
                let coordinate_data =
                    coordinate_data.remove(&freq).unwrap_or_default();
                (
                    freq.clone(),
                    SummaryTableFreqRow {
                        freq,
                        count: row.count,
                        callsigns: vec![],
                        units: vec![],
                        locations: vec![],
                        coords: coordinate_data.coords,
                        locality_coords: coordinate_data.locality_coords,
                    },
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    append_summary_table_freq_values(&mut rows, units, |row| &mut row.units);
    append_summary_table_freq_locations(&mut rows, locations);
    append_summary_table_freq_values(&mut rows, callsigns, |row| {
        &mut row.callsigns
    });
    SummaryTableFreq {
        rows: rows.into_values().collect(),
    }
}

fn append_summary_table_freq_values(
    rows: &mut BTreeMap<String, SummaryTableFreqRow>,
    values: Vec<SummaryTableFreqValueRow>,
    field: impl Fn(&mut SummaryTableFreqRow) -> &mut Vec<String>,
) {
    for value in values {
        let (Some(freq), Some(value)) = (value.freq, value.value) else {
            continue;
        };
        if value.trim().is_empty() {
            continue;
        }
        if let Some(row) = rows.get_mut(&freq) {
            let values = field(row);
            if !values.iter().any(|existing| existing == &value) {
                values.push(value);
            }
        }
    }
}

fn append_summary_table_freq_locations(
    rows: &mut BTreeMap<String, SummaryTableFreqRow>,
    locations: Vec<SummaryTableFreqValueRow>,
) {
    for location in locations {
        let (Some(freq), Some(location)) = (location.freq, location.value)
        else {
            continue;
        };
        let Some(row) = rows.get_mut(&freq) else {
            continue;
        };
        for location in to_location_list(&location) {
            if !location.trim().is_empty()
                && !row.locations.iter().any(|existing| existing == &location)
            {
                row.locations.push(location);
            }
        }
    }
}

async fn query_summary_table_freq_rows(
    login: &uuid::Uuid,
    req: &AnalysisStatsReq,
    master_keys: &[String],
    db: &DatabaseConnection,
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
) -> Result<Vec<SummaryTableFreqQueryRow>, AppError> {
    let dedup_key_alias = Alias::new("dedup_key");
    let dedup_subquery =
        build_summary_table_filtered_messages_query_with_access(
            login,
            req,
            master_keys,
            analytics_tag_access,
            None,
        )?
        .select_only()
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .column_as(
            Expr::col((signal_message::Entity, signal_message::Column::Id)),
            "inbox_item_id",
        )
        .column_as(Expr::col(sigint_inbox_item::Column::UnitV2), "unit_v2")
        .column_as(
            Expr::col(sigint_inbox_item::Column::LocationV2),
            "location_v2",
        )
        .column_as(
            Expr::col((signal_message::Entity, signal_message::Column::Id)),
            "dedup_key",
        )
        .distinct_on([dedup_key_alias.clone()])
        .order_by(Expr::cust("dedup_key"), Order::Asc)
        // emulate NULLS FIRST: order nulls before non-nulls
        .order_by(sigint_inbox_item::Column::Datetime, Order::Asc);
    // println!(
    //     "> summary table dedup_subquery sql: {}",
    //     dedup_subquery.build(DbBackend::Postgres).to_string()
    // );

    let uniq_alias = Alias::new("uniq");

    let main_query: SelectStatement = Query::select()
        .column((uniq_alias.clone(), "freq"))
        .expr_as(
            Expr::cust("array_agg(distinct uniq.inbox_item_id)"),
            "inbox_item_ids",
        )
        .expr_as(
            Expr::cust("array_agg(distinct coalesce(uniq.unit_v2, ''))"),
            "units",
        )
        .expr_as(
            Expr::cust("array_agg(distinct coalesce(uniq.location_v2, ''))"),
            "locations",
        )
        .expr_as(Expr::cust("count(1)"), "count")
        .from_subquery(dedup_subquery.into_query(), uniq_alias.clone())
        .add_group_by([Expr::cust("1")])
        .to_owned();

    let sql = main_query.to_string(PostgresQueryBuilder);
    // println!("> summary table main_query sql: {}", sql);

    let main_query_res = db
        .query_all_raw(Statement::from_string(DbBackend::Postgres, sql))
        .await
        .c(h!())?;

    let rows = main_query_res
        .into_iter()
        .map(|qr| SummaryTableFreqDbRow::from_query_result(&qr, ""))
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .c(h!())?;
    let inbox_item_ids = rows
        .iter()
        .flat_map(|row| row.inbox_item_ids.iter().copied())
        .collect_vec();
    let callsigns_by_item_id =
        crate::inbox::callsigns::load_by_item_ids(db, &inbox_item_ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| SummaryTableFreqQueryRow {
            freq: row.freq,
            count: row.count,
            callsigns: row
                .inbox_item_ids
                .iter()
                .filter_map(|inbox_item_id| {
                    callsigns_by_item_id.get(inbox_item_id)
                })
                .flat_map(|callsigns| callsigns.effective())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            units: row.units,
            locations: row.locations,
        })
        .collect())
}

fn build_summary_table_freq(
    rows_res: Vec<SummaryTableFreqQueryRow>,
    mut coordinate_data: BTreeMap<String, SummaryTableCoordinateData>,
) -> Result<SummaryTableFreq, AppError> {
    let mut callsigns_per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut units_per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut locations_per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut count_per_freq: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows_res.iter() {
        let Some(freq) = row.freq.clone() else {
            continue;
        };
        count_per_freq
            .entry(freq.clone())
            .and_modify(|c| *c += row.count)
            .or_insert(row.count);
        units_per_freq
            .entry(freq.clone())
            .and_modify(|xs| {
                for unit in row.units.iter() {
                    if !xs.iter().any(|existing| existing == unit)
                        && !unit.trim().is_empty()
                    {
                        xs.push(unit.clone())
                    }
                }
            })
            .or_insert(
                row.units
                    .iter()
                    .filter(|x| !x.trim().is_empty())
                    .cloned()
                    .collect(),
            );

        let locations = row
            .locations
            .iter()
            .flat_map(|r| to_location_list(r).into_iter())
            .collect_vec();
        locations_per_freq
            .entry(freq.clone())
            .and_modify(|xs| {
                for location in locations.iter() {
                    if !xs.iter().any(|existing| existing == location)
                        && !location.trim().is_empty()
                    {
                        xs.push(location.clone())
                    }
                }
            })
            .or_insert(
                locations
                    .iter()
                    .filter(|x| !x.trim().is_empty())
                    .cloned()
                    .collect(),
            );

        for callsign in &row.callsigns {
            callsigns_per_freq
                .entry(freq.clone())
                .and_modify(|xs| {
                    if !xs.iter().any(|existing| existing == callsign) {
                        xs.push(callsign.clone())
                    }
                })
                .or_insert(vec![callsign.clone()]);
        }
    }

    let mut rows = vec![];
    for (freq, count) in count_per_freq.iter() {
        let coordinate_data = coordinate_data.remove(freq).unwrap_or_default();
        rows.push(SummaryTableFreqRow {
            freq: freq.clone(),
            count: *count,
            callsigns: callsigns_per_freq.get(freq).unwrap_or(&vec![]).clone(),
            units: units_per_freq.get(freq).unwrap_or(&vec![]).clone(),
            locations: locations_per_freq.get(freq).unwrap_or(&vec![]).clone(),
            coords: coordinate_data.coords,
            locality_coords: coordinate_data.locality_coords,
        });
    }

    Ok(SummaryTableFreq { rows })
}

async fn summary_table_coordinate_data_by_freq(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<BTreeMap<String, SummaryTableCoordinateData>, AppError> {
    let rows = load_summary_table_coordinate_rows(login, env, req, master_keys)
        .await?;
    let nominatimres_by_id =
        load_summary_table_nominatimres(&env.dbx, &rows).await?;
    Ok(collect_summary_table_coordinate_data(
        rows,
        &nominatimres_by_id,
    ))
}

async fn load_summary_table_coordinate_rows(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<Vec<SummaryTableCoordinateRow>, AppError> {
    let dedup_key_alias = Alias::new("dedup_key");
    let dedup_subquery =
        build_summary_table_filtered_messages_query(login, req, master_keys)?
            .select_only()
            .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
            .column_as(Expr::col(sigint_inbox_item::Column::Lat), "lat")
            .column_as(Expr::col(sigint_inbox_item::Column::Lng), "lng")
            .column_as(
                Expr::col(sigint_inbox_item::Column::NominatimresId),
                "nominatimres_id",
            )
            .column_as(
                Expr::col((signal_message::Entity, signal_message::Column::Id)),
                "dedup_key",
            )
            .distinct_on([dedup_key_alias.clone()])
            .order_by(Expr::cust("dedup_key"), Order::Asc)
            .order_by(sigint_inbox_item::Column::Datetime, Order::Asc);
    let uniq_alias = Alias::new("uniq");
    let query = Query::select()
        .column((uniq_alias.clone(), "freq"))
        .column((uniq_alias.clone(), "lat"))
        .column((uniq_alias.clone(), "lng"))
        .column((uniq_alias.clone(), "nominatimres_id"))
        .expr_as(Expr::cust("count(1)"), "count")
        .from_subquery(dedup_subquery.into_query(), uniq_alias.clone())
        .and_where(Expr::col((uniq_alias.clone(), "lat")).is_not_null())
        .and_where(Expr::col((uniq_alias.clone(), "lng")).is_not_null())
        .add_group_by([Expr::cust("1, 2, 3, 4")])
        .to_owned();
    Ok(
        SummaryTableCoordinateRow::find_by_statement(Statement::from_string(
            DbBackend::Postgres,
            query.to_string(PostgresQueryBuilder),
        ))
        .all(&env.dbx)
        .await
        .c(h!())?,
    )
}

async fn load_summary_table_nominatimres(
    dbx: &DatabaseConnection,
    rows: &[SummaryTableCoordinateRow],
) -> Result<BTreeMap<i64, nominatimres::Model>, AppError> {
    Ok(nominatimres::Entity::find()
        .filter(
            nominatimres::Column::Id.is_in(
                rows.iter()
                    .filter_map(|row| row.nominatimres_id)
                    .collect::<BTreeSet<_>>(),
            ),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|nominatimres| (nominatimres.id, nominatimres))
        .collect())
}

fn collect_summary_table_coordinate_data(
    rows: Vec<SummaryTableCoordinateRow>,
    nominatimres_by_id: &BTreeMap<i64, nominatimres::Model>,
) -> BTreeMap<String, SummaryTableCoordinateData> {
    let mut result = BTreeMap::new();
    for row in rows {
        let Some(freq) = row.freq else {
            continue;
        };
        let coord = LatLng {
            lat: row.lat,
            lng: row.lng,
        };
        let data = result
            .entry(freq)
            .or_insert_with(SummaryTableCoordinateData::default);
        push_unique_coord(&mut data.coords, coord.clone());
        let locality = row
            .nominatimres_id
            .and_then(|id| nominatimres_by_id.get(&id))
            .map(|nominatimres| nominatimres.nominatim_display_name.clone())
            .unwrap_or_else(|| RER_SUMMARY_TABLE_UNKNOWN_LOCALITY.to_string());
        match data
            .locality_coords
            .iter_mut()
            .find(|item| item.locality == locality)
        {
            Some(item) => {
                item.count += row.count;
                push_unique_coord(&mut item.coords, coord);
            }
            None => data.locality_coords.push(LocalityCoords {
                locality,
                count: row.count,
                coords: vec![coord],
            }),
        }
    }
    for data in result.values_mut() {
        normalize_summary_table_coordinate_data(data);
    }
    result
}

fn push_unique_coord(coords: &mut Vec<LatLng>, coord: LatLng) {
    if !coords.iter().any(|existing| existing == &coord) {
        coords.push(coord);
    }
}

fn normalize_summary_table_coordinate_data(
    data: &mut SummaryTableCoordinateData,
) {
    sort_and_dedup_coords(&mut data.coords);
    data.coords.truncate(COORDS_PER_FREQ_LIMIT);
    data.locality_coords
        .sort_by(|left, right| left.locality.cmp(&right.locality));
    for locality in &mut data.locality_coords {
        sort_and_dedup_coords(&mut locality.coords);
        locality.coords.truncate(COORDS_PER_FREQ_LIMIT);
    }
    data.locality_coords.truncate(COORDS_PER_FREQ_PER_LOC_LIMIT);
}

fn sort_and_dedup_coords(coords: &mut Vec<LatLng>) {
    coords.sort_by(|left, right| {
        left.lat
            .total_cmp(&right.lat)
            .then_with(|| left.lng.total_cmp(&right.lng))
    });
    coords.dedup();
}

pub(crate) fn build_summary_table_filtered_messages_query(
    login: &uuid::Uuid,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<Select<signal_message::Entity>, AppError> {
    build_summary_table_filtered_messages_query_with_access(
        login,
        req,
        master_keys,
        None,
        None,
    )
}

fn build_summary_table_filtered_messages_query_with_access(
    login: &uuid::Uuid,
    req: &AnalysisStatsReq,
    master_keys: &[String],
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<signal_message::Entity>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    let q = build_summary_table_base_query(dt_since, dt_till, scope);
    let q = stats::apply_message_access_filter(
        q,
        &req.selected_groups,
        &req.selected_senders,
        master_keys,
        scope,
    )
    .context(h!())?;
    let q = filter_selected_freqs(q, &req.selected_freqs).context(h!())?;
    let q = filter_selected_posts(q, &req.selected_posts).context(h!())?;
    let q = crate::rer_importer::analysis::analytics_unit::apply_analysis_unit_filters(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
        dt_since,
        dt_till,
        scope,
        None,
    )
    .context(h!())?;
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let q = filter_summary_table_callsigns_for_scope(q, req, scope)
        .context(h!())?;
    let q = filter_summary_table_tags_for_access(
        q,
        req,
        login,
        analytics_tag_access,
        scope,
    )
    .context(h!())?;
    let q = filter_summary_table_aors_and_networks_for_scope(q, req, scope)
        .context(h!())?;
    let q =
        filter_selected_metadata_for_analysis_stats(q, req).context(h!())?;
    let q = filter_search(q, &req.search).context(h!())?;
    Ok(filter_selected_device_names(q, &req.selected_device_names)
        .context(h!())?)
}

fn build_summary_table_base_query(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Select<signal_message::Entity> {
    let query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    match scope {
        Some(scope) => query
            .filter(scope.condition((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )))
            .filter(scope.condition((
                signal_message::Entity,
                signal_message::Column::Id,
            ))),
        None => query,
    }
}

fn filter_summary_table_callsigns_for_scope(
    query: Select<signal_message::Entity>,
    req: &AnalysisStatsReq,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<signal_message::Entity>, AppError> {
    match scope {
        Some(_) => filter_selected_callsigns_for_source(
            query,
            &req.selected_callsigns,
            crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics,
            scope,
        ),
        None => filter_selected_callsigns(query, &req.selected_callsigns),
    }
}

fn filter_summary_table_tags_for_access(
    query: Select<signal_message::Entity>,
    req: &AnalysisStatsReq,
    login: &uuid::Uuid,
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<signal_message::Entity>, AppError> {
    if let Some(tag_access) = analytics_tag_access {
        filter_selected_tags_analytics(
            query,
            &req.selected_tags,
            &req.denied_tags,
            &req.tag_presence,
            &req.or_bookmarked,
            &req.or_important,
            &req.or_with_coords,
            &req.or_without_coords,
            &req.or_with_extended_form,
            &req.filter_tags_option,
            &req.without_model_tags,
            login,
            req.report_tags_only_this_unit.unwrap_or(false),
            &tag_access.accessible_tag_ids,
            &tag_access.unit_login_ids,
            scope,
        )
    } else {
        filter_selected_tags(
            query,
            &req.selected_tags,
            &req.denied_tags,
            &req.tag_presence,
            &req.or_bookmarked,
            &req.or_important,
            &req.or_with_coords,
            &req.or_without_coords,
            &req.or_with_extended_form,
            &req.filter_tags_option,
            &req.without_model_tags,
            login,
            req.report_tags_only_this_unit.unwrap_or(false),
        )
    }
}

fn filter_summary_table_aors_and_networks_for_scope(
    query: Select<signal_message::Entity>,
    req: &AnalysisStatsReq,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<signal_message::Entity>, AppError> {
    let query =
        stats::filter_selected_aors_for_scope(query, &req.selected_aors, scope)
            .context(h!())?;
    match scope {
        Some(_) => filter_selected_networks_analytics(
            query,
            &req.selected_networks,
            &req.without_network,
            scope,
        ),
        None => filter_selected_networks(
            query,
            &req.selected_networks,
            &req.without_network,
        ),
    }
}

async fn summary_table_last_datetime_by_freq_by_login(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<BTreeMap<String, NaiveDateTime>, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        freq: Option<String>,
        last_datetime: Option<NaiveDateTime>,
    }

    let rows =
        build_summary_table_filtered_messages_query(login, req, master_keys)?
            .select_only()
            .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
            .expr_as(
                Expr::cust("MAX(sigint_inbox_item.datetime)"),
                "last_datetime",
            )
            .group_by(sigint_inbox_item::Column::Freq)
            .into_model::<Row>()
            .all(&env.dbx)
            .await
            .c(h!())?;

    let mut result = BTreeMap::new();
    for row in rows {
        let (Some(freq), Some(last_datetime)) = (row.freq, row.last_datetime)
        else {
            continue;
        };
        result.insert(freq, last_datetime);
    }
    Ok(result)
}

async fn summary_table_related_networks_by_freq_by_login(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<BTreeMap<String, Vec<String>>, AppError> {
    #[derive(FromQueryResult)]
    struct NetworkFreqRow {
        freq: Option<String>,
        network_name: String,
        unit_name: Option<String>,
    }

    if req.without_network.unwrap_or(false) {
        return Ok(BTreeMap::new());
    }

    let filtered_messages_alias = Alias::new("filtered_messages");
    let inbox_network_alias = Alias::new("summary_inbox_network");
    let network_alias = Alias::new("summary_network");
    let network_unit_alias = Alias::new("summary_network_unit");
    let unit_alias = Alias::new("summary_unit");

    let filtered_messages_query =
        build_summary_table_filtered_messages_query(login, req, master_keys)?
            .select_only()
            .column_as(
                Expr::col((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Id,
                )),
                "inbox_item_id",
            )
            .column_as(
                Expr::col((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Freq,
                )),
                "freq",
            )
            .distinct_on([Alias::new("inbox_item_id"), Alias::new("freq")]);

    let mut query = Query::select();
    query
        .column((filtered_messages_alias.clone(), "freq"))
        .expr_as(
            Expr::col((network_alias.clone(), sigint_network::Column::Name)),
            Alias::new("network_name"),
        )
        .expr_as(
            Expr::col((unit_alias.clone(), sigint_unit::Column::Name)),
            Alias::new("unit_name"),
        )
        .from_subquery(
            filtered_messages_query.into_query(),
            filtered_messages_alias.clone(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            inbox_network_alias.clone(),
            Expr::col((filtered_messages_alias.clone(), "inbox_item_id"))
                .equals((
                    inbox_network_alias.clone(),
                    sigint_inbox_item_network::Column::SigintInboxItemId,
                )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((
                    inbox_network_alias.clone(),
                    sigint_inbox_item_network::Column::SigintNetworkId,
                )),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network_unit::Entity,
            network_unit_alias.clone(),
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .equals((
                    network_unit_alias.clone(),
                    sigint_network_unit::Column::NetworkId,
                )),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_unit::Entity,
            unit_alias.clone(),
            Expr::col((
                network_unit_alias.clone(),
                sigint_network_unit::Column::UnitId,
            ))
            .equals((unit_alias.clone(), sigint_unit::Column::Id)),
        )
        .and_where(
            Expr::col((network_alias.clone(), sigint_network::Column::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((unit_alias.clone(), sigint_unit::Column::Deleted))
                .eq(false)
                .or(Expr::col((unit_alias.clone(), sigint_unit::Column::Id))
                    .is_null()),
        );
    if let Some(selected_networks) =
        req.selected_networks.as_ref().filter(|ids| !ids.is_empty())
    {
        query.and_where(
            Expr::col((network_alias.clone(), sigint_network::Column::Id))
                .is_in(selected_networks.clone()),
        );
    }
    let query = query.to_owned();
    let rows = NetworkFreqRow::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        query.to_string(PostgresQueryBuilder),
    ))
    .all(&env.dbx)
    .await
    .c(h!())?;

    let mut networks_by_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let Some(freq) = row.freq else {
            continue;
        };
        let network_name = row.network_name.trim();
        if network_name.is_empty() {
            continue;
        }
        let full_name = match row.unit_name.as_deref().map(str::trim) {
            Some(unit_name) if !unit_name.is_empty() => {
                format!("{network_name} {unit_name}")
            }
            _ => network_name.to_string(),
        };
        networks_by_freq
            .entry(freq)
            .and_modify(|items| {
                if !items.iter().any(|existing| existing == &full_name) {
                    items.push(full_name.clone());
                }
            })
            .or_insert_with(|| vec![full_name]);
    }

    Ok(networks_by_freq)
}

struct SummaryTableReportData {
    description: String,
    summary_table: SummaryTableFreq,
    last_datetime_by_freq: BTreeMap<String, NaiveDateTime>,
    related_networks_by_freq: BTreeMap<String, Vec<String>>,
}

struct SummaryTableChunkData {
    summary_table: SummaryTableFreq,
    last_datetime_by_freq: BTreeMap<String, NaiveDateTime>,
    related_networks_by_freq: BTreeMap<String, Vec<String>>,
}

#[derive(Default)]
struct SummaryTableAccumulator {
    rows_by_freq: BTreeMap<String, SummaryTableFreqRow>,
    last_datetime_by_freq: BTreeMap<String, NaiveDateTime>,
    networks_by_freq: BTreeMap<String, BTreeSet<String>>,
}

pub(crate) async fn summary_table_xlsx_bytes(
    login: &uuid::Uuid,
    env: &Env,
    req: AnalysisStatsReq,
) -> Result<Vec<u8>, AppError> {
    let data = collect_summary_table_report_data(login, env, &req).await?;
    build_summary_table_report(&data).await
}

async fn collect_summary_table_report_data(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
) -> Result<SummaryTableReportData, AppError> {
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks = report_period_chunks(
        req.since_date_inclusive_ms,
        req.till_date_noninclusive_ms,
        report_settings.chunking_hours,
        ReportPeriodEnd::NonInclusive,
    )?;
    let mut message_count = 0_usize;
    let mut accumulator = SummaryTableAccumulator::default();
    for (index, chunk) in chunks.iter().enumerate() {
        log::info!(
            "Summary Table report chunk {}/{}: {}..{}",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms
        );
        let mut chunk_req = req.clone();
        chunk_req.since_date_inclusive_ms = chunk.since_ms;
        chunk_req.till_date_noninclusive_ms = chunk.till_ms;
        if report_settings.limit_big_reports {
            message_count = message_count.saturating_add(
                summary_table_report_message_count(
                    login,
                    env,
                    &chunk_req,
                    &master_keys,
                )
                .await
                .c(h!())?,
            );
            ensure_summary_table_report_message_limit(login, message_count)?;
        }
        let chunk_data = SummaryTableChunkData {
            summary_table: summary_table_freq_without_coordinates_by_login(
                login,
                env,
                &chunk_req,
                &master_keys,
            )
            .await
            .c(h!())?,
            last_datetime_by_freq:
                summary_table_last_datetime_by_freq_by_login(
                    login,
                    env,
                    &chunk_req,
                    &master_keys,
                )
                .await
                .c(h!())?,
            related_networks_by_freq:
                summary_table_related_networks_by_freq_by_login(
                    login,
                    env,
                    &chunk_req,
                    &master_keys,
                )
                .await
                .c(h!())?,
        };
        merge_summary_table_chunk(&mut accumulator, chunk_data);
    }

    Ok(finish_summary_table_merge(
        describe_analysis_stats_req(req.clone())?,
        accumulator,
    ))
}

#[cfg(test)]
fn merge_summary_table_chunks(
    description: String,
    chunks: Vec<SummaryTableChunkData>,
) -> Result<SummaryTableReportData, AppError> {
    let mut accumulator = SummaryTableAccumulator::default();
    for chunk in chunks {
        merge_summary_table_chunk(&mut accumulator, chunk);
    }
    Ok(finish_summary_table_merge(description, accumulator))
}

fn merge_summary_table_chunk(
    accumulator: &mut SummaryTableAccumulator,
    chunk: SummaryTableChunkData,
) {
    for mut row in chunk.summary_table.rows {
        row.coords.clear();
        row.locality_coords.clear();
        match accumulator.rows_by_freq.entry(row.freq.clone()) {
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                let existing = entry.get_mut();
                existing.count += row.count;
                existing.callsigns.extend(row.callsigns);
                existing.units.extend(row.units);
                existing.locations.extend(row.locations);
            }
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(row);
            }
        }
    }
    for (freq, datetime) in chunk.last_datetime_by_freq {
        accumulator
            .last_datetime_by_freq
            .entry(freq)
            .and_modify(|existing| {
                if *existing < datetime {
                    *existing = datetime;
                }
            })
            .or_insert(datetime);
    }
    for (freq, networks) in chunk.related_networks_by_freq {
        accumulator
            .networks_by_freq
            .entry(freq)
            .or_default()
            .extend(networks);
    }
}

fn finish_summary_table_merge(
    description: String,
    mut accumulator: SummaryTableAccumulator,
) -> SummaryTableReportData {
    for row in accumulator.rows_by_freq.values_mut() {
        row.callsigns.sort();
        row.callsigns.dedup();
        row.units.sort();
        row.units.dedup();
        row.locations.sort();
        row.locations.dedup();
        row.coords.clear();
        row.locality_coords.clear();
    }
    SummaryTableReportData {
        description,
        summary_table: SummaryTableFreq {
            rows: accumulator.rows_by_freq.into_values().collect(),
        },
        last_datetime_by_freq: accumulator.last_datetime_by_freq,
        related_networks_by_freq: accumulator
            .networks_by_freq
            .into_iter()
            .map(|(freq, networks)| (freq, networks.into_iter().collect()))
            .collect(),
    }
}

fn xlsx_list_cell_text<T>(values: impl IntoIterator<Item = T>) -> String
where
    T: ToString,
{
    let tokens = values
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    let token_count = tokens.len();
    let mut collected_tokens = Vec::new();
    let mut character_count = 0;
    for token in tokens {
        let separator_character_count = if collected_tokens.is_empty() {
            0
        } else {
            RER_SUMMARY_TABLE_XLSX_LIST_SEPARATOR.chars().count()
        };
        let next_character_count =
            character_count + separator_character_count + token.chars().count();
        if next_character_count > RER_SUMMARY_TABLE_XLSX_LIST_CHARACTER_LIMIT {
            break;
        }
        collected_tokens.push(token);
        character_count = next_character_count;
    }
    append_xlsx_omitted_count_token(
        &mut collected_tokens,
        &mut character_count,
        token_count,
    );
    collected_tokens.join(RER_SUMMARY_TABLE_XLSX_LIST_SEPARATOR)
}

fn append_xlsx_omitted_count_token(
    tokens: &mut Vec<String>,
    character_count: &mut usize,
    token_count: usize,
) {
    if tokens.len() == token_count {
        return;
    }
    let separator_character_count =
        RER_SUMMARY_TABLE_XLSX_LIST_SEPARATOR.chars().count();
    loop {
        let omitted_count = token_count - tokens.len();
        let omitted_count_token = format!("та ще {omitted_count} ін.");
        let next_character_count = *character_count
            + if tokens.is_empty() {
                0
            } else {
                separator_character_count
            }
            + omitted_count_token.chars().count();
        if next_character_count <= RER_SUMMARY_TABLE_XLSX_LIST_CHARACTER_LIMIT {
            tokens.push(omitted_count_token);
            return;
        }
        let removed = tokens.pop().expect("at least one collected XLSX token");
        *character_count -= removed.chars().count();
        if !tokens.is_empty() {
            *character_count -= separator_character_count;
        }
    }
}

async fn build_summary_table_report(
    data: &SummaryTableReportData,
) -> Result<Vec<u8>, AppError> {
    let callsign_count = data
        .summary_table
        .rows
        .iter()
        .flat_map(|row| row.callsigns.iter())
        .collect::<BTreeSet<_>>()
        .len();
    let record_count =
        data.summary_table.rows.len().saturating_add(callsign_count);
    crate::report_history::ensure_report_record_count(record_count)
        .context(h!())?;
    let SummaryTableReportData {
        description,
        summary_table,
        last_datetime_by_freq,
        related_networks_by_freq,
    } = data;
    let tmp_dir = TempDir::new()?;
    let outpath = tmp_dir.path().join("summary-table.xlsx");
    let mut workbook = Workbook::new(); // No argument needed here

    // Create formats
    let format_bold = Format::new().set_bold();
    let format_wrap = Format::new().set_text_wrap();

    // Get the first worksheet and set its name
    let sheet1 = workbook.add_worksheet();
    sheet1.set_name("Частоти").context(h!())?;

    // Write data and apply formats
    sheet1.write_string(0, 0, description).context(h!())?;

    sheet1
        .write_string_with_format(2, 0, "Частота", &format_bold)
        .context(h!())?;
    sheet1
        .write_string_with_format(2, 1, "Кількість повідомлень", &format_bold)
        .context(h!())?;
    sheet1.set_column_width(1, 5.0).context(h!())?; // Set width for column 1
    sheet1
        .write_string_with_format(2, 2, "Позивні", &format_bold)
        .context(h!())?;
    sheet1.set_column_width(2, 40.0).context(h!())?; // Set width for column 2
    sheet1.set_column_format(2, &format_wrap).context(h!())?; // Apply format to column 2
    sheet1
        .write_string_with_format(2, 3, "Підрозділи", &format_bold)
        .context(h!())?;
    sheet1.set_column_width(3, 80.0).context(h!())?; // Set width for column 3
    sheet1.set_column_format(3, &format_wrap).context(h!())?; // Apply format to column 3
    sheet1
        .write_string_with_format(2, 4, "Останнє перехоплення", &format_bold)
        .context(h!())?;
    sheet1.set_column_width(4, 24.0).context(h!())?;
    sheet1
        .write_string_with_format(2, 5, "Мережі", &format_bold)
        .context(h!())?;
    sheet1.set_column_width(5, 80.0).context(h!())?;
    sheet1.set_column_format(5, &format_wrap).context(h!())?;

    for (i, row) in summary_table.rows.iter().enumerate() {
        let row_i = i as u32 + 3;
        let last_datetime = last_datetime_by_freq
            .get(&row.freq)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default();
        let related_networks = related_networks_by_freq
            .get(&row.freq)
            .map(xlsx_list_cell_text)
            .unwrap_or_default();
        let callsigns = xlsx_list_cell_text(&row.callsigns);
        let units = xlsx_list_cell_text(&row.units);
        sheet1.write_string(row_i, 0, &row.freq).context(h!())?; // Removed None
        sheet1
            .write_number(row_i, 1, row.count as f64)
            .context(h!())?; // Removed None
        sheet1.write_string(row_i, 2, callsigns).context(h!())?; // Removed None
        sheet1.write_string(row_i, 3, units).context(h!())?; // Removed None
        sheet1
            .write_string(row_i, 4, &last_datetime)
            .context(h!())?;
        sheet1
            .write_string(row_i, 5, &related_networks)
            .context(h!())?;
    }

    // Add and name the second sheet
    let sheet2 = workbook.add_worksheet();
    sheet2.set_name("Позивні").context(h!())?;
    let mut freqs_per_callsign: BTreeMap<String, Vec<String>> = BTreeMap::new();
    // ...existing code to populate freqs_per_callsign...
    for row in summary_table.rows.iter() {
        for callsign in row.callsigns.iter() {
            freqs_per_callsign
                .entry(callsign.clone())
                .and_modify(|xs| {
                    if !xs.iter().any(|existing| existing == &row.freq) {
                        xs.push(row.freq.clone())
                    }
                })
                .or_insert(vec![row.freq.clone()]);
        }
    }
    for (i, (callsign, freqs)) in freqs_per_callsign.iter().enumerate() {
        sheet2.write_string(i as u32, 0, callsign).context(h!())?; // Removed None
        for (j, freq) in freqs.iter().enumerate() {
            sheet2
                .write_string(i as u32, 1 + j as u16, freq)
                .context(h!())?; // Removed None
        }
    }

    // Save the workbook to the specified path
    workbook.save(&outpath).context(h!())?;
    let bytes = tokio::fs::read(&outpath).await.c(h!())?;
    Ok(bytes)
}

async fn summary_table_report_message_count(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<usize, AppError> {
    let message_count =
        build_summary_table_filtered_messages_query(login, req, master_keys)?
            .select_only()
            .column(signal_message::Column::Id)
            .limit((RER_SUMMARY_TABLE_REPORT_MESSAGE_MAX + 1) as u64)
            .into_tuple::<i64>()
            .all(&env.dbx)
            .await
            .c(h!())?
            .len();
    Ok(message_count)
}

fn ensure_summary_table_report_message_limit(
    user_login: &uuid::Uuid,
    message_count: usize,
) -> Result<(), AppError> {
    if message_count <= RER_SUMMARY_TABLE_REPORT_MESSAGE_MAX {
        return Ok(());
    }

    log::error!(
        "summary table report message limit exceeded: user={user_login}, messages={message_count}, max_messages={RER_SUMMARY_TABLE_REPORT_MESSAGE_MAX}",
    );
    Err(AppError::BL {
        msg: RER_SUMMARY_TABLE_REPORT_MESSAGE_LIMIT_ERROR_CODE.to_string(),
    })
}

#[post("/api/rer/analysis/summary-table-task-launch")]
async fn summary_table_task_launch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    launch_analysis_export_task(
        user,
        env,
        req.into_inner(),
        crate::report_history::KIND_SUMMARY_TABLE,
        Some("summary-table.xlsx".to_string()),
        Some(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                .to_string(),
        ),
    )
    .await
}

#[post("/api/rer/analysis/kmz-task-launch")]
pub async fn kmz_task_launch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    launch_analysis_export_task(
        user,
        env,
        req.into_inner(),
        crate::report_history::KIND_KMZ,
        Some("analysis.kmz".to_string()),
        Some("application/vnd.google-earth.kmz".to_string()),
    )
    .await
}

#[post("/api/rer/analysis/geojson-task-launch")]
pub async fn geojson_task_launch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    launch_analysis_export_task(
        user,
        env,
        req.into_inner(),
        crate::report_history::KIND_GEOJSON,
        Some("analysis.geojson".to_string()),
        Some("application/geo+json".to_string()),
    )
    .await
}

async fn launch_analysis_export_task(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: AnalysisStatsReq,
    report_kind: &str,
    file_name: Option<String>,
    content_type: Option<String>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let report_history = crate::report_history::enqueue_report(
        &env.dbx,
        &login,
        report_kind,
        crate::report_history::ReportHistoryRequest::AnalysisExport {
            payload: Box::new(req),
        },
        file_name,
        content_type,
    )
    .await
    .c(h!())?;
    Ok(Json(report_history.id))
}

fn describe_analysis_stats_req(
    req: AnalysisStatsReq,
) -> Result<String, AppError> {
    let dt_since = dt_zoned_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_zoned_from_millis(req.till_date_noninclusive_ms)?;

    let selected_groups_s = match req.selected_groups {
        Some(groups) => format!("Групи: {}. ", groups.join(", ")),
        None => "".to_string(),
    };
    let selected_senders_s = match req.selected_senders {
        Some(senders) => format!("Відправники: {}. ", senders.join(", ")),
        None => "".to_string(),
    };
    let selected_freqs_s = match req.selected_freqs {
        Some(freqs) => format!("Частоти: {}. ", freqs.join(", ")),
        None => "".to_string(),
    };
    let selected_callsigns_s = match req.selected_callsigns {
        Some(callsigns) => format!("Позивні: {}. ", callsigns.join(", ")),
        None => "".to_string(),
    };
    let selected_units_s = match req.selected_units {
        Some(units) => format!("Підрозділи: {}. ", units.join(", ")),
        None => "".to_string(),
    };
    let selected_device_names_s = match req.selected_device_names {
        Some(device_names) => {
            format!("Пристрої: {}. ", device_names.join(", "))
        }
        None => "".to_string(),
    };

    Ok(format!(
        "Період: {} - {}. {selected_groups_s}{selected_senders_s}{selected_freqs_s}{selected_callsigns_s}{selected_units_s}{selected_device_names_s}",
        dt_since.format("%d.%m.%Y %H:%M:%S"),
        dt_till.format("%d.%m.%Y %H:%M:%S"),
    ))
}

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/correlated-freqs")]
async fn correlated_freqs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<CorrelatedFreqsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();
    let empty = CorrelatedFreqsRsp { freqs: vec![] };
    let Some(selected_freqs) = req.selected_freqs.as_ref() else {
        return Ok(Json(empty));
    };
    if selected_freqs.is_empty() {
        return Ok(Json(empty));
    }
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    // Keep correlated-frequency analysis within its configured maximum period.
    let dt_since = if dt_till - dt_since
        > chrono::Duration::days(CORRELATED_FREQS_MAX_DAYS)
    {
        dt_till - chrono::Duration::days(CORRELATED_FREQS_MAX_DAYS)
    } else {
        dt_since
    };

    let accessible_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let analytics_groups = accessible_groups.clone();
    let postgres_groups = accessible_groups;
    let analytics_req = &req;
    let postgres_req = &req;
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let freqs = with_analytics_read_fallback(
        env.get_ref(),
        "analysis correlated frequencies",
        true,
        |db| async move {
            let scope = stats::resolve_analytics_message_id_scope_for_range(
                dt_since,
                dt_till,
                &db,
                freshness_max_age_ms,
            )
            .await?;
            load_correlated_freqs_with_db(
                analytics_req,
                analytics_groups,
                dt_since,
                dt_till,
                &db,
                Some(&scope),
                crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics,
            )
            .await
        },
        |db| async move {
            load_correlated_freqs_with_db(
                postgres_req,
                postgres_groups,
                dt_since,
                dt_till,
                &db,
                None,
                crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres,
            )
            .await
        },
    )
    .await?;

    Ok(Json(CorrelatedFreqsRsp { freqs }))
}

#[derive(FromQueryResult)]
struct CorrelatedFreqCallsignRow {
    callsign: String,
}

#[derive(FromQueryResult)]
struct CorrelatedFreqCallsignPairRow {
    freq: String,
    callsign: String,
}

#[allow(clippy::too_many_arguments)]
async fn load_correlated_freqs_with_db(
    req: &AnalysisStatsReq,
    accessible_groups: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    db: &DatabaseConnection,
    scope: Option<&AnalyticsMessageIdScope>,
    callsign_source: crate::inbox::callsigns::EffectiveCallsignSqlSource,
) -> Result<Vec<CorrelatedFreq>, AppError> {
    let selected_freqs = req.selected_freqs.as_ref().context(h!())?;
    let query = build_correlated_freq_messages_query(
        req,
        accessible_groups,
        dt_since,
        dt_till,
        scope,
    )?;
    match callsign_source {
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres => {
            load_correlated_freqs_postgres(query, selected_freqs, db).await
        }
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics => {
            load_correlated_freqs_analytics(query, selected_freqs, db, scope)
                .await
        }
    }
}

async fn load_correlated_freqs_postgres(
    query: Select<signal_message::Entity>,
    selected_freqs: &[String],
    db: &DatabaseConnection,
) -> Result<Vec<CorrelatedFreq>, AppError> {
    let selected_callsigns = CorrelatedFreqCallsignRow::find_by_statement(
        effective_callsign_values_statement(
            query
                .clone()
                .filter(correlated_freq_is_selected_expr(selected_freqs))
                .select_only()
                .column_as(sigint_inbox_item::Column::Id, "id")
                .distinct(),
        ),
    )
    .all(db)
    .await
    .c(h!())?
    .into_iter()
    .map(|row| row.callsign)
    .collect::<Vec<_>>();
    if selected_callsigns.is_empty() {
        return Ok(Vec::new());
    }
    let query = query
        .filter(correlated_freq_is_selected_expr(selected_freqs).not())
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .select_only()
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .distinct();
    let rows = CorrelatedFreqCallsignPairRow::find_by_statement(
        correlated_freq_callsign_pairs_statement(query, &selected_callsigns),
    )
    .all(db)
    .await
    .c(h!())?;
    Ok(correlated_freqs_from_pairs(rows))
}

fn build_correlated_freq_messages_query(
    req: &AnalysisStatsReq,
    accessible_groups: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<signal_message::Entity>, AppError> {
    let query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(accessible_groups),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let query = if let Some(scope) = scope {
        query
            .filter(scope.condition((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )))
            .filter(scope.condition((
                signal_message::Entity,
                signal_message::Column::Id,
            )))
    } else {
        query
    };
    let query = filter_selected_metadata_for_analysis_stats(query, req)?;
    filter_selected_device_names(query, &req.selected_device_names)
}

async fn load_correlated_freqs_analytics(
    query: Select<signal_message::Entity>,
    selected_freqs: &[String],
    db: &DatabaseConnection,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Vec<CorrelatedFreq>, AppError> {
    let (query, callsign_alias) = join_analytics_message_callsign(
        query,
        "correlated_freq_callsign",
        scope,
    );
    let selected_callsigns = query
        .clone()
        .filter(correlated_freq_is_selected_expr(selected_freqs))
        .select_only()
        .column_as(
            Expr::col((callsign_alias.clone(), Alias::new("callsign"))),
            "callsign",
        )
        .filter(
            Expr::col((callsign_alias.clone(), Alias::new("callsign")))
                .is_not_null(),
        )
        .distinct()
        .into_model::<CorrelatedFreqCallsignRow>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| row.callsign)
        .collect::<Vec<_>>();
    if selected_callsigns.is_empty() {
        return Ok(Vec::new());
    }
    let rows = query
        .filter(correlated_freq_is_selected_expr(selected_freqs).not())
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(
            Expr::col((callsign_alias.clone(), Alias::new("callsign")))
                .is_in(selected_callsigns),
        )
        .select_only()
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(
            Expr::col((callsign_alias, Alias::new("callsign"))),
            "callsign",
        )
        .distinct()
        .into_model::<CorrelatedFreqCallsignPairRow>()
        .all(db)
        .await
        .c(h!())?;
    Ok(correlated_freqs_from_pairs(rows))
}

fn correlated_freqs_from_pairs(
    rows: Vec<CorrelatedFreqCallsignPairRow>,
) -> Vec<CorrelatedFreq> {
    let mut callsigns_by_freq = BTreeMap::<String, BTreeSet<String>>::new();
    for row in rows {
        callsigns_by_freq
            .entry(row.freq)
            .or_default()
            .insert(row.callsign);
    }
    let mut freqs = callsigns_by_freq
        .into_iter()
        .map(|(freq, common_callsigns)| CorrelatedFreq {
            freq,
            common_callsigns: common_callsigns.into_iter().collect(),
        })
        .collect::<Vec<_>>();
    freqs.sort_by(|left, right| {
        right
            .common_callsigns
            .len()
            .cmp(&left.common_callsigns.len())
            .then_with(|| left.freq.cmp(&right.freq))
    });
    freqs
}

fn join_analytics_message_callsign<E>(
    mut query: Select<E>,
    alias: &str,
    scope: Option<&AnalyticsMessageIdScope>,
) -> (Select<E>, Alias)
where
    E: EntityTrait,
{
    let callsign_alias = Alias::new(alias);
    QuerySelect::query(&mut query).join_as(
        JoinType::InnerJoin,
        (
            Alias::new("echo_clickhouse_derived"),
            Alias::new("message_callsign"),
        ),
        callsign_alias.clone(),
        Expr::col((callsign_alias.clone(), Alias::new("sigint_inbox_item_id")))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
    );
    if let Some(scope) = scope {
        QuerySelect::query(&mut query).cond_where(scope.condition((
            callsign_alias.clone(),
            Alias::new("sigint_inbox_item_id"),
        )));
    }
    (query, callsign_alias)
}

fn correlated_freq_is_selected_expr(selected_freqs: &[String]) -> SimpleExpr {
    let includes_empty = selected_freqs.iter().any(String::is_empty);
    let selected_freqs = selected_freqs
        .iter()
        .filter(|freq| !freq.is_empty())
        .cloned()
        .collect::<Vec<_>>();
    match (includes_empty, selected_freqs.is_empty()) {
        (true, true) => Expr::cust(
            "sigint_inbox_item.freq IS NULL OR sigint_inbox_item.freq = ''",
        ),
        (true, false) => Expr::cust_with_values(
            "sigint_inbox_item.freq IS NULL OR sigint_inbox_item.freq = '' OR sigint_inbox_item.freq = ANY($1)",
            vec![selected_freqs],
        ),
        (false, false) => Expr::cust_with_values(
            "COALESCE(sigint_inbox_item.freq = ANY($1), FALSE)",
            vec![selected_freqs],
        ),
        (false, true) => Expr::value(false),
    }
}

fn correlated_freq_callsign_pairs_statement(
    query: Select<signal_message::Entity>,
    selected_callsigns: &[String],
) -> Statement {
    let filtered_items = query.build(DbBackend::Postgres);
    let values = filtered_items
        .values
        .map(|values| values.0)
        .unwrap_or_default();
    let callsign_ctes =
        crate::inbox::callsigns::postgres_effective_callsign_ctes(
            &filtered_items.sql,
        );
    let selected_callsigns =
        crate::inbox::callsigns::sql_string_literals(selected_callsigns);
    let sql = format!(
        r#"
{callsign_ctes}
SELECT DISTINCT
    filtered_items.freq,
    all_callsigns.callsign
FROM filtered_items
INNER JOIN all_callsigns
    ON all_callsigns.inbox_item_id = filtered_items.id
WHERE all_callsigns.callsign IN ({selected_callsigns})
ORDER BY filtered_items.freq, all_callsigns.callsign
"#,
    );
    Statement::from_sql_and_values(DbBackend::Postgres, sql, values)
}

#[post("/api/rer/analysis/freq-edit-unit-name")]
pub async fn edit_freq_unit_name(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<EditFreqUnitNameReq>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let reqan = req.analysis_stats_req.clone();
    let dt_since = dt_from_millis(reqan.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(reqan.till_date_noninclusive_ms)?;
    let txn = env.dbx.begin().await.c(h!())?;

    #[derive(FromQueryResult)]
    struct Row {
        id: i64,
    }
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let rows_res = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(Expr::cust("signal_message.id"), "id")
        // .column_as(Expr::col(signal_message::Column::Id), "id")
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Freq.eq(req.freq.clone()))
        .filter(sigint_inbox_item::Column::UnitV2.eq(req.unit.clone()));
    let rows_res = filter_selected_freqs(rows_res, &reqan.selected_freqs)?;
    let rows_res = filter_selected_posts(rows_res, &reqan.selected_posts)?;
    let rows_res = filter_selected_groups_and_senders_with_access(
        rows_res,
        &reqan.selected_groups,
        &reqan.selected_senders,
        &sigint_groups,
    )?;
    let rows_res = filter_selected_units(
        rows_res,
        &reqan.selected_units,
        &req.analysis_stats_req.units_exact_match_only,
    )?;
    let rows_res =
        filter_selected_callsigns(rows_res, &reqan.selected_callsigns)?;
    let rows_res = filter_selected_tags(
        rows_res,
        &reqan.selected_tags,
        &None,
        &None,
        &None,
        &None,
        &None,
        &None,
        &None,
        &req.filter_tags_option,
        &reqan.without_model_tags,
        &login_id_from_identity(&user)?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let rows_res = filter_selected_networks(
        rows_res,
        &reqan.selected_networks,
        &reqan.without_network,
    )
    .context(h!())?;
    let rows_res =
        filter_selected_metadata_for_analysis_stats(rows_res, &reqan)?;
    let rows_res = filter_search(rows_res, &req.search)?;
    let rows_res =
        filter_selected_device_names(rows_res, &reqan.selected_device_names)?;
    // println!(
    //     "> freq edit query: {}",
    //     rows_res.build(DbBackend::Postgres).to_string()
    // );
    let rows_res: Vec<Row> =
        rows_res.into_model::<Row>().all(&txn).await.c(h!())?;

    for row in rows_res {
        for id in crate::rer_importer::inbox::find_all_duplicates(&txn, row.id)
            .await
            .c(h!())?
        {
            let Some(row) = sigint_inbox_item::Entity::find_by_id(id)
                .one(&txn)
                .await
                .c(h!())?
            else {
                continue;
            };
            let mut row: sigint_inbox_item::ActiveModel = row.into();
            row.unit = Set(Some(req.unit_new.clone()));
            row.unit_v2 = Set(Some(req.unit_new.clone()));
            row.parsed_unit_v2 = Set(true);
            let row = row.update(&txn).await.c(h!())?;
            crate::inbox::unit_resolution::resolve_and_sync_inbox_item(
                &txn,
                row.id,
                row.unit_v2.as_deref(),
                row.unit.as_deref(),
            )
            .await
            .c(h!())?;
            crate::stats::enqueue_group_stats_recalculation_for_message(
                &txn,
                id,
                format!("updated unit for inbox message {id}"),
            )
            .await
            .c(h!())?;
        }
    }

    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

trait FromSavedFilter {
    fn from_saved_filter(
        saved_filter: &sigint_saved_filter::Model,
    ) -> Result<Self, serde_json::Error>
    where
        Self: Sized;
}

impl FromSavedFilter for SavedFilter {
    fn from_saved_filter(
        saved_filter: &sigint_saved_filter::Model,
    ) -> Result<Self, serde_json::Error> {
        Ok(SavedFilter {
            id: saved_filter.id,
            name: saved_filter.name.clone(),
            req: serde_json::from_value(saved_filter.req.clone())?,
        })
    }
}

impl FromSavedFilter for SavedFilterDuty {
    fn from_saved_filter(
        saved_filter: &sigint_saved_filter::Model,
    ) -> Result<Self, serde_json::Error>
    where
        Self: Sized,
    {
        Ok(SavedFilterDuty {
            id: saved_filter.id,
            name: saved_filter.name.clone(),
            req: serde_json::from_value(saved_filter.req.clone())?,
        })
    }
}

async fn select_saved_filter_list<T>(
    filter_type: sea_orm_active_enums::SigintSavedFilterTypeEnum,
    user_id: uuid::Uuid,
    dbx: &DbConn,
) -> Result<Vec<T>, AppError>
where
    T: FromSavedFilter,
{
    let saved_filters = sigint_saved_filter::Entity::find()
        .filter(sigint_saved_filter::Column::LoginId.eq(Some(user_id)))
        .filter(sigint_saved_filter::Column::Type.eq(filter_type))
        .order_by_asc(sigint_saved_filter::Column::Name)
        .all(dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for saved_filter in saved_filters {
        res.push(T::from_saved_filter(&saved_filter).context(h!())?);
    }
    Ok(res)
}

#[post("/api/rer/analysis/saved-filters")]
pub async fn saved_filters_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<SavedFilter>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    Ok(Json(
        select_saved_filter_list(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Analysis,
            login_id_from_identity(&user)?,
            &env.dbx,
        )
        .await
        .c(h!())?,
    ))
}

#[post("/api/rer/duty/saved-filters")]
pub async fn saved_filters_duty_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<SavedFilterDuty>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    Ok(Json(
        select_saved_filter_list(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Duty,
            login_id_from_identity(&user)?,
            &env.dbx,
        )
        .await
        .c(h!())?,
    ))
}

fn filter_type_form_path(
    path: &str,
) -> Result<sea_orm_active_enums::SigintSavedFilterTypeEnum, AppError> {
    match path {
        "analysis" => {
            Ok(sea_orm_active_enums::SigintSavedFilterTypeEnum::Analysis)
        }
        "duty" => Ok(sea_orm_active_enums::SigintSavedFilterTypeEnum::Duty),
        _ => Err(AppError::NotFound),
    }
}

#[post("/api/rer/analysis/saved-filter-upsert")]
pub async fn saved_filter_upsert(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SavedFilterUpsertReq>,
) -> Result<Json<Vec<SavedFilter>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    Ok(Json(
        saved_filter_upsert_1(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Analysis,
            login_id_from_identity(&user)?,
            &env.dbx,
            req.name.clone(),
            serde_json::to_value(req.req.clone()).context(h!())?,
        )
        .await
        .c(h!())?,
    ))
}

#[post("/api/rer/duty/saved-filter-upsert")]
pub async fn saved_filter_duty_upsert(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SavedFilterDutyUpsertReq>,
) -> Result<Json<Vec<SavedFilterDuty>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    Ok(Json(
        saved_filter_upsert_1(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Duty,
            login_id_from_identity(&user)?,
            &env.dbx,
            req.name.clone(),
            serde_json::to_value(req.req.clone()).context(h!())?,
        )
        .await
        .c(h!())?,
    ))
}

async fn saved_filter_upsert_1<T>(
    filter_type: sea_orm_active_enums::SigintSavedFilterTypeEnum,
    user_id: uuid::Uuid,
    dbx: &DbConn,
    name: String,
    req: serde_json::Value,
) -> Result<Vec<T>, AppError>
where
    T: FromSavedFilter,
{
    let m_filter = sigint_saved_filter::Entity::find()
        .filter(sigint_saved_filter::Column::Name.eq(name.clone()))
        .filter(sigint_saved_filter::Column::LoginId.eq(Some(user_id)))
        .filter(sigint_saved_filter::Column::Type.eq(filter_type.clone()))
        .one(dbx)
        .await
        .c(h!())?;
    match m_filter {
        None => {
            sigint_saved_filter::ActiveModel {
                id: NotSet,
                created_at: NotSet,
                name: Set(name.clone()),
                req: Set(req.clone()),
                login_id: Set(Some(user_id)),
                r#type: Set(Some(filter_type.clone())),
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        Some(saved_filter) => {
            let mut saved_filter: sigint_saved_filter::ActiveModel =
                saved_filter.into();
            saved_filter.req =
                Set(serde_json::to_value(req.clone()).context(h!())?);
            saved_filter.update(dbx).await.c(h!())?;
        }
    }

    select_saved_filter_list(filter_type, user_id, dbx).await
}

#[post("/api/rer/{filter_type}/saved-filter-rename")]
pub async fn saved_filter_rename(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SavedFilterRenameReq>,
    path: actix_web::web::Path<String>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let filter_type = filter_type_form_path(path.into_inner().as_str())?;
    let saved_filter = sigint_saved_filter::Entity::find_by_id(req.id)
        .filter(
            sigint_saved_filter::Column::LoginId
                .eq(Some(login_id_from_identity(&user)?)),
        )
        .filter(sigint_saved_filter::Column::Type.eq(filter_type.clone()))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut saved_filter: sigint_saved_filter::ActiveModel =
        saved_filter.into();
    saved_filter.name = Set(req.name.clone());
    saved_filter.update(&env.dbx).await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/rer/{filter_type}/saved-filter-delete")]
pub async fn saved_filter_delete(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
    path: actix_web::web::Path<String>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let filter_type = filter_type_form_path(path.into_inner().as_str())?;
    let saved_filter =
        sigint_saved_filter::Entity::find_by_id(req.into_inner())
            .filter(
                sigint_saved_filter::Column::LoginId
                    .eq(Some(login_id_from_identity(&user)?)),
            )
            .filter(sigint_saved_filter::Column::Type.eq(filter_type.clone()))
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let saved_filter: sigint_saved_filter::ActiveModel = saved_filter.into();
    saved_filter.delete(&env.dbx).await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/rer/analysis/new-callsigns")]
pub async fn new_callsigns(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<NewCallsignsRes>, AppError> {
    let user_id = &login_id_from_identity(&user)?;
    let res = bi_new_callsigns(user_id, &env, &req.into_inner())
        .await
        .context(h!())?;

    Ok(Json(res))
}

pub async fn bi_new_callsigns(
    user_id: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
) -> Result<NewCallsignsRes, AppError> {
    ensure_rer_role_by_id(&env.dbx, user_id).await.c(h!())?;
    let group_master_keys = get_identity_sigint_groups(&env.dbx, user_id)
        .await
        .c(h!())?;
    let analytics_supported = analytics_count_request_supported(req);
    let analytics_tag_access = if env.analytics.is_some() && analytics_supported
    {
        Some(
            stats::resolve_analytics_tag_access(
                &env.dbx,
                user_id,
                req.report_tags_only_this_unit.unwrap_or(false),
            )
            .await?,
        )
    } else {
        None
    };
    let (report_since, report_till, lookback_since) =
        new_callsign_periods(req)?;
    let analytics_groups = group_master_keys.clone();
    let postgres_groups = group_master_keys;
    let analytics_req = req;
    let postgres_req = req;
    let analytics_user_id = user_id;
    let postgres_user_id = user_id;
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    with_analytics_read_fallback(
        env,
        "analysis new callsigns",
        analytics_supported,
        |db| async move {
            let (current_scope, lookback_scope) = tokio::try_join!(
                stats::resolve_analytics_message_id_scope_for_range(
                    report_since,
                    report_till,
                    &db,
                    freshness_max_age_ms,
                ),
                stats::resolve_analytics_message_id_scope_for_range(
                    lookback_since,
                    report_since,
                    &db,
                    freshness_max_age_ms,
                ),
            )?;
            load_new_callsigns_with_db(
                analytics_user_id,
                analytics_req,
                analytics_groups,
                &db,
                crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics,
                analytics_tag_access.as_ref(),
                Some(NewCallsignAnalyticsScopes {
                    current: current_scope,
                    lookback: lookback_scope,
                }),
            )
            .await
        },
        |db| async move {
            load_new_callsigns_with_db(
                postgres_user_id,
                postgres_req,
                postgres_groups,
                &db,
                crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres,
                None,
                None,
            )
            .await
        },
    )
    .await
}

struct NewCallsignAnalyticsScopes {
    current: AnalyticsMessageIdScope,
    lookback: AnalyticsMessageIdScope,
}

pub async fn bi_new_callsigns_chunked(
    user_id: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    chunking_hours: i64,
    final_end: ReportPeriodEnd,
    min_mentions: i64,
) -> Result<NewCallsignsRes, AppError> {
    ensure_rer_role_by_id(&env.dbx, user_id).await.c(h!())?;
    let group_master_keys = get_identity_sigint_groups(&env.dbx, user_id)
        .await
        .c(h!())?;
    let report_chunks = report_period_chunks(
        req.since_date_inclusive_ms,
        req.till_date_noninclusive_ms,
        chunking_hours,
        final_end,
    )?;
    let mut callsign_message_counts = BTreeMap::new();
    for (index, chunk) in report_chunks.iter().enumerate() {
        log::info!(
            "Babak new-callsigns report chunk {}/{}: {}..{}",
            index + 1,
            report_chunks.len(),
            chunk.since_ms,
            chunk.till_ms
        );
        for (callsign, message_count) in
            load_new_callsign_counts_in_range_with_db(
                user_id,
                req,
                chunk.since_ms,
                chunk.till_ms,
                chunk.end,
                &group_master_keys,
                true,
                &env.dbx,
            )
            .await?
        {
            *callsign_message_counts.entry(callsign).or_insert(0) +=
                message_count;
        }
    }
    let callsigns_in_period = callsign_message_counts
        .into_iter()
        .filter_map(|(callsign, message_count)| {
            (message_count >= min_mentions).then_some(callsign)
        })
        .collect();

    let lookback_since = req
        .since_date_inclusive_ms
        .checked_sub(chrono::Duration::days(30).num_milliseconds())
        .ok_or_else(|| AppError::BL {
            msg: "Некоректний період пошуку нових позивних".to_string(),
        })?;
    let lookback_chunks = report_period_chunks(
        lookback_since,
        req.since_date_inclusive_ms,
        chunking_hours,
        ReportPeriodEnd::NonInclusive,
    )?;
    let mut callsign_last_seen = BTreeMap::new();
    for (index, chunk) in lookback_chunks.iter().enumerate() {
        log::info!(
            "Babak new-callsigns lookback chunk {}/{}: {}..{}",
            index + 1,
            lookback_chunks.len(),
            chunk.since_ms,
            chunk.till_ms
        );
        for (callsign, timestamp) in load_new_callsign_last_seen_with_db(
            user_id,
            req,
            chunk.since_ms,
            chunk.till_ms,
            chunk.end,
            &group_master_keys,
            false,
            &env.dbx,
            crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres,
            None,
            None,
        )
        .await?
        {
            callsign_last_seen
                .entry(callsign)
                .and_modify(|last_seen| {
                    if *last_seen < timestamp {
                        *last_seen = timestamp;
                    }
                })
                .or_insert(timestamp);
        }
    }

    let report_since = dt_from_millis(req.since_date_inclusive_ms)?;
    Ok(classify_new_callsigns(
        callsigns_in_period,
        &callsign_last_seen,
        report_since,
    ))
}

fn new_callsign_periods(
    req: &AnalysisStatsReq,
) -> Result<(NaiveDateTime, NaiveDateTime, NaiveDateTime), AppError> {
    let report_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let report_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let lookback_since = report_since
        .checked_sub_signed(chrono::Duration::days(30))
        .context(h!())?;
    Ok((report_since, report_till, lookback_since))
}

#[allow(clippy::too_many_arguments)]
async fn load_new_callsigns_with_db(
    user_id: &uuid::Uuid,
    req: &AnalysisStatsReq,
    group_master_keys: Vec<String>,
    db: &DatabaseConnection,
    callsign_source: crate::inbox::callsigns::EffectiveCallsignSqlSource,
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
    analytics_scopes: Option<NewCallsignAnalyticsScopes>,
) -> Result<NewCallsignsRes, AppError> {
    let callsigns_in_period = load_new_callsigns_in_range_with_db(
        user_id,
        req,
        req.since_date_inclusive_ms,
        req.till_date_noninclusive_ms,
        ReportPeriodEnd::NonInclusive,
        &group_master_keys,
        true,
        db,
        callsign_source,
        analytics_tag_access,
        analytics_scopes.as_ref().map(|scopes| &scopes.current),
    )
    .await?;
    if callsigns_in_period.is_empty() {
        return Ok(classify_new_callsigns(
            callsigns_in_period,
            &BTreeMap::new(),
            dt_from_millis(req.since_date_inclusive_ms)?,
        ));
    }
    let lookback_since = req
        .since_date_inclusive_ms
        .checked_sub(chrono::Duration::days(30).num_milliseconds())
        .context(h!())?;
    let callsign_last_seen = load_new_callsign_last_seen_with_db(
        user_id,
        req,
        lookback_since,
        req.since_date_inclusive_ms,
        ReportPeriodEnd::NonInclusive,
        &group_master_keys,
        false,
        db,
        callsign_source,
        analytics_tag_access,
        analytics_scopes.as_ref().map(|scopes| &scopes.lookback),
    )
    .await?;
    Ok(classify_new_callsigns(
        callsigns_in_period,
        &callsign_last_seen,
        dt_from_millis(req.since_date_inclusive_ms)?,
    ))
}

#[derive(FromQueryResult)]
struct NewCallsignValueRow {
    callsign: String,
}

#[derive(FromQueryResult)]
struct NewCallsignCountRow {
    callsign: String,
    message_count: i64,
}

#[derive(FromQueryResult)]
struct NewCallsignLastSeenRow {
    callsign: String,
    last_seen: Option<NaiveDateTime>,
}

#[allow(clippy::too_many_arguments)]
async fn load_new_callsigns_in_range_with_db(
    user_id: &uuid::Uuid,
    req: &AnalysisStatsReq,
    since_ms: i64,
    till_ms: i64,
    period_end: ReportPeriodEnd,
    group_master_keys: &[String],
    include_aor_filter: bool,
    db: &DatabaseConnection,
    callsign_source: crate::inbox::callsigns::EffectiveCallsignSqlSource,
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<BTreeSet<String>, AppError> {
    let query = build_new_callsign_filtered_items_query(
        user_id,
        req,
        since_ms,
        till_ms,
        period_end,
        group_master_keys,
        include_aor_filter,
        callsign_source,
        analytics_tag_access,
        scope,
    )?;
    let rows = match callsign_source {
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres => {
            NewCallsignValueRow::find_by_statement(
                effective_callsign_values_statement(query),
            )
            .all(db)
            .await
            .c(h!())?
        }
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics => {
            let (query, callsign_alias) = join_analytics_message_callsign(
                query,
                "new_callsign_value",
                scope,
            );
            query
                .select_only()
                .column_as(
                    Expr::col((callsign_alias.clone(), Alias::new("callsign"))),
                    "callsign",
                )
                .filter(
                    Expr::col((callsign_alias.clone(), Alias::new("callsign")))
                        .is_not_null(),
                )
                .distinct()
                .order_by_asc(Expr::col((
                    callsign_alias,
                    Alias::new("callsign"),
                )))
                .into_model::<NewCallsignValueRow>()
                .all(db)
                .await
                .c(h!())?
        }
    };
    Ok(rows.into_iter().map(|row| row.callsign).collect())
}

async fn load_new_callsign_counts_in_range_with_db(
    user_id: &uuid::Uuid,
    req: &AnalysisStatsReq,
    since_ms: i64,
    till_ms: i64,
    period_end: ReportPeriodEnd,
    group_master_keys: &[String],
    include_aor_filter: bool,
    db: &DatabaseConnection,
) -> Result<BTreeMap<String, i64>, AppError> {
    let query = build_new_callsign_filtered_items_query(
        user_id,
        req,
        since_ms,
        till_ms,
        period_end,
        group_master_keys,
        include_aor_filter,
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres,
        None,
        None,
    )?;
    let rows = NewCallsignCountRow::find_by_statement(
        new_callsign_counts_statement(query),
    )
    .all(db)
    .await
    .c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| (row.callsign, row.message_count))
        .collect())
}

#[allow(clippy::too_many_arguments)]
async fn load_new_callsign_last_seen_with_db(
    user_id: &uuid::Uuid,
    req: &AnalysisStatsReq,
    since_ms: i64,
    till_ms: i64,
    period_end: ReportPeriodEnd,
    group_master_keys: &[String],
    include_aor_filter: bool,
    db: &DatabaseConnection,
    callsign_source: crate::inbox::callsigns::EffectiveCallsignSqlSource,
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<BTreeMap<String, NaiveDateTime>, AppError> {
    let query = build_new_callsign_filtered_items_query(
        user_id,
        req,
        since_ms,
        till_ms,
        period_end,
        group_master_keys,
        include_aor_filter,
        callsign_source,
        analytics_tag_access,
        scope,
    )?;
    let rows = match callsign_source {
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres => {
            NewCallsignLastSeenRow::find_by_statement(
                new_callsign_last_seen_statement(query),
            )
            .all(db)
            .await
            .c(h!())?
        }
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics => {
            let (query, callsign_alias) = join_analytics_message_callsign(
                query,
                "new_callsign_last_seen",
                scope,
            );
            query
                .select_only()
                .column_as(
                    Expr::col((callsign_alias.clone(), Alias::new("callsign"))),
                    "callsign",
                )
                .expr_as(
                    Expr::cust("MAX(sigint_inbox_item.datetime)"),
                    "last_seen",
                )
                .filter(
                    Expr::col((callsign_alias.clone(), Alias::new("callsign")))
                        .is_not_null(),
                )
                .group_by(Expr::col((
                    callsign_alias.clone(),
                    Alias::new("callsign"),
                )))
                .order_by_asc(Expr::col((
                    callsign_alias,
                    Alias::new("callsign"),
                )))
                .into_model::<NewCallsignLastSeenRow>()
                .all(db)
                .await
                .c(h!())?
        }
    };
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            row.last_seen.map(|last_seen| (row.callsign, last_seen))
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn build_new_callsign_filtered_items_query(
    user_id: &uuid::Uuid,
    req: &AnalysisStatsReq,
    since_ms: i64,
    till_ms: i64,
    period_end: ReportPeriodEnd,
    group_master_keys: &[String],
    include_aor_filter: bool,
    callsign_source: crate::inbox::callsigns::EffectiveCallsignSqlSource,
    analytics_tag_access: Option<&stats::AnalyticsTagAccess>,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Select<signal_message::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(sigint_inbox_item::Column::Datetime, "timestamp")
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(group_master_keys.to_vec()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            sigint_inbox_item::Column::Datetime.gte(dt_from_millis(since_ms)?),
        )
        .filter(match period_end {
            ReportPeriodEnd::Inclusive => sigint_inbox_item::Column::Datetime
                .lte(dt_from_millis(till_ms)?),
            ReportPeriodEnd::NonInclusive => {
                sigint_inbox_item::Column::Datetime.lt(dt_from_millis(till_ms)?)
            }
        });
    let query = if let Some(scope) = scope {
        query
            .filter(scope.condition((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )))
            .filter(scope.condition((
                signal_message::Entity,
                signal_message::Column::Id,
            )))
    } else {
        query
    };
    let query = filter_selected_senders(query, &req.selected_senders)?;
    let query = filter_selected_freqs(query, &req.selected_freqs)?;
    let query = filter_selected_posts(query, &req.selected_posts)?;
    let query = filter_selected_units(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let query = filter_selected_locations(
        query,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let query = filter_selected_callsigns_for_source(
        query,
        &req.selected_callsigns,
        callsign_source,
        scope,
    )?;
    let query = filter_search(query, &req.search)?;
    let query =
        filter_selected_device_names(query, &req.selected_device_names)?;
    let query = match callsign_source {
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres => {
            filter_selected_tags(
                query,
                &req.selected_tags,
                &req.denied_tags,
                &req.tag_presence,
                &req.or_bookmarked,
                &req.or_important,
                &req.or_with_coords,
                &req.or_without_coords,
                &req.or_with_extended_form,
                &req.filter_tags_option,
                &req.without_model_tags,
                user_id,
                req.report_tags_only_this_unit.unwrap_or(false),
            )?
        }
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics => {
            let analytics_tag_access = analytics_tag_access.context(h!())?;
            filter_selected_tags_analytics(
                query,
                &req.selected_tags,
                &req.denied_tags,
                &req.tag_presence,
                &req.or_bookmarked,
                &req.or_important,
                &req.or_with_coords,
                &req.or_without_coords,
                &req.or_with_extended_form,
                &req.filter_tags_option,
                &req.without_model_tags,
                user_id,
                req.report_tags_only_this_unit.unwrap_or(false),
                &analytics_tag_access.accessible_tag_ids,
                &analytics_tag_access.unit_login_ids,
                scope,
            )?
        }
    };
    let query = if include_aor_filter {
        filter_selected_aors(query, &req.selected_aors).c(h!())?
    } else {
        query
    };
    let query = filter_selected_networks(
        query,
        &req.selected_networks,
        &req.without_network,
    )
    .c(h!())?;
    let query = filter_selected_metadata_for_analysis_stats(query, req)?;
    Ok(match callsign_source {
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres => {
            query.distinct()
        }
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics => query,
    })
}

fn filter_selected_callsigns_for_source<Q>(
    query: Q,
    selected_callsigns: &Option<Vec<String>>,
    callsign_source: crate::inbox::callsigns::EffectiveCallsignSqlSource,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect,
{
    let Some(selected_callsigns) = selected_callsigns
        .as_ref()
        .filter(|callsigns| !callsigns.is_empty())
    else {
        return Ok(query);
    };
    match callsign_source {
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres => {
            filter_selected_callsigns(query, &Some(selected_callsigns.clone()))
        }
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics => {
            let callsign_alias = Alias::new("new_callsign_filter");
            let mut query = query;
            QuerySelect::query(&mut query).join_as(
                JoinType::InnerJoin,
                (
                    Alias::new("echo_clickhouse_derived"),
                    Alias::new("message_callsign"),
                ),
                callsign_alias.clone(),
                Condition::all()
                    .add(
                        Expr::col((
                            callsign_alias.clone(),
                            Alias::new("sigint_inbox_item_id"),
                        ))
                        .equals((
                            sigint_inbox_item::Entity,
                            sigint_inbox_item::Column::Id,
                        )),
                    )
                    .add(
                        Expr::col((
                            callsign_alias.clone(),
                            Alias::new("callsign"),
                        ))
                        .is_in(selected_callsigns.clone()),
                    ),
            );
            if let Some(scope) = scope {
                QuerySelect::query(&mut query).cond_where(scope.condition((
                    callsign_alias,
                    Alias::new("sigint_inbox_item_id"),
                )));
            }
            Ok(query)
        }
    }
}

fn effective_callsign_values_statement(
    query: Select<signal_message::Entity>,
) -> Statement {
    new_callsign_statement(
        query,
        r#"
SELECT DISTINCT all_callsigns.callsign
FROM all_callsigns
ORDER BY all_callsigns.callsign
"#,
    )
}

fn new_callsign_counts_statement(
    query: Select<signal_message::Entity>,
) -> Statement {
    new_callsign_statement(
        query,
        r#"
SELECT
    all_callsigns.callsign,
    COUNT(*) AS message_count
FROM all_callsigns
GROUP BY all_callsigns.callsign
ORDER BY all_callsigns.callsign
"#,
    )
}

fn new_callsign_last_seen_statement(
    query: Select<signal_message::Entity>,
) -> Statement {
    new_callsign_statement(
        query,
        r#"
SELECT
    all_callsigns.callsign,
    MAX(filtered_items.timestamp) AS last_seen
FROM all_callsigns
INNER JOIN filtered_items
    ON filtered_items.id = all_callsigns.inbox_item_id
GROUP BY all_callsigns.callsign
ORDER BY all_callsigns.callsign
"#,
    )
}

fn new_callsign_statement(
    query: Select<signal_message::Entity>,
    result_sql: &str,
) -> Statement {
    let filtered_items = query.build(DbBackend::Postgres);
    let values = filtered_items
        .values
        .map(|values| values.0)
        .unwrap_or_default();
    let callsign_ctes =
        crate::inbox::callsigns::postgres_effective_callsign_ctes(
            &filtered_items.sql,
        );
    Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!("{callsign_ctes}\n{result_sql}"),
        values,
    )
}

fn classify_new_callsigns(
    callsigns_in_period: BTreeSet<String>,
    callsign_last_seen: &BTreeMap<String, NaiveDateTime>,
    report_since: NaiveDateTime,
) -> NewCallsignsRes {
    let not_seen_since = |duration: chrono::Duration| {
        callsigns_in_period
            .iter()
            .filter(|callsign| {
                callsign_last_seen.get(*callsign).is_none_or(|last_seen| {
                    *last_seen <= report_since - duration
                })
            })
            .cloned()
            .collect()
    };
    NewCallsignsRes {
        not_seen_24h: not_seen_since(chrono::Duration::hours(24)),
        not_seen_7days: not_seen_since(chrono::Duration::days(7)),
        not_seen_30days: not_seen_since(chrono::Duration::days(30)),
    }
}

#[post("/api/rer/message/comments-batch")]
pub async fn batch_message_comments(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BatchMessageCommentsReq>,
) -> Result<Json<MessageComments>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let message_ids: Vec<i64> =
        req.messages.iter().map(|m| m.message_id).collect();
    let comments = batch_message_comments_bl(&env.dbx, &login, &message_ids)
        .await
        .c(h!())?;
    Ok(Json(comments))
}

pub async fn batch_message_comments_bl(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    message_ids: &[i64],
) -> Result<MessageComments, AppError> {
    let message_ids = accessible_message_ids(dbx, login, message_ids)
        .await
        .c(h!())?;
    let editable_comment_logins =
        editable_comment_logins(dbx, login).await.c(h!())?;
    let comments = crate::sigint::comments::find_linked_message_comments(
        dbx,
        &message_ids,
    )
    .await
    .c(h!())?
    .into_iter()
    .filter(|comment| comment.legacy_comment_id.is_some())
    .collect::<Vec<_>>();
    let login_names = crate::users::login_names_by_ids(
        dbx,
        comments
            .iter()
            .filter_map(|comment| comment.login_id)
            .collect(),
    )
    .await
    .c(h!())?;
    let mut res: BTreeMap<i64, Vec<MessageComment>> = BTreeMap::new();
    let post_names = linked_comment_post_names(dbx, &comments).await.c(h!())?;
    for comment in comments {
        if comment.post_id.is_none()
            && comment.login_id.is_some_and(|login_id| {
                editable_comment_logins.contains(&login_id)
            })
        {
            continue;
        }
        let message_id = comment.source_message_id;
        res.entry(message_id).or_default().push(
            message_comment_from_linked_message(
                comment,
                &login_names,
                &post_names,
            ),
        );
    }
    let data = res
        .iter()
        .map(|(id, comments)| MessageCommentEntry {
            message_id: *id,
            comments: comments.clone(),
        })
        .collect();
    Ok(MessageComments { data })
}

async fn linked_comment_post_names(
    dbx: &DatabaseConnection,
    comments: &[crate::sigint::comments::LinkedMessageComment],
) -> Result<HashMap<i64, String>, AppError> {
    let post_ids = comments
        .iter()
        .filter_map(|comment| comment.post_id)
        .collect::<Vec<_>>();
    if post_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(sigint_post::Entity::find()
        .filter(sigint_post::Column::Id.is_in(post_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|post| (post.id, post.name))
        .collect())
}

fn message_comment_from_linked_message(
    comment: crate::sigint::comments::LinkedMessageComment,
    login_names: &HashMap<uuid::Uuid, String>,
    post_names: &HashMap<i64, String>,
) -> MessageComment {
    let login = comment
        .login_id
        .and_then(|login_id| login_names.get(&login_id).cloned())
        .unwrap_or_default();
    MessageComment {
        message_id: comment.source_message_id,
        id: comment.intel_message_id,
        comment: comment.comment,
        login,
        sigint_post_name: comment
            .post_id
            .and_then(|post_id| post_names.get(&post_id).cloned()),
    }
}

async fn editable_comment_logins(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
) -> Result<HashSet<uuid::Uuid>, AppError> {
    let mut logins = crate::users::get_organism_login_ids_by_id(dbx, login)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    logins.insert(*login);
    Ok(logins)
}

async fn accessible_message_ids(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    message_ids: &[i64],
) -> Result<Vec<i64>, AppError> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;
    let organism_logins =
        crate::users::get_organism_login_ids_by_id(dbx, login)
            .await
            .c(h!())?;
    let owner_logins = organism_logins
        .into_iter()
        .chain(std::iter::once(*login))
        .map(|login| login.to_string())
        .collect::<Vec<_>>();
    let has_group = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .to_owned();
    let owner_access = Condition::all()
        .add(signal_message::Column::DatasourceGroupId.is_null())
        .add(Expr::exists(has_group).not())
        .add(preferred_message_author_expr(None).is_in(owner_logins));

    let parent_group_access = Query::select()
        .expr(Expr::value(1))
        .from(signal_message_group::Entity)
        .and_where(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((
                intel_product::Entity,
                intel_product::Column::SourceMessageId,
            )),
        )
        .and_where(
            signal_message_group::Column::GroupMasterKey
                .is_in(sigint_groups.clone()),
        )
        .to_owned();
    let parent_datasource_group_access = Query::select()
        .expr(Expr::value(1))
        .from(signal_message::Entity)
        .inner_join(
            datasource_group::Entity,
            Expr::col((
                signal_message::Entity,
                signal_message::Column::DatasourceGroupId,
            ))
            .equals((datasource_group::Entity, datasource_group::Column::Id)),
        )
        .and_where(
            Expr::col((signal_message::Entity, signal_message::Column::Id))
                .equals((
                    intel_product::Entity,
                    intel_product::Column::SourceMessageId,
                )),
        )
        .and_where(
            datasource_group::Column::GroupMasterKey
                .is_in(sigint_groups.clone()),
        )
        .to_owned();
    let parent_access = Query::select()
        .expr(Expr::value(1))
        .from(intel_product::Entity)
        .and_where(intel_product::relation_kind_eq(
            intel_product::RELATION_KIND_REPORT,
        ))
        .and_where(
            Expr::col((
                intel_product::Entity,
                intel_product::Column::IntelMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .and_where(
            Condition::any()
                .add(Expr::exists(parent_group_access))
                .add(Expr::exists(parent_datasource_group_access))
                .into(),
        )
        .to_owned();

    Ok(signal_message::Entity::find()
        .select_only()
        .distinct()
        .column(signal_message::Column::Id)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()))
        .filter(
            Condition::any()
                .add(
                    signal_message_group::Column::GroupMasterKey
                        .eq_any(sigint_groups),
                )
                .add(Expr::exists(parent_access))
                .add(owner_access),
        )
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

#[post("/api/rer/message/comments")]
pub async fn message_comments(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MessageCommentsReq>,
) -> Result<Json<Vec<MessageComment>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let accessible_message_ids =
        accessible_message_ids(&env.dbx, &login, &[req.message_id])
            .await
            .c(h!())?;
    if !accessible_message_ids.contains(&req.message_id) {
        return Err(AppError::NotFound);
    }
    let comments = crate::sigint::comments::find_linked_message_comments(
        &env.dbx,
        &[req.message_id],
    )
    .await
    .c(h!())?
    .into_iter()
    .filter(|comment| comment.legacy_comment_id.is_some())
    .collect::<Vec<_>>();
    let login_names = crate::users::login_names_by_ids(
        &env.dbx,
        comments
            .iter()
            .filter_map(|comment| comment.login_id)
            .collect(),
    )
    .await
    .c(h!())?;
    let editable_comment_logins =
        editable_comment_logins(&env.dbx, &login).await.c(h!())?;
    let post_names = linked_comment_post_names(&env.dbx, &comments)
        .await
        .c(h!())?;
    let mut res = vec![];
    for comment in comments {
        if comment.post_id.is_none()
            && comment.login_id.is_some_and(|login_id| {
                editable_comment_logins.contains(&login_id)
            })
        {
            continue;
        }
        res.push(message_comment_from_linked_message(
            comment,
            &login_names,
            &post_names,
        ));
    }
    Ok(Json(res))
}

#[post("/api/rer/analysis/message-draft-events")]
pub async fn message_draft_events(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DraftCommentEventsReq>,
) -> Result<HttpResponse, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let server_ts_ms = chrono::Utc::now().timestamp_millis();
    for event in req.events.iter() {
        let comment_preview: String =
            event.value.replace('\n', " ").chars().take(500).collect();
        let comment_to_log = if event.value.len() > comment_preview.len() {
            format!("{comment_preview}…")
        } else {
            comment_preview
        };

        info!(
            target: "comment_draft",
            "COMMENT_DRAFT_EVENT login={} message_id={} event_id={} created_at_ms={} server_ts_ms={} len={} text={}",
            login,
            event.message_id,
            event.id,
            event.created_at_ms,
            server_ts_ms,
            event.value.len(),
            comment_to_log
        );
    }

    Ok(HttpResponse::Ok().finish())
}

/// STATS
#[post("/api/rer/analysis/activity-daily")]
pub async fn activity_daily(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<crate::sigint::freq::types::FreqDailyActivityCount>, AppError>
{
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let accessible_groups =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let analytics_groups = accessible_groups.clone();
    let postgres_groups = accessible_groups;
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_db = &env.dbx;
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let rows = with_analytics_read_fallback(
        env.get_ref(),
        "analysis activity daily",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                freshness_max_age_ms,
            )
            .await?;
            stats::fetch_daily_group_activity_with_db(
                &analytics_req.0,
                analytics_user,
                &db,
                analytics_groups,
                Some(&scope),
            )
            .await
        },
        |_db| async move {
            stats::fetch_daily_group_activity_with_db(
                &postgres_req.0,
                postgres_user,
                postgres_db,
                postgres_groups,
                None,
            )
            .await
        },
    )
    .await
    .context(h!())?;

    let mut data_per_date = BTreeMap::new();
    for row in rows {
        let date = row.msg_date.to_string();
        let mut activity = data_per_date.remove(&date).unwrap_or(
            crate::sigint::freq::types::FreqDailyGroupActivityCount {
                count_by_group_name: BTreeMap::new(),
            },
        );
        activity.count_by_group_name.insert(row.group, row.value);
        data_per_date.insert(date, activity);
    }

    trace!("analysis activity daily requested by {login}");
    Ok(Json(crate::sigint::freq::types::FreqDailyActivityCount {
        data_per_date,
    }))
}

#[post("/api/rer/analysis/callsign-relations")]
pub async fn callsign_relations(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<
    Json<crate::sigint::network::types::NetworkCallsignRelationsRsp>,
    AppError,
> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    if dt_till - dt_since
        > chrono::Duration::days(ANALYSIS_CALLSIGN_GRAPH_MAX_DAYS)
    {
        return Err(AppError::BL {
            msg: format!(
                "Для графа оберіть період не довший за {ANALYSIS_CALLSIGN_GRAPH_MAX_DAYS} днів."
            ),
        });
    }
    let accessible_groups =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let analytics_groups = accessible_groups.clone();
    let postgres_groups = accessible_groups;
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_db = &env.dbx;
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let messages = with_analytics_read_fallback(
        env.get_ref(),
        "analysis callsign relations",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                freshness_max_age_ms,
            )
            .await?;
            stats::fetch_callsign_relation_messages_with_db(
                &analytics_req.0,
                None,
                analytics_user,
                &db,
                analytics_groups,
                Some(&scope),
                Some(ANALYSIS_CALLSIGN_GRAPH_MESSAGE_LIMIT + 1),
            )
            .await
        },
        |_db| async move {
            stats::fetch_callsign_relation_messages_with_db(
                &postgres_req.0,
                None,
                postgres_user,
                postgres_db,
                postgres_groups,
                None,
                Some(ANALYSIS_CALLSIGN_GRAPH_MESSAGE_LIMIT + 1),
            )
            .await
        },
    )
    .await
    .context(h!())?;

    if messages.len() > ANALYSIS_CALLSIGN_GRAPH_MESSAGE_LIMIT as usize {
        return Err(AppError::BL {
            msg: format!(
                "Граф містить понад {ANALYSIS_CALLSIGN_GRAPH_MESSAGE_LIMIT} повідомлень. Звузьте період або додайте фільтри."
            ),
        });
    }
    let relations =
        crate::sigint::network::relations::aggregate_unenriched_callsign_relations(
            messages,
        );
    if relations.nodes.len() > ANALYSIS_CALLSIGN_GRAPH_NODE_LIMIT
        || relations.edges.len() > ANALYSIS_CALLSIGN_GRAPH_EDGE_LIMIT
    {
        return Err(AppError::BL {
            msg: format!(
                "Граф перевищує безпечний розмір: максимум {ANALYSIS_CALLSIGN_GRAPH_NODE_LIMIT} позивних і {ANALYSIS_CALLSIGN_GRAPH_EDGE_LIMIT} зв'язків. Додайте фільтри."
            ),
        });
    }

    Ok(Json(relations))
}

#[post("/api/rer/analysis/callsign-frequency-matches")]
pub async fn callsign_frequency_matches(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisCallsignFrequencyMatchesReq>,
) -> Result<Json<AnalysisCallsignFrequencyMatchesRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let selected_callsign_count = req
        .callsigns
        .iter()
        .map(|callsign| callsign.trim().to_uppercase())
        .filter(|callsign| !callsign.is_empty())
        .collect::<HashSet<_>>()
        .len();
    if selected_callsign_count == 0
        || std::cmp::max(req.min_matches, 1) as usize > selected_callsign_count
    {
        return Ok(Json(AnalysisCallsignFrequencyMatchesRsp {
            frequencies: Vec::new(),
        }));
    }
    let search_req = stats::callsign_frequency_match_search_req(&req.req);
    let accessible_groups =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let analytics_groups = accessible_groups.clone();
    let postgres_groups = accessible_groups;
    let analytics_req = &search_req;
    let postgres_req = &search_req;
    let analytics_callsigns = &req.callsigns;
    let postgres_callsigns = &req.callsigns;
    let min_matches = req.min_matches;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_db = &env.dbx;
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let frequencies = with_analytics_read_fallback(
        env.get_ref(),
        "analysis callsign frequency matches",
        analytics_stats_request_supported(&search_req, env.get_ref()),
        |db| async move {
            let scope = stats::resolve_analytics_message_id_scope(
                analytics_req,
                &db,
                freshness_max_age_ms,
            )
            .await?;
            stats::fetch_callsign_frequency_matches_with_db(
                analytics_req,
                analytics_callsigns,
                min_matches,
                analytics_user,
                &db,
                analytics_groups,
                Some(&scope),
            )
            .await
        },
        |_db| async move {
            stats::fetch_callsign_frequency_matches_with_db(
                postgres_req,
                postgres_callsigns,
                min_matches,
                postgres_user,
                postgres_db,
                postgres_groups,
                None,
            )
            .await
        },
    )
    .await
    .context(h!())?;

    Ok(Json(AnalysisCallsignFrequencyMatchesRsp { frequencies }))
}

/// STATS
#[post("/api/rer/analysis/stats/groups")]
async fn group_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<GroupStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let is_admin = has_role(&env.dbx, &login_id_from_identity(&user)?, "Admin")
        .await
        .is_ok();
    let login = login_id_from_identity(&user)?;
    let master_keys_noimport =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let login_obj = login::Entity::find()
        .filter(login::Column::Id.eq(login))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;
    let master_keys_noimport_count = master_keys_noimport.len();
    let analytics_master_keys = master_keys_noimport.clone();
    let postgres_master_keys = master_keys_noimport.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let include_missing_groups = should_include_missing_secret_groups(&req);
    let analytics_source_db = env.dbx.clone();
    let (groups, analytics_group_stats) = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats groups",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            let groups = stats::fetch_groups_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys.clone(),
                Some(&message_id_scope),
                None,
            )
            .await?;
            let group_activity_keys = if include_missing_groups {
                analytics_master_keys
            } else {
                groups
                    .iter()
                    .map(|group| group.master_key.clone())
                    .collect()
            };
            let group_stats = stats::fetch_group_activity_stats_with_db(
                &db,
                group_activity_keys,
            )
            .await?;
            Ok((groups, Some(group_stats)))
        },
        |_db| async move {
            let groups = stats::fetch_groups(
                postgres_req,
                postgres_user,
                postgres_env,
                postgres_master_keys,
            )
            .await?;
            Ok((groups, None))
        },
    )
    .await
    .context(h!())?;
    let groups = if include_missing_groups {
        include_missing_secret_groups(&env.dbx, groups, &master_keys_noimport)
            .await
            .context(h!())?
    } else {
        groups
    };
    let group_names = collect_group_names(
        &groups,
        &env.dbx,
        is_admin,
        analytics_group_stats.as_ref(),
    )
    .await
    .context(h!())?;
    debug!(
        "User: {} has groups num: master_keys - {master_keys_noimport_count}, via fetch_groups - {}, in group_names - {}; organism id: {:?}",
        &login,
        groups.len(),
        group_names.len(),
        login_obj.organism_id
    );
    Ok(Json(GroupStatsRsp {
        groups,
        group_names,
    }))
}

async fn include_missing_secret_groups(
    dbx: &DatabaseConnection,
    groups: Vec<AnalysisStatsGroup>,
    allowed_group_keys: &[String],
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    if allowed_group_keys.is_empty() {
        return Ok(groups);
    }

    let existing_keys = groups
        .iter()
        .map(|group| group.master_key.clone())
        .collect::<HashSet<_>>();
    let mut groups = groups;

    let secret_group_keys = signal_group::Entity::find()
        .select_only()
        .column(signal_group::Column::MasterKey)
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::IsSecret.eq(true))
        .filter(
            signal_group::Column::MasterKey.eq_any(allowed_group_keys.to_vec()),
        )
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?;

    for key in secret_group_keys {
        if !existing_keys.contains(&key) {
            groups.push(AnalysisStatsGroup {
                master_key: key,
                count: 0,
            });
        }
    }

    Ok(groups)
}

fn should_include_missing_secret_groups(req: &AnalysisStatsReq) -> bool {
    req.selected_aors
        .as_ref()
        .map(|aors| aors.is_empty())
        .unwrap_or(true)
}

#[post("/api/rer/analysis/stats/senders")]
async fn sender_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<SenderStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys: Vec<String> = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let analytics_env = env.get_ref();
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let senders = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats senders",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            stats::fetch_senders_raw_with_db(
                analytics_req,
                analytics_user,
                analytics_env,
                &db,
                analytics_master_keys,
                analytics_freshness_max_age_ms,
            )
            .await
        },
        |_db| async move {
            stats::fetch_senders(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    let sender_names = collect_sender_names(&senders, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(SenderStatsRsp {
        senders,
        sender_names,
    }))
}

#[post("/api/rer/analysis/stats/posts")]
async fn post_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<PostStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_source_db = env.dbx.clone();
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let posts = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats posts",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_posts_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_posts(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(PostStatsRsp { posts }))
}

#[post("/api/rer/analysis/stats/freqs")]
async fn freq_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<FreqStatsRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await?;
    let login = login_id_from_identity(&user)?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let freqs = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats freqs",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            stats::fetch_freqs_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                analytics_freshness_max_age_ms,
            )
            .await
        },
        |_db| async move {
            stats::fetch_freqs(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(FreqStatsRsp { freqs }))
}

#[post("/api/rer/analysis/stats/callsigns")]
async fn callsign_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<CallsignStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let callsigns = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats callsigns",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_callsigns_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_callsigns(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(CallsignStatsRsp { callsigns }))
}

#[post("/api/rer/analysis/stats/metadata")]
async fn metadata_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<MetadataStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let metadata = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats metadata",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_metadata_stats_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_metadata_stats(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(metadata))
}

#[post("/api/rer/analysis/stats/tags")]
async fn tag_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<TagStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let analytics_tag_access =
        resolve_analytics_tag_access_if_enabled(&env, &req, &login).await?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let tags = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats tags",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_tags_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                analytics_tag_access.as_ref().c(h!())?,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_tags(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(TagStatsRsp { tags }))
}

#[post("/api/rer/analysis/stats/units")]
async fn unit_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<UnitStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let units = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats units",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_units_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_units(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(UnitStatsRsp { units }))
}

#[post("/api/rer/analysis/stats/locations")]
async fn location_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<LocationStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let analytics_source_db = env.dbx.clone();
    let locations = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats locations",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_locations_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_locations(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .map(merge_locations)
    .c(h!())?;
    Ok(Json(LocationStatsRsp { locations }))
}

/// Отримання доступних значень для фільтра смуг відповідальності (AORs) зі статистикою.
///
/// # API URL
/// - POST: /api/sigint/network-list
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<AnalysisStatsReq>`] - де [`AnalysisStatsReq`] Тіло запиту, що містить параметри для фільтрації для доступних смуг відповідальності
///
/// # Повертає
///
/// [`Json<Vec<AreaOfResponsibilityStatsRsp>>`], де [`AreaOfResponsibilityStatsRsp`] - це структура, що представляє доступні смуги та статистику повідомлень по ним
///
#[post("/api/rer/analysis/stats/aors")]
async fn aor_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<AreaOfResponsibilityStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let aors = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats aors",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_aors_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_aors(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    let aor_names = collect_aor_names(&aors, &env.dbx).await.context(h!())?;
    Ok(Json(AreaOfResponsibilityStatsRsp { aors, aor_names }))
}

async fn fetch_locations(
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    req: &Json<AnalysisStatsReq>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    Ok(merge_locations(
        stats::fetch_locations(req, user, env, master_keys)
            .await
            .context(h!())?,
    ))
}

fn merge_locations(
    locations: Vec<AnalysisStatsLocation>,
) -> Vec<AnalysisStatsLocation> {
    let mut locations_map = BTreeMap::new();
    locations.into_iter().for_each(|stat| {
        let location = stat.location;
        let old_count = locations_map.get(&location).unwrap_or(&0);
        let count = old_count + stat.count;
        locations_map.insert(location, count);
    });
    locations_map
        .into_iter()
        .map(|(location, count)| AnalysisStatsLocation { location, count })
        .collect_vec()
}

/// Отримання доступних значень для фільтра мереж зі статистикою.
///
/// # API URL
/// - POST: /api/rer/analysis/stats/networks
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<AnalysisStatsReq>`] - де [`AnalysisStatsReq`] Тіло запиту, що містить параметри для фільтрації для доступних смуг відповідальності
///
/// # Повертає
///
/// [`Json<Vec<AreaOfResponsibilityStatsRsp>>`], де [`AreaOfResponsibilityStatsRsp`] - це структура, що представляє доступні смуги та статистику повідомлень по ним
///
#[post("/api/rer/analysis/stats/networks")]
async fn network_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<NetworkStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_tag_access =
        resolve_analytics_tag_access_if_enabled(&env, &req, &login).await?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let networks = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats networks",
        analytics_stats_request_supported(&req, env.get_ref()),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::fetch_networks_analytics_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                analytics_tag_access.as_ref().c(h!())?,
                &message_id_scope,
            )
            .await
        },
        |_db| async move {
            stats::fetch_networks(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    let network_names = collect_network_names(&networks, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(NetworkStatsRsp {
        networks,
        network_names,
    }))
}

async fn collect_network_names(
    networks: &[AnalysisStatsNetwork],
    txn: &DatabaseConnection,
) -> Result<Vec<NetworkEntry>, AppError> {
    let network_ids: Vec<i64> = networks
        .iter()
        .map(|x| x.network_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let query = sigint_network::Entity::find()
        .select_only()
        .column(sigint_network::Column::Id)
        .column(sigint_network::Column::Name)
        .column_as(Expr::cust("STRING_AGG(sigint_unit.name, ', ')"), "units")
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Id.eq_any(network_ids))
        .group_by(sigint_network::Column::Id)
        .group_by(sigint_network::Column::Name);

    #[derive(Debug, FromQueryResult)]
    pub struct NetworkResult {
        pub id: i64,
        pub name: String,
        pub units: Option<String>,
    }

    let networks: Vec<NetworkResult> = query
        .into_model::<NetworkResult>()
        .all(txn)
        .await
        .context(h!())?;

    Ok(networks
        .into_iter()
        .map(|n| NetworkEntry {
            id: n.id,
            name: format!("{} {}", n.name, n.units.unwrap_or_default()),
        })
        .collect())
}

#[post("/api/rer/analysis/stats/count")]
async fn count_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<CountStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let master_keys = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let master_keys_noimport = master_keys.clone();

    let access = CountStatsAccess {
        master_keys,
        master_keys_noimport,
    };
    let analytics_config = env.config.analytics.as_ref();
    let analytics = if analytics_count_request_supported(&req) {
        env.analytics.as_ref()
    } else {
        trace!(
            "analysis stats count uses PostgreSQL for an unsupported analytics filter"
        );
        None
    };
    let analytics_tag_access = if analytics.is_some() {
        Some(
            stats::resolve_analytics_tag_access(
                &env.dbx,
                &login,
                req.report_tags_only_this_unit.unwrap_or(false),
            )
            .await?,
        )
    } else {
        None
    };
    let analytics_retry_state = analytics.map(|analytics| {
        analytics_retry_state(analytics, "analysis stats count")
    });
    let analytics_attempt = analytics
        .zip(analytics_retry_state.as_deref())
        .and_then(|(analytics, retry_state)| {
            analytics_retry_attempt(retry_state)
                .map(|retry_attempt| (analytics, retry_attempt))
        });
    let freshness_max_age_ms = analytics_config
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let analytics_query = analytics_attempt.zip(analytics_tag_access).map(
        |((analytics, _), analytics_tag_access)| {
            query_count_stats_raw(
                &req,
                &user,
                &env,
                &analytics.conn,
                access.clone(),
                analytics_tag_access,
                freshness_max_age_ms,
            )
        },
    );
    let timeout_ms = analytics_config
        .map(AnalyticsConfig::query_timeout_ms)
        .unwrap_or(ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT);
    let retry_cooldown_ms = analytics_config
        .map(AnalyticsConfig::retry_cooldown_ms)
        .unwrap_or(ANALYTICS_RETRY_COOLDOWN_MS_DEFAULT);
    let postgres_query = query_count_stats_postgres(&req, &user, &env, access);
    let response = with_count_stats_analytics_fallback(
        analytics_query,
        core::time::Duration::from_millis(timeout_ms),
        postgres_query,
        analytics_attempt.map(|(_, retry_attempt)| retry_attempt),
        core::time::Duration::from_millis(retry_cooldown_ms),
    )
    .await?;

    Ok(Json(response))
}

fn analytics_count_request_supported(_req: &AnalysisStatsReq) -> bool {
    true
}

fn analytics_summary_table_request_supported(req: &AnalysisStatsReq) -> bool {
    analytics_count_request_supported(req)
}

fn analytics_stats_request_supported(
    req: &AnalysisStatsReq,
    env: &Env,
) -> bool {
    analytics_count_request_supported(req)
        && req.selected_units.as_ref().is_none_or(Vec::is_empty)
        && !crate::stats::should_prefer_redis_stats(req, &env.config)
}

async fn resolve_analytics_tag_access_if_enabled(
    env: &actix_web::web::Data<Env>,
    req: &AnalysisStatsReq,
    login: &uuid::Uuid,
) -> Result<Option<stats::AnalyticsTagAccess>, AppError> {
    if env.analytics.is_none() || !analytics_count_request_supported(req) {
        return Ok(None);
    }
    Ok(Some(
        stats::resolve_analytics_tag_access(
            &env.dbx,
            login,
            req.report_tags_only_this_unit.unwrap_or(false),
        )
        .await?,
    ))
}

pub(crate) fn analytics_inbox_request_supported(
    req: &InboxMessagesReq,
) -> bool {
    analytics_inbox_filter_supported(req)
        && !crate::rer_importer::inbox::query::inbox_request_is_unbounded(req)
}

pub(crate) fn analytics_inbox_candidates_supported(
    req: &InboxMessagesReq,
) -> bool {
    analytics_inbox_request_supported(req) && req.nolimit != Some(true)
}

fn analytics_inbox_filter_supported(req: &InboxMessagesReq) -> bool {
    req.only_with_media != Some(true)
}

#[derive(Clone)]
struct CountStatsAccess {
    master_keys: Vec<String>,
    master_keys_noimport: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AnalyticsRetryAttemptKind {
    Closed,
    HalfOpen,
}

#[derive(Clone, Copy)]
struct AnalyticsRetryAttempt<'a> {
    retry_state: &'a AtomicU64,
    kind: AnalyticsRetryAttemptKind,
}

struct AnalyticsRetryCancellationGuard<'a> {
    retry_state: &'a AtomicU64,
    releases_half_open_attempt: bool,
}

impl Drop for AnalyticsRetryCancellationGuard<'_> {
    fn drop(&mut self) {
        if self.releases_half_open_attempt {
            let _ = self.retry_state.compare_exchange(
                u64::MAX,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
}

impl AnalyticsRetryAttempt<'_> {
    fn cancellation_guard(&self) -> AnalyticsRetryCancellationGuard<'_> {
        AnalyticsRetryCancellationGuard {
            retry_state: self.retry_state,
            releases_half_open_attempt: self.kind
                == AnalyticsRetryAttemptKind::HalfOpen,
        }
    }

    fn record_success(self) {
        if self.kind == AnalyticsRetryAttemptKind::HalfOpen {
            let _ = self.retry_state.compare_exchange(
                u64::MAX,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    fn record_failure(self, retry_cooldown: core::time::Duration) {
        let expected = match self.kind {
            AnalyticsRetryAttemptKind::Closed => 0,
            AnalyticsRetryAttemptKind::HalfOpen => u64::MAX,
        };
        let _ = self.retry_state.compare_exchange(
            expected,
            analytics_retry_deadline(retry_cooldown),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

async fn with_count_stats_analytics_fallback<T, A, P>(
    analytics_query: Option<A>,
    timeout: core::time::Duration,
    postgres_query: P,
    retry_attempt: Option<AnalyticsRetryAttempt<'_>>,
    retry_cooldown: core::time::Duration,
) -> Result<T, AppError>
where
    A: std::future::Future<Output = Result<T, AppError>>,
    P: std::future::Future<Output = Result<T, AppError>>,
{
    let _retry_cancellation_guard = retry_attempt
        .as_ref()
        .map(AnalyticsRetryAttempt::cancellation_guard);
    if let Some(analytics_query) = analytics_query {
        let started = std::time::Instant::now();
        match tokio::time::timeout(timeout, analytics_query).await {
            Ok(Ok(response)) => {
                if let Some(retry_attempt) = retry_attempt {
                    retry_attempt.record_success();
                }
                trace!(
                    "analysis stats count used analytics in {:?}",
                    started.elapsed()
                );
                return Ok(response);
            }
            Ok(Err(err)) => warn!(
                "analysis stats count analytics query failed after {:?}, retrying via PostgreSQL: {:?}",
                started.elapsed(),
                err
            ),
            Err(_) => warn!(
                "analysis stats count analytics query timed out after {:?}, retrying via PostgreSQL",
                started.elapsed()
            ),
        }
        if let Some(retry_attempt) = retry_attempt {
            retry_attempt.record_failure(retry_cooldown);
        }
    }

    postgres_query.await.map_err(|error| {
        map_postgres_runtime_timeout(error, "analysis stats count")
    })
}

pub(crate) async fn with_analytics_read_fallback<T, A, AFut, P, PFut>(
    env: &Env,
    operation: &str,
    analytics_supported: bool,
    analytics_query: A,
    postgres_query: P,
) -> Result<T, AppError>
where
    A: FnOnce(DatabaseConnection) -> AFut,
    AFut: std::future::Future<Output = Result<T, AppError>>,
    P: FnOnce(DatabaseConnection) -> PFut,
    PFut: std::future::Future<Output = Result<T, AppError>>,
{
    with_analytics_read_fallback_inner(
        env,
        operation,
        analytics_supported,
        true,
        analytics_query,
        postgres_query,
    )
    .await
}

pub(crate) async fn with_internally_timed_analytics_read_fallback<
    T,
    A,
    AFut,
    P,
    PFut,
>(
    env: &Env,
    operation: &str,
    analytics_supported: bool,
    analytics_query: A,
    postgres_query: P,
) -> Result<T, AppError>
where
    A: FnOnce(DatabaseConnection) -> AFut,
    AFut: std::future::Future<Output = Result<T, AppError>>,
    P: FnOnce(DatabaseConnection) -> PFut,
    PFut: std::future::Future<Output = Result<T, AppError>>,
{
    with_analytics_read_fallback_inner(
        env,
        operation,
        analytics_supported,
        false,
        analytics_query,
        postgres_query,
    )
    .await
}

async fn with_analytics_read_fallback_inner<T, A, AFut, P, PFut>(
    env: &Env,
    operation: &str,
    analytics_supported: bool,
    use_configured_timeout: bool,
    analytics_query: A,
    postgres_query: P,
) -> Result<T, AppError>
where
    A: FnOnce(DatabaseConnection) -> AFut,
    AFut: std::future::Future<Output = Result<T, AppError>>,
    P: FnOnce(DatabaseConnection) -> PFut,
    PFut: std::future::Future<Output = Result<T, AppError>>,
{
    let analytics_retry_state = env
        .analytics
        .as_ref()
        .map(|analytics| analytics_retry_state(analytics, operation));
    let analytics_attempt = analytics_supported
        .then_some(env.analytics.as_ref())
        .flatten()
        .zip(analytics_retry_state.as_deref())
        .and_then(|(analytics, retry_state)| {
            analytics_retry_attempt(retry_state)
                .map(|retry_attempt| (analytics, retry_attempt))
        });

    if let Some((analytics, retry_attempt)) = analytics_attempt {
        let _retry_cancellation_guard = retry_attempt.cancellation_guard();
        let started = std::time::Instant::now();
        let analytics_config = env.config.analytics.as_ref();
        let timeout = core::time::Duration::from_millis(
            analytics_config
                .map(AnalyticsConfig::query_timeout_ms)
                .unwrap_or(ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT),
        );
        let freshness_max_age_ms = analytics_config
            .map(AnalyticsConfig::freshness_max_age_ms)
            .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
        let analytics_conn = analytics.conn.clone();
        let query = async move {
            ensure_analytics_fresh(&analytics_conn, freshness_max_age_ms)
                .await?;
            analytics_query(analytics_conn).await
        };

        let response = if use_configured_timeout {
            tokio::time::timeout(timeout, query).await.ok()
        } else {
            Some(query.await)
        };
        match response {
            Some(Ok(response)) => {
                retry_attempt.record_success();
                trace!("{operation} used analytics in {:?}", started.elapsed());
                return Ok(response);
            }
            Some(Err(err)) => warn!(
                "{operation} analytics query failed after {:?}, retrying via PostgreSQL: {:?}",
                started.elapsed(),
                err
            ),
            None => warn!(
                "{operation} analytics query timed out after {:?}, retrying via PostgreSQL",
                started.elapsed()
            ),
        }
        let retry_cooldown = core::time::Duration::from_millis(
            analytics_config
                .map(AnalyticsConfig::retry_cooldown_ms)
                .unwrap_or(ANALYTICS_RETRY_COOLDOWN_MS_DEFAULT),
        );
        retry_attempt.record_failure(retry_cooldown);
    } else if env.analytics.is_some() && !analytics_supported {
        trace!(
            "{operation} uses PostgreSQL for an unsupported analytics query"
        );
    }

    let started = std::time::Instant::now();
    let response = postgres_query(env.replica())
        .await
        .map_err(|error| map_postgres_runtime_timeout(error, operation))?;
    trace!("{operation} used PostgreSQL in {:?}", started.elapsed());
    Ok(response)
}

pub(crate) fn map_postgres_runtime_timeout(
    error: AppError,
    operation: &str,
) -> AppError {
    if !has_postgres_error_code(&error, "57014") {
        return error;
    }

    warn!(
        target: "postgres_runtime_timeout",
        "postgres_runtime_timeout operation={} postgres_sqlstate=57014",
        operation
    );
    AppError::ServiceUnavailable {
        msg: "Аналітичний запит перевищив допустимий час виконання. Спробуйте звузити параметри пошуку."
            .to_string(),
        retry_after_secs: 1,
    }
}

fn has_postgres_error_code(
    error: &(dyn StdError + 'static),
    code: &str,
) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(
            DbErr::Conn(sea_orm::RuntimeErr::SqlxError(sqlx_error))
            | DbErr::Exec(sea_orm::RuntimeErr::SqlxError(sqlx_error))
            | DbErr::Query(sea_orm::RuntimeErr::SqlxError(sqlx_error)),
        ) = error.downcast_ref::<DbErr>()
        {
            if let sqlx::Error::Database(database_error) = sqlx_error.as_ref() {
                if database_error.code().as_deref() == Some(code) {
                    return true;
                }
            }
        }
        if let Some(sqlx::Error::Database(database_error)) =
            error.downcast_ref::<sqlx::Error>()
        {
            if database_error.code().as_deref() == Some(code) {
                return true;
            }
        }
        source = error.source();
    }
    false
}

fn analytics_retry_attempt(
    retry_state: &AtomicU64,
) -> Option<AnalyticsRetryAttempt<'_>> {
    loop {
        let state = retry_state.load(Ordering::Acquire);
        if state == 0 {
            return Some(AnalyticsRetryAttempt {
                retry_state,
                kind: AnalyticsRetryAttemptKind::Closed,
            });
        }
        if state == u64::MAX || state > analytics_unix_ms() {
            return None;
        }
        if retry_state
            .compare_exchange(
                state,
                u64::MAX,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            return Some(AnalyticsRetryAttempt {
                retry_state,
                kind: AnalyticsRetryAttemptKind::HalfOpen,
            });
        }
    }
}

fn analytics_retry_state(
    analytics: &AnalyticsPool,
    operation: &str,
) -> Arc<AtomicU64> {
    analytics_retry_state_for_operation(
        &analytics.retry_after_unix_ms_by_operation,
        operation,
    )
}

fn analytics_retry_state_for_operation(
    retry_states: &RwLock<HashMap<String, Arc<AtomicU64>>>,
    operation: &str,
) -> Arc<AtomicU64> {
    if let Some(retry_state) = retry_states
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(operation)
        .cloned()
    {
        return retry_state;
    }

    retry_states
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(operation.to_string())
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone()
}

fn analytics_retry_deadline(retry_cooldown: core::time::Duration) -> u64 {
    let retry_cooldown_ms = <u64 as std::convert::TryFrom<u128>>::try_from(
        retry_cooldown.as_millis(),
    )
    .unwrap_or(u64::MAX);
    std::cmp::min(
        analytics_unix_ms().saturating_add(retry_cooldown_ms),
        u64::MAX - 1,
    )
}

fn analytics_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| {
            <u64 as std::convert::TryFrom<u128>>::try_from(duration.as_millis())
                .unwrap_or(u64::MAX)
        })
        .unwrap_or(0)
}

async fn query_count_stats_postgres(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    access: CountStatsAccess,
) -> Result<CountStatsRsp, AppError> {
    let started = std::time::Instant::now();
    let groups_count = query_count_stats_groups_postgres(
        req,
        user,
        env,
        access.master_keys_noimport.clone(),
    )
    .await?;
    let message_dimensions = query_count_stats_message_dimensions_postgres(
        req,
        user,
        env,
        access.master_keys.clone(),
    )
    .await?;
    let catalog_dimensions = query_count_stats_catalog_dimensions_postgres(
        req,
        user,
        env,
        access.master_keys.clone(),
    )
    .await?;
    let (count_overall, count_selected) =
        stats::fetch_counts(req, user, env, access.master_keys)
            .await
            .context(h!())?;
    trace!(
        "analysis stats count used PostgreSQL in {:?}",
        started.elapsed()
    );

    Ok(CountStatsRsp {
        count_overall,
        count_selected,
        groups_count,
        senders_count: message_dimensions.senders,
        freqs_count: message_dimensions.freqs,
        posts_count: message_dimensions.posts,
        callsigns_count: message_dimensions.callsigns,
        units_count: catalog_dimensions.units,
        units_exact_matches_count: catalog_dimensions.units_exact_matches,
        units_non_exact_matches_count: catalog_dimensions
            .units_non_exact_matches,
        locations_count: catalog_dimensions.locations,
        tags_count: catalog_dimensions.tags,
        aors_count: catalog_dimensions.aors,
        networks_count: catalog_dimensions.networks,
    })
}

async fn query_count_stats_raw(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    db: &DatabaseConnection,
    access: CountStatsAccess,
    analytics_tag_access: stats::AnalyticsTagAccess,
    freshness_max_age_ms: u64,
) -> Result<CountStatsRsp, AppError> {
    ensure_analytics_fresh(db, freshness_max_age_ms).await?;
    let message_id_scope = stats::resolve_analytics_message_id_scope(
        &req.0,
        db,
        freshness_max_age_ms,
    )
    .await?;
    let (exact_resolved_units, combined_resolved_units) =
        analytics_unit::resolve_analysis_unit_filter_variants_for_analytics(
            &env.dbx,
            &req.selected_units,
            Some(&message_id_scope),
        )
        .await
        .context(h!())?;
    let (resolved_units, alternate_resolved_units) =
        if req.units_exact_match_only.unwrap_or(false) {
            (exact_resolved_units, combined_resolved_units)
        } else {
            (combined_resolved_units, exact_resolved_units)
        };
    let groups_count = query_count_stats_groups(
        req,
        user,
        env,
        db,
        access.master_keys_noimport.clone(),
        Some(&message_id_scope),
        resolved_units.as_ref(),
    )
    .await?;
    let message_dimensions = query_count_stats_message_dimensions(
        req,
        user,
        env,
        db,
        access.master_keys.clone(),
        &message_id_scope,
        resolved_units.as_ref(),
    )
    .await?;
    let (count_overall, count_selected) = stats::fetch_counts_raw_with_db(
        req,
        user,
        env,
        db,
        access.master_keys.clone(),
        Some(&message_id_scope),
        resolved_units.as_ref(),
    )
    .await
    .context(h!())?;
    let catalog_dimensions = query_count_stats_catalog_dimensions(
        req,
        user,
        env,
        db,
        access.master_keys.clone(),
        &analytics_tag_access,
        &message_id_scope,
        count_selected,
        resolved_units.as_ref(),
        alternate_resolved_units.as_ref(),
    )
    .await?;

    Ok(CountStatsRsp {
        count_overall,
        count_selected,
        groups_count,
        senders_count: message_dimensions.senders,
        freqs_count: message_dimensions.freqs,
        posts_count: message_dimensions.posts,
        callsigns_count: message_dimensions.callsigns,
        units_count: catalog_dimensions.units,
        units_exact_matches_count: catalog_dimensions.units_exact_matches,
        units_non_exact_matches_count: catalog_dimensions
            .units_non_exact_matches,
        locations_count: catalog_dimensions.locations,
        tags_count: catalog_dimensions.tags,
        aors_count: catalog_dimensions.aors,
        networks_count: catalog_dimensions.networks,
    })
}

async fn ensure_analytics_fresh(
    db: &DatabaseConnection,
    freshness_max_age_ms: u64,
) -> Result<(), AppError> {
    let freshness_max_age_ms =
        <i64 as std::convert::TryFrom<u64>>::try_from(freshness_max_age_ms)
            .c(h!())?;
    let health = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
SELECT healthy
       AND checked_at >= CURRENT_TIMESTAMP
           - ($1::bigint * INTERVAL '1 millisecond') AS is_fresh
FROM public.echo_analytics_health
WHERE singleton
"#,
            [freshness_max_age_ms.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    let is_fresh: bool = health.try_get("", "is_fresh").c(h!())?;
    if !is_fresh {
        return Err(anyhow!(
            "analytics replication health is stale or unhealthy"
        )
        .into());
    }
    Ok(())
}

async fn query_count_stats_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    message_id_scope: Option<&AnalyticsMessageIdScope>,
    resolved_units: Option<&analytics_unit::ResolvedAnalyticsUnitFilters>,
) -> Result<i64, AppError> {
    let groups = stats::fetch_groups_raw_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys.clone(),
        message_id_scope,
        resolved_units,
    )
    .await
    .context(h!())?;
    let groups = if should_include_missing_secret_groups(req) {
        include_missing_secret_groups(db, groups, &master_keys)
            .await
            .context(h!())?
    } else {
        groups
    };
    Ok(groups.len() as i64)
}

async fn query_count_stats_groups_postgres(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let groups = stats::fetch_groups(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let groups = if should_include_missing_secret_groups(req) {
        include_missing_secret_groups(&env.dbx, groups, &master_keys)
            .await
            .context(h!())?
    } else {
        groups
    };
    Ok(groups.len() as i64)
}

struct CountStatsMessageDimensions {
    senders: i64,
    freqs: i64,
    posts: i64,
    callsigns: i64,
}

async fn query_count_stats_message_dimensions(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    message_id_scope: &AnalyticsMessageIdScope,
    resolved_units: Option<&analytics_unit::ResolvedAnalyticsUnitFilters>,
) -> Result<CountStatsMessageDimensions, AppError> {
    let senders = stats::count_senders_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys.clone(),
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;
    let freqs = stats::count_freqs_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys.clone(),
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;
    let posts = stats::count_posts_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys.clone(),
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;
    let callsigns = stats::count_callsigns_analytics_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys,
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;

    Ok(CountStatsMessageDimensions {
        senders,
        freqs,
        posts,
        callsigns,
    })
}

async fn query_count_stats_message_dimensions_postgres(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<CountStatsMessageDimensions, AppError> {
    let senders = stats::count_senders(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let freqs = stats::count_freqs(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let posts = stats::count_posts(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let callsigns = stats::count_callsigns(req, user, env, master_keys)
        .await
        .context(h!())?;

    Ok(CountStatsMessageDimensions {
        senders,
        freqs,
        posts,
        callsigns,
    })
}

struct CountStatsCatalogDimensions {
    units: i64,
    units_exact_matches: i64,
    units_non_exact_matches: i64,
    locations: i64,
    tags: i64,
    aors: i64,
    networks: i64,
}

async fn query_count_stats_catalog_dimensions(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &Env,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
    analytics_tag_access: &stats::AnalyticsTagAccess,
    message_id_scope: &AnalyticsMessageIdScope,
    count_selected: i64,
    resolved_units: Option<&analytics_unit::ResolvedAnalyticsUnitFilters>,
    alternate_resolved_units: Option<
        &analytics_unit::ResolvedAnalyticsUnitFilters,
    >,
) -> Result<CountStatsCatalogDimensions, AppError> {
    let units = stats::count_units_with_db(
        req,
        user,
        db,
        master_keys.clone(),
        Some(message_id_scope),
    )
    .await
    .context(h!())?;
    let selected_units = req
        .selected_units
        .as_ref()
        .filter(|selected_units| !selected_units.is_empty());
    let (units_exact_matches, units_non_exact_matches) =
        if selected_units.is_none() {
            (count_selected, 0)
        } else {
            stats::count_unit_exact_match_breakdown_raw_with_db(
                req,
                user,
                env,
                db,
                master_keys.clone(),
                Some(message_id_scope),
                count_selected,
                alternate_resolved_units,
            )
            .await
            .context(h!())?
        };
    let locations = stats::count_locations_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys.clone(),
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;
    let tags = stats::count_tags_analytics_with_db(
        req,
        user,
        db,
        master_keys.clone(),
        analytics_tag_access,
        Some(message_id_scope),
    )
    .await
    .context(h!())?;
    let aors = stats::count_aors_raw_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys.clone(),
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;
    let networks = stats::count_networks_analytics_with_db(
        req,
        user,
        db,
        &env.dbx,
        master_keys,
        analytics_tag_access,
        Some(message_id_scope),
        resolved_units,
    )
    .await
    .context(h!())?;

    Ok(CountStatsCatalogDimensions {
        units,
        units_exact_matches,
        units_non_exact_matches,
        locations,
        tags,
        aors,
        networks,
    })
}

async fn query_count_stats_catalog_dimensions_postgres(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<CountStatsCatalogDimensions, AppError> {
    let units = stats::count_units(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let (units_exact_matches, units_non_exact_matches) =
        stats::count_unit_exact_match_breakdown(
            req,
            user,
            env,
            master_keys.clone(),
        )
        .await
        .context(h!())?;
    let locations = stats::count_locations(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let tags = stats::count_tags(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let aors = stats::count_aors(req, user, env, master_keys.clone())
        .await
        .context(h!())?;
    let networks = stats::count_networks(req, user, env, master_keys)
        .await
        .context(h!())?;

    Ok(CountStatsCatalogDimensions {
        units,
        units_exact_matches,
        units_non_exact_matches,
        locations,
        tags,
        aors,
        networks,
    })
}

/// STATS
#[post("/api/rer/analysis/stats/groups/count")]
async fn group_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let master_keys_noimport =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys_noimport.clone();
    let postgres_master_keys = master_keys_noimport.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let groups_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats groups count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            query_count_stats_groups(
                analytics_req,
                analytics_user,
                postgres_env,
                &db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            query_count_stats_groups_postgres(
                postgres_req,
                postgres_user,
                postgres_env,
                postgres_master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(groups_count))
}

#[post("/api/rer/analysis/stats/senders/count")]
async fn sender_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys: Vec<String> = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_source_db = env.dbx.clone();
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let senders_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats senders count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_senders_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_senders(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(senders_count))
}

#[post("/api/rer/analysis/stats/posts/count")]
async fn post_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_source_db = env.dbx.clone();
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let posts_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats posts count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_posts_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_posts(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(posts_count))
}

#[post("/api/rer/analysis/stats/freqs/count")]
async fn freq_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await?;
    let login = login_id_from_identity(&user)?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_source_db = env.dbx.clone();
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let freqs_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats freqs count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_freqs_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_freqs(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(freqs_count))
}

#[post("/api/rer/analysis/stats/callsigns/count")]
async fn callsign_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_source_db = env.dbx.clone();
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let callsigns_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats callsigns count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_callsigns_analytics_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_callsigns(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(callsigns_count))
}

#[post("/api/rer/analysis/stats/tags/count")]
async fn tag_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let analytics_tag_access =
        resolve_analytics_tag_access_if_enabled(&env, &req, &login).await?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let tags_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats tags count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_tags_analytics_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                analytics_tag_access.as_ref().c(h!())?,
                Some(&message_id_scope),
            )
            .await
        },
        |_db| async move {
            stats::count_tags(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(tags_count))
}

#[post("/api/rer/analysis/stats/units/count")]
async fn unit_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let units_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats units count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_units_with_db(
                analytics_req,
                analytics_user,
                &db,
                analytics_master_keys,
                Some(&message_id_scope),
            )
            .await
        },
        |_db| async move {
            stats::count_units(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(units_count))
}

#[post("/api/rer/analysis/stats/locations/count")]
async fn location_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let analytics_source_db = env.dbx.clone();
    let locations_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats locations count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_locations_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_locations(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(locations_count))
}

/// Отримання загальної кількості повідомлень по фільтру смуг відповідальності (AORs).
///
/// # API URL
/// - POST: /api/sigint/network-list
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<AnalysisStatsReq>`] - де [`AnalysisStatsReq`] Тіло запиту, що містить параметри для фільтрації для доступних смуг відповідальності
///
/// # Повертає
///
/// [`Json<Vec<i64>>`],  загальна кількість повідомлень по значенням фільтру смуг відповідальності (AORs)
#[post("/api/rer/analysis/stats/aors/count")]
async fn aor_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let analytics_source_db = env.dbx.clone();
    let aors_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats aors count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_aors_raw_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_aors(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(aors_count))
}
/// Отримання загальної кількості повідомлень по фільтру мереж.
///
/// # API URL
/// - POST: /api/analysis/stats/networks/count
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<AnalysisStatsReq>`] - де [`AnalysisStatsReq`] Тіло запиту, що містить параметри для фільтрації для доступних смуг відповідальності
///
/// # Повертає
///
/// [`Json<Vec<i64>>`],  загальна кількість повідомлень по значенням фільтру мереж
#[post("/api/rer/analysis/stats/networks/count")]
async fn network_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let analytics_tag_access =
        resolve_analytics_tag_access_if_enabled(&env, &req, &login).await?;
    let analytics_master_keys = master_keys.clone();
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_user = &user;
    let postgres_user = &user;
    let postgres_env = &env;
    let analytics_source_db = env.dbx.clone();
    let analytics_freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    let networks_count = with_analytics_read_fallback(
        env.get_ref(),
        "analysis stats networks count",
        analytics_count_request_supported(&req),
        |db| async move {
            let message_id_scope = stats::resolve_analytics_message_id_scope(
                &analytics_req.0,
                &db,
                analytics_freshness_max_age_ms,
            )
            .await?;
            stats::count_networks_analytics_with_db(
                analytics_req,
                analytics_user,
                &db,
                &analytics_source_db,
                analytics_master_keys,
                analytics_tag_access.as_ref().c(h!())?,
                Some(&message_id_scope),
                None,
            )
            .await
        },
        |_db| async move {
            stats::count_networks(
                postgres_req,
                postgres_user,
                postgres_env,
                master_keys,
            )
            .await
        },
    )
    .await
    .context(h!())?;
    Ok(Json(networks_count))
}

/// Deprecated.
/// Also see inbox.rs and callsigns.rs for similar end-points filtering done on the same screen
#[post("/api/rer/analysis/stats")]
async fn stats_deprecated(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<AnalysisStatsRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let instant = std::time::Instant::now();

    let master_keys = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let master_keys_noimport = master_keys.clone();

    let groups = stats::fetch_groups(&req, &user, &env, master_keys_noimport)
        .await
        .context(h!())?;
    let senders = stats::fetch_senders(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let posts = stats::fetch_posts(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let freqs = stats::fetch_freqs(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let callsigns =
        stats::fetch_callsigns(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let tags = stats::fetch_tags(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let units = stats::fetch_units(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let locations = fetch_locations(&user, &env, &req, master_keys.clone())
        .await
        .c(h!())?;
    let count = stats::fetch_counts(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    debug!("[stats] get stats: {:?}", instant.elapsed());

    Ok(Json(AnalysisStatsRsp {
        groups,
        senders,
        posts,
        freqs,
        callsigns,
        units,
        locations,
        tags,
        count_overall: count.0,
        count_selected: count.1,
    }))
}

async fn collect_sender_names(
    senders: &Vec<AnalysisStatsSender>,
    txn: &DatabaseConnection,
) -> anyhow::Result<BTreeMap<String, Option<SignalProfileRsp>>> {
    let sender_keys =
        senders.iter().map(|sender| sender.uuid.clone()).collect();
    let profiles = crate::rer_importer::collect_profiles_data(txn, sender_keys)
        .await
        .context(h!())?;
    Ok(profiles
        .into_iter()
        .map(|(key, profile)| {
            (
                key,
                profile.map(|profile| SignalProfileRsp {
                    given_name: profile.given_name,
                    family_name: profile.family_name,
                }),
            )
        })
        .collect())
}
async fn collect_group_names(
    groups: &Vec<AnalysisStatsGroup>,
    txn: &DatabaseConnection,
    is_admin: bool,
    analytics_group_stats: Option<&BTreeMap<String, SignalGroupStats>>,
) -> anyhow::Result<Vec<SignalGroupEntry>> {
    let mut result = vec![];
    let group_keys = groups.iter().map(|x| x.master_key.clone()).collect_vec();
    let signal_groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .select_only()
        .columns([
            signal_group::Column::MasterKey,
            signal_group::Column::Name,
            signal_group::Column::IgnoreOperativny,
            signal_group::Column::InterseptionKind,
            signal_group::Column::DisableNetworkAssignment,
        ])
        .filter(signal_group::Column::MasterKey.eq_any(group_keys.clone()))
        .into_tuple::<(
            String,
            Option<String>,
            bool,
            sea_orm_active_enums::InterseptionKind,
            bool,
        )>()
        .all(txn)
        .await
        .context(h!())?;
    let mut resolved_keys = vec![];
    let keys: Vec<String> = signal_groups
        .iter()
        .map(|(key, _, _, _, _)| key.clone())
        .collect();
    let stats = match analytics_group_stats {
        Some(analytics_group_stats) => analytics_group_stats.clone(),
        None => collect_group_stats(keys.clone(), txn).await.context(h!())?,
    };

    let group_aors = if is_admin {
        collect_group_aors(keys.clone(), txn).await.context(h!())?
    } else {
        BTreeMap::new()
    };

    let group_admin_data = if is_admin {
        collect_group_admin_data(keys, txn).await.context(h!())?
    } else {
        BTreeMap::new()
    };

    for (
        master_key,
        name,
        ignore_operativny,
        interseption_kind,
        disable_network_assignment,
    ) in signal_groups
    {
        if let Some(name) = name {
            resolved_keys.push(master_key.clone());
            let stats = stats.get(&master_key).cloned().unwrap_or_default();
            let aors = group_aors.get(master_key.as_str()).cloned();
            let group_admin_data =
                group_admin_data.get(master_key.as_str()).cloned();
            result.push(SignalGroupEntry {
                master_key,
                name,
                ignore_operativny,
                interseption_kind: interseption_kind.into(),
                disable_network_assignment,
                group_stats: stats,
                admin_data: group_admin_data,
                areas_of_responsibility: aors,
            });
        }
    }
    let mut whatsapp_groups = whatsapp_group::Entity::find()
        .filter(whatsapp_group::Column::Deleted.eq(false))
        .select_only()
        .columns([whatsapp_group::Column::Jid, whatsapp_group::Column::Name])
        .filter(whatsapp_group::Column::Jid.eq_any(group_keys.clone()));
    if !resolved_keys.is_empty() {
        whatsapp_groups = whatsapp_groups
            .filter(whatsapp_group::Column::Jid.is_not_in(resolved_keys));
    }
    let whatsapp_groups = whatsapp_groups
        .into_tuple::<(String, String)>()
        .all(txn)
        .await
        .context(h!())?;
    let ignore_operativny = false;
    for (master_key, name) in whatsapp_groups {
        let stats = stats.get(&master_key).cloned().unwrap_or_default();
        let group_admin_data =
            group_admin_data.get(master_key.as_str()).cloned();
        let aors = group_aors.get(master_key.as_str()).cloned();
        result.push(SignalGroupEntry {
            master_key,
            name,
            ignore_operativny,
            interseption_kind:
                crate::sigint::types::InterseptionKind::InterseptionRer,
            disable_network_assignment: false,
            group_stats: stats,
            admin_data: group_admin_data,
            areas_of_responsibility: aors,
        });
    }
    Ok(result)
}

async fn collect_aor_names(
    aors: &[AnalysisStatsAor],
    txn: &DatabaseConnection,
) -> Result<Vec<AreaOfResponsibilityEntry>, AppError> {
    let aor_ids: Vec<i64> = aors
        .iter()
        .map(|x| x.aor_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let area_of_responsibilities = area_of_responsibility::Entity::find()
        .select_only()
        .columns([
            area_of_responsibility::Column::Id,
            area_of_responsibility::Column::Name,
        ])
        .filter(area_of_responsibility::Column::Id.eq_any(aor_ids))
        .into_tuple::<(i64, String)>()
        .all(txn)
        .await
        .context(h!())?;

    Ok(area_of_responsibilities
        .into_iter()
        .map(|(aor_id, name)| AreaOfResponsibilityEntry { id: aor_id, name })
        .collect())
}

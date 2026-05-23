use super::types::*;
use crate::config::*;
use crate::delta::types::GeoJson;
use crate::entities::*;
use crate::kml::types::*;
use crate::location::utils::*;
use crate::messenger::group::collect_group_admin_data;
use crate::messenger::group::types::SignalGroupEntry;
use crate::messenger::group::types::*;
use crate::messenger::group::*;
use crate::sigint::aor::bl::collect_group_aors;
use crate::types::*;
use crate::users::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::string::*;
use crate::utils::*;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpRequest;
use actix_web::HttpResponse;
use chrono::prelude::*;
use futures_util::TryStreamExt;
use itertools::Itertools;
use redis::AsyncCommands;
use rust_xlsxwriter::{Format, Workbook};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::{prelude::Expr, sea_query::Alias, *};
use sea_query::*;
use std::collections::{BTreeMap, HashSet};
use tempfile::TempDir;

pub mod geojson;
pub mod kmz;
pub mod search;
pub mod stats;
#[cfg(test)]
mod tests;

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
        (Some(groups), Some(senders)) => Ok(
            q.filter(message_in_groups_with_senders_exists(&groups, &senders))
        ),
        (Some(groups), None) => Ok(q.filter(message_in_groups_exists(groups))),
        (None, Some(senders)) => Ok(q.filter(
            message_has_sender_in_groups_exists(&senders, allowed_groups),
        )),
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

    Ok(q.filter(message_in_groups_exists(filtered).not()))
}

pub fn message_in_groups_exists(keys: Vec<String>) -> SimpleExpr {
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
        .filter(signal_message_group::Column::GroupMasterKey.eq_any(keys))
        .into_query();

    Expr::exists(subquery)
}

fn message_in_groups_with_senders_exists(
    keys: &[String],
    senders: &[String],
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
        .filter(signal_message_group::Column::Sender.eq_any(senders.to_vec()))
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
            return Ok(q.filter(message_has_sender_exists(selected_senders)));
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
    if let Some(denied_senders) = denied_senders.as_ref() {
        if !denied_senders.is_empty() {
            return Ok(
                q.filter(message_has_sender_exists(denied_senders).not())
            );
        }
    }
    Ok(q)
}

fn message_has_sender_in_groups_exists(
    senders: &[String],
    allowed_groups: &[String],
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
        .filter(signal_message_group::Column::Sender.eq_any(senders.to_vec()))
        .into_query();

    Expr::exists(subquery)
}

fn message_has_sender_exists(senders: &[String]) -> SimpleExpr {
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
        .filter(signal_message_group::Column::Sender.eq_any(senders.to_vec()))
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
    let peleng_exists = Expr::exists(
        sigint_peleng::Entity::find()
            .filter(Expr::col(sigint_peleng::Column::SourceInboxItemId).equals(
                (sigint_inbox_item::Entity, sigint_inbox_item::Column::Id),
            ))
            .filter(sigint_peleng::Column::Deleted.eq(false))
            .into_query(),
    );
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
    let mut m_empty_filter = None;
    let mut m_filter = None;
    if let Some(selected_units) = selected_units.as_ref() {
        let mut selected_units: BTreeSet<String> =
            selected_units.iter().cloned().collect::<BTreeSet<_>>();
        let mut units_contain_empty = false;
        if selected_units.remove("Не визначено") {
            units_contain_empty = true;
        }
        if selected_units.remove("") {
            units_contain_empty = true;
        }
        if units_contain_empty {
            // частоти на яких був обмін в активних мережах, але всі підрозділи невідомі
            let no_sigint_units = sigint_inbox_item::Column::Freq
                .not_in_subquery(select_sigint_units_by_names(
                    sigint_unit::Column::Name.is_not_null(),
                ));
            let no_freq = sigint_inbox_item::Column::Freq.is_null();
            let unit_is_not_in_message = sigint_inbox_item::Column::UnitV2
                .is_null()
                .or(sigint_inbox_item::Column::UnitV2.eq(""));
            let contains_empty =
                unit_is_not_in_message.and(no_freq.or(no_sigint_units));
            m_empty_filter = Some(contains_empty);
        }
        if !selected_units.is_empty() {
            let in_subquery_condition = sigint_inbox_item::Column::Freq
                .in_subquery(select_sigint_units_by_names(
                    sigint_unit::Column::Name
                        .eq_any(selected_units.clone().into_iter().collect()),
                ));

            // якщо встановлено прапорець `units_exact_match_only`, то фільтруємо ТІЛЬКИ по підрозділам, які вказані через прив'язку по Еталонці
            let expr = if units_exact_match_only.unwrap_or(false) {
                in_subquery_condition
            } else {
                // інакше фільтруємо по підрозділам які було вказано в шапці повідомлення, або по прив'язаним через Еталонні мережі
                sigint_inbox_item::Column::UnitV2
                    .eq_any(selected_units.clone().into_iter().collect())
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

/// Ця функція обирає тільки частоти для яких є активна мережа і підрозділ в ній, а також виконується додаткова умова
///  * filter_expr -- додаткова умова фільтрування
fn select_sigint_units_by_names(filter_expr: SimpleExpr) -> SelectStatement {
    Query::select()
        .column(sigint_network_freq::Column::Freq)
        .distinct()
        .from(sigint_network_freq::Entity)
        .join(
            JoinType::InnerJoin,
            sigint_network::Entity,
            Expr::col((sigint_network::Entity, sigint_network::Column::Id))
                .equals((
                    sigint_network_freq::Entity,
                    sigint_network_freq::Column::NetworkId,
                )),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Entity,
            Expr::col((
                sigint_network_unit::Entity,
                sigint_network_unit::Column::NetworkId,
            ))
            .equals((sigint_network::Entity, sigint_network::Column::Id)),
        )
        .join(
            JoinType::InnerJoin,
            sigint_unit::Entity,
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Id)).equals((
                sigint_network_unit::Entity,
                sigint_network_unit::Column::UnitId,
            )),
        )
        .and_where(sigint_network_freq::Column::ActiveTo.is_null())
        .and_where(sigint_network_freq::Column::Deleted.eq(false))
        .and_where(sigint_unit::Column::Deleted.eq(false))
        .and_where(sigint_network::Column::Deleted.eq(false))
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
                    expressions.push(
                        sigint_inbox_item::Column::LocationV2
                            .contains(loc.clone()),
                    );
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
            return Ok(q.filter(SimpleExpr::Custom(cond_json_contains_oneof(
                "callsigns",
                selected_callsigns,
            ))));
        }
    }
    Ok(q)
}

fn get_related_tag_items_filter(
    unique_tags: BTreeSet<i64>,
    tag_filter_option: TagFilterOption,
    without_model_tags: bool,
    report_tags_only_this_unit: bool,
    user_id: &str,
) -> SimpleExpr {
    let expected_count = unique_tags.len();

    let mut q = sigint_inbox_item_tag::Entity::find()
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .filter(
            sigint_inbox_item_tag::Column::TagId
                .eq_any(unique_tags.into_iter().collect()),
        )
        .filter(
            sigint_inbox_item_tag::Column::Confidence
                .gte(TAG_MINIMUM_CONFIDENCE),
        )
        .select_only();

    if without_model_tags {
        q = q.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }

    if report_tags_only_this_unit {
        let user_alias = Alias::new("u2");

        let mut query = Query::select();
        query
            .column((login::Entity, login::Column::Login))
            .from(login::Entity)
            .join_as(
                JoinType::InnerJoin,
                login::Entity,
                user_alias.clone(),
                Expr::col((login::Entity, login::Column::OrganismId))
                    .equals((user_alias.clone(), login::Column::OrganismId)),
            )
            .and_where(
                Expr::col((user_alias, login::Column::Login))
                    .eq(user_id.to_string()),
            );

        info!(
            "filtering tags for {user_id}: {}",
            query.to_string(PostgresQueryBuilder)
        );
        q = q.filter(sigint_inbox_item_tag::Column::Login.in_subquery(query));
    }

    match tag_filter_option {
        TagFilterOption::OneOfTags => {
            Expr::exists(q.expr(Expr::value(1)).into_query())
        }
        TagFilterOption::AllTags => {
            let subquery = q
                .expr(Expr::col(sigint_inbox_item_tag::Column::Id).count())
                .into_query()
                .into_sub_query_statement();
            SimpleExpr::SubQuery(None, Box::new(subquery))
                .eq(expected_count as u64)
        }
    }
}

fn tags_from_user_organism_exists(user_id: &str) -> SimpleExpr {
    let user_alias = Alias::new("t_user");
    let allowed_logins = Query::select()
        .column((login::Entity, login::Column::Login))
        .from(login::Entity)
        .join_as(
            JoinType::InnerJoin,
            login::Entity,
            user_alias.clone(),
            Expr::col((login::Entity, login::Column::OrganismId))
                .equals((user_alias.clone(), login::Column::OrganismId)),
        )
        .and_where(
            Expr::col((user_alias, login::Column::Login))
                .eq(user_id.to_string()),
        )
        .to_owned();

    let subquery = sigint_inbox_item_tag::Entity::find()
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
            sigint_inbox_item_tag::Column::Login.in_subquery(allowed_logins),
        )
        .into_query();

    Expr::exists(subquery)
}

pub fn filter_selected_tags<Q>(
    q: Q,
    selected_tags: &Option<Vec<i64>>,
    or_bookmarked: &Option<bool>,
    or_important: &Option<bool>,
    or_with_coords: &Option<bool>,
    or_without_coords: &Option<bool>,
    or_with_extended_form: &Option<bool>,
    filter_tags_option: &Option<TagFilterOption>,
    without_model_tags: &Option<bool>,
    user_id: &str,
    report_tags_only_this_unit: bool,
) -> Result<Q, AppError>
where
    Q: QueryFilter + QuerySelect + Clone,
{
    let mut q = q.clone();
    let mut m_inner_expr = None;
    if let Some(selected_tags) = selected_tags.as_ref() {
        if !selected_tags.is_empty() {
            let unique_tags: BTreeSet<i64> =
                selected_tags.iter().cloned().collect();
            let tag_filter_option =
                filter_tags_option.unwrap_or(TagFilterOption::OneOfTags);
            let without_model_tags = without_model_tags.unwrap_or(false);
            m_inner_expr = Some(get_related_tag_items_filter(
                unique_tags,
                tag_filter_option,
                without_model_tags,
                report_tags_only_this_unit,
                user_id,
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
            .filter(sigint_bookmark::Column::UserId.eq(user_id.to_string()))
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
        let comment_exists = sigint_comment::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                Expr::col((
                    sigint_comment::Entity,
                    sigint_comment::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .filter(sigint_comment::Column::Comment.eq("").not())
            .into_query();

        q = q.filter(Expr::exists(comment_exists));
    }

    if let Some(ref inner_expr) = m_inner_expr {
        q = q.filter(inner_expr.clone());
    }

    if report_tags_only_this_unit && m_inner_expr.is_none() {
        q = q.filter(tags_from_user_organism_exists(user_id));
    }
    // println!(
    //     "> filter_selected_tags q sql: {}",
    //     q.build(DbBackend::Postgres).to_string()
    // );
    Ok(q)
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
                .add(
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
                                        linked_aor_alias.clone(),
                                        area_of_responsibility::Column::RightBound,
                                    ))
                                    .gte(Expr::col((
                                        selected_aor_alias.clone(),
                                        area_of_responsibility::Column::RightBound,
                                    ))),
                                ),
                        ),
                ),
        )
        .to_owned()
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
    Expr::exists(network_exists_subquery()).not().and(
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

fn network_exists_subquery() -> SelectStatement {
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
                network_alias,
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .and_where(
            Expr::col((network_table_alias, sigint_network::Column::Deleted))
                .eq(false),
        );
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
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
            q2 = q2
                .join(
                    JoinType::InnerJoin,
                    sigint_inbox_item::Relation::SigintSearch.def(),
                )
                .filter(
                    Expr::col((
                        sigint_search::Entity,
                        sigint_search::Column::SearchTsv,
                    ))
                    .matches(Expr::cust_with_values(
                        "websearch_to_tsquery('russian', $1)",
                        vec![search_parts.ts_query.clone()],
                    )),
                );
        }
        for ilike in search_parts.ilike {
            q2 =
                q2.filter(Expr::col(signal_message::Column::Body).ilike(ilike));
        }
        for not_ilike in search_parts.not_ilike {
            q2 = q2.filter(
                Expr::cust("jsonb_extract_path_text(sigint_inbox_item.body_noheader, 'body')")
                    .not_ilike(not_ilike),
            );
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

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/summary-table-freq")]
pub async fn summary_table_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<SummaryTableFreq>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    Ok(Json(summary_table_freq_1(&user, &env, &req).await.c(h!())?))
}

pub async fn summary_table_freq_1(
    user: &Identity,
    env: &Env,
    req: &AnalysisStatsReq,
) -> Result<SummaryTableFreq, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        freq: Option<String>,
        lat: Option<f64>,
        lng: Option<f64>,
        nominatimres_id: Option<i64>,
        count: i64,
        callsigns: Vec<serde_json::Value>,
        units: Vec<String>,
        locations: Vec<String>,
    }

    let master_keys =
        get_identity_sigint_groups_noimport(&env.dbx, user, &env.config)
            .await
            .c(h!())?;

    let dedup_key_alias = Alias::new("dedup_key");
    let dedup_subquery =
        build_summary_table_filtered_messages_query(user, req, &master_keys)?
            .select_only()
            .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
            .column_as(Expr::col(sigint_inbox_item::Column::Lat), "lat")
            .column_as(Expr::col(sigint_inbox_item::Column::Lng), "lng")
            .column_as(
                Expr::col(sigint_inbox_item::Column::NominatimresId),
                "nominatimres_id",
            )
            .column_as(
                Expr::col(sigint_inbox_item::Column::Callsigns),
                "callsigns",
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
        .column((uniq_alias.clone(), "lat"))
        .column((uniq_alias.clone(), "lng"))
        .column((uniq_alias.clone(), "nominatimres_id"))
        .expr_as(
            Expr::cust("array_agg(distinct uniq.callsigns)"),
            "callsigns",
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
        .add_group_by([Expr::cust("1, 2, 3, 4")])
        .to_owned();

    let sql = main_query.to_string(PostgresQueryBuilder);
    // println!("> summary table main_query sql: {}", sql);

    let main_query_res = env
        .dbx
        .query_all(Statement::from_string(DbBackend::Postgres, sql))
        .await
        .c(h!())?;

    let rows_res: Vec<Row> = main_query_res
        .into_iter()
        .map(|qr| Row::from_query_result(&qr, ""))
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .c(h!())?;

    let mut callsigns_per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut units_per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut locations_per_freq: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut count_per_freq: BTreeMap<String, i64> = BTreeMap::new();
    #[derive(PartialEq, Clone)]
    struct LatLngNominatim {
        lat: f64,
        lng: f64,
        nominatimres_id: Option<i64>,
    }
    let mut latlng_per_freq: BTreeMap<String, Vec<LatLngNominatim>> =
        BTreeMap::new();
    let mut nominatimres_per_id: BTreeMap<i64, nominatimres::Model> =
        BTreeMap::new();
    let mut nominatimres_per_freq: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for nominatimres_id in uniq_via_btreeset(
        &rows_res
            .iter()
            .filter_map(|x| x.nominatimres_id)
            .collect::<Vec<i64>>(),
    ) {
        let m_nominatimres = nominatimres::Entity::find_by_id(nominatimres_id)
            .one(&env.dbx)
            .await
            .c(h!())?;
        if let Some(nominatimres) = m_nominatimres {
            nominatimres_per_id.insert(nominatimres_id, nominatimres);
        }
    }
    nominatimres_per_id.insert(
        0,
        nominatimres::Model {
            id: 0,
            created_at: Utc::now()
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .ok_or("err 91734")?,
            res: serde_json::Value::Null,
            nominatim_display_name: "Невідомо".to_string(),
        },
    );
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
                    if !xs.contains(unit) && !unit.trim().is_empty() {
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
                    if !xs.contains(location) && !location.trim().is_empty() {
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

        for callsigns_j in row.callsigns.iter() {
            let callsigns: Vec<String> =
                serde_json::from_value(callsigns_j.clone()).context(h!())?;
            for callsign in callsigns {
                callsigns_per_freq
                    .entry(freq.clone())
                    .and_modify(|xs| {
                        if !xs.contains(&callsign) {
                            xs.push(callsign.clone())
                        }
                    })
                    .or_insert(vec![callsign.clone()]);
            }
        }
        if let (Some(lat), Some(lng)) = (row.lat, row.lng) {
            // println!("> some freq {freq} lat lng: {lat} {lng}");
            let m_nominatimres_id = row.nominatimres_id;
            let v = LatLngNominatim {
                lat,
                lng,
                nominatimres_id: m_nominatimres_id,
            };
            latlng_per_freq
                .entry(freq.clone())
                .and_modify(|xs| {
                    if !xs.contains(&v) {
                        xs.push(v.clone());
                    }
                })
                .or_insert(vec![v.clone()]);
        }
        let nominatimres_id = row.nominatimres_id.unwrap_or(0);
        nominatimres_per_freq
            .entry(freq.clone())
            .and_modify(|xs| {
                if !xs.contains(&nominatimres_id) {
                    xs.push(nominatimres_id);
                }
            })
            .or_insert(vec![nominatimres_id]);
    }

    let mut rows = vec![];
    for (freq, count) in count_per_freq.iter() {
        // let coords = latlng_per_freq
        //     .get(freq)
        //     .unwrap_or(&vec![])
        //     .iter()
        //     .map(|x| {
        //         LatLng {
        //             lat: x.lat,
        //             lng: x.lng,
        //         }
        //         .clone()
        //     })
        //     .take(crate::config::COORDS_PER_FREQ_LIMIT)
        //     .collect();
        // // println!("> freq: {freq}, coords: {coords:?}");
        // let nominatimids =
        //     nominatimres_per_freq.get(freq).unwrap_or(&vec![0]).clone();
        // let mut locality_coords_hm: BTreeMap<String, Vec<LatLng>> =
        //     BTreeMap::new();
        // for nomresid in nominatimids.iter() {
        //     if let Some(nominatimres) = nominatimres_per_id.get(nomresid) {
        //         let m_nomresid = if *nomresid == 0 {
        //             None
        //         } else {
        //             Some(*nomresid)
        //         };
        //         // gather coords per freq which are in this nominatimres
        //         let latlngs: Vec<LatLngNominatim> = latlng_per_freq
        //             .get(freq)
        //             .unwrap_or(&vec![])
        //             .iter()
        //             .filter(|x| x.nominatimres_id == m_nomresid)
        //             .cloned()
        //             .collect();
        //         for latlngnom in latlngs {
        //             let latlng = LatLng {
        //                 lat: latlngnom.lat,
        //                 lng: latlngnom.lng,
        //             };
        //             locality_coords_hm
        //                 .entry(nominatimres.nominatim_display_name.clone())
        //                 .and_modify(|xs| {
        //                     if !xs.contains(&latlng) {
        //                         xs.push(latlng.clone());
        //                     }
        //                 })
        //                 .or_insert(vec![latlng.clone()]);
        //         }
        //     }
        // }
        // let locality_coords_len = locality_coords_hm.len();
        // let locality_coords = locality_coords_hm
        //     .iter()
        //     .map(|(k, v)| LocalityCoords {
        //         locality: k.to_string(),
        //         count: locality_coords_len as i64,
        //         coords: v.to_vec(),
        //     })
        //     .take(crate::config::COORDS_PER_FREQ_PER_LOC_LIMIT)
        //     .collect();
        rows.push(SummaryTableFreqRow {
            freq: freq.clone(),
            count: *count,
            callsigns: callsigns_per_freq.get(freq).unwrap_or(&vec![]).clone(),
            units: units_per_freq.get(freq).unwrap_or(&vec![]).clone(),
            locations: locations_per_freq.get(freq).unwrap_or(&vec![]).clone(),
            coords: vec![],
            locality_coords: vec![],
        });
    }

    Ok(SummaryTableFreq { rows })
}

pub(crate) fn build_summary_table_filtered_messages_query(
    user: &Identity,
    req: &AnalysisStatsReq,
    master_keys: &[String],
) -> Result<Select<signal_message::Entity>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    let q = signal_message::Entity::find()
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
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(master_keys.to_vec()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_selected_groups_and_senders_with_access(
        q,
        &req.selected_groups,
        &req.selected_senders,
        master_keys,
    )?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        &user.id().c(h!())?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q = filter_selected_networks(
        q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let q = filter_selected_metadata_for_analysis_stats(q, req)?;
    filter_search(q, &req.search)
}

async fn summary_table_last_datetime_by_freq(
    user: &Identity,
    env: &Env,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, NaiveDateTime>, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        freq: Option<String>,
        last_datetime: Option<NaiveDateTime>,
    }

    let master_keys =
        get_identity_sigint_groups_noimport(&env.dbx, user, &env.config)
            .await
            .c(h!())?;
    let rows =
        build_summary_table_filtered_messages_query(user, req, &master_keys)?
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

async fn summary_table_related_networks_by_freq(
    user: &Identity,
    env: &Env,
    req: &AnalysisStatsReq,
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

    let master_keys =
        get_identity_sigint_groups_noimport(&env.dbx, user, &env.config)
            .await
            .c(h!())?;

    let filtered_messages_alias = Alias::new("filtered_messages");
    let inbox_network_alias = Alias::new("summary_inbox_network");
    let network_alias = Alias::new("summary_network");
    let network_unit_alias = Alias::new("summary_network_unit");
    let unit_alias = Alias::new("summary_unit");

    let filtered_messages_query =
        build_summary_table_filtered_messages_query(user, req, &master_keys)?
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
                if !items.contains(&full_name) {
                    items.push(full_name.clone());
                }
            })
            .or_insert_with(|| vec![full_name]);
    }

    Ok(networks_by_freq)
}

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/summary-table.xlsx")]
async fn summary_table_xlsx(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<AnalysisStatsReq>,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let summary_table: SummaryTableFreq =
        summary_table_freq_1(&user, &env, &req).await.c(h!())?;
    let last_datetime_by_freq =
        summary_table_last_datetime_by_freq(&user, &env, &req)
            .await
            .c(h!())?;
    let related_networks_by_freq =
        summary_table_related_networks_by_freq(&user, &env, &req)
            .await
            .c(h!())?;

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
    sheet1
        .write_string(0, 0, &describe_analysis_stats_req(req.into_inner())?)
        .context(h!())?;

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
            .cloned()
            .unwrap_or_default()
            .join(", ");
        sheet1.write_string(row_i, 0, &row.freq).context(h!())?; // Removed None
        sheet1
            .write_number(row_i, 1, row.count as f64)
            .context(h!())?; // Removed None
        sheet1
            .write_string(row_i, 2, row.callsigns.join(", "))
            .context(h!())?; // Removed None
        sheet1
            .write_string(row_i, 3, row.units.join(", "))
            .context(h!())?; // Removed None
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
                    if !xs.contains(&row.freq) {
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
    let file = actix_files::NamedFile::open_async(&outpath).await.c(h!())?;
    Ok(file.into_response(&http_req))
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

    Ok(format!(
        "Період: {} - {}. {selected_groups_s}{selected_senders_s}{selected_freqs_s}{selected_callsigns_s}{selected_units_s}",
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let empty = CorrelatedFreqsRsp { freqs: vec![] };
    let Some(selected_freqs) = req.selected_freqs.clone() else {
        return Ok(Json(empty));
    };
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    // if dt_since is earlier than 7 days before dt_till -- put it to dt_till - 7 days
    let dt_since = if dt_till - dt_since
        > chrono::Duration::days(CORRELATED_FREQS_MAX_DAYS)
    {
        dt_till - chrono::Duration::days(CORRELATED_FREQS_MAX_DAYS)
    } else {
        dt_since
    };

    let mut freqs = vec![];
    #[derive(FromQueryResult)]
    struct Res {
        callsign: Option<String>,
    }
    let q = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(
                crate::messenger::group::get_identity_sigint_groups(
                    &env.dbx, &login,
                )
                .await
                .c(h!())?,
            ),
        )
        .select_only()
        .column_as(
            Expr::cust("jsonb_array_elements_text(callsigns)"),
            "callsign",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_metadata_for_analysis_stats(q, &req)?;
    let q = q.into_model::<Res>().all(&env.dbx).await.c(h!())?;
    let mut selected_freq_callsigns: Vec<String> = vec![];
    for x in q.iter() {
        if let Some(ref callsign) = x.callsign {
            selected_freq_callsigns.push(callsign.clone());
        }
    }
    let selected_freq_callsigns = uniq_via_btreeset(&selected_freq_callsigns);

    let mut freq_common_callsigns: BTreeMap<String, Vec<String>> =
        BTreeMap::new();
    for callsign in selected_freq_callsigns.iter() {
        #[derive(FromQueryResult)]
        struct Res2 {
            freq: Option<String>,
        }
        let q = signal_message::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .filter(
                datasource_group::Column::GroupMasterKey.eq_any(
                    crate::messenger::group::get_identity_sigint_groups(
                        &env.dbx, &login,
                    )
                    .await
                    .c(h!())?,
                ),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
            .filter(Expr::cust_with_values(
                "sigint_inbox_item.callsigns::jsonb ? $1",
                vec![callsign],
            ))
            .select_only()
            .column_as(sigint_inbox_item::Column::Freq, "freq");
        let q = filter_selected_metadata_for_analysis_stats(q, &req)?;
        let res = q.into_model::<Res2>().all(&env.dbx).await.c(h!())?;
        for r in res {
            let Some(freq): Option<String> = r.freq else {
                continue;
            };
            freq_common_callsigns
                .entry(freq.clone())
                .and_modify(|xs| {
                    if !xs.contains(callsign) {
                        xs.push(callsign.clone())
                    }
                })
                .or_insert(vec![callsign.clone()]);
        }
    }
    for (freq, callsigns) in freq_common_callsigns.iter() {
        if !selected_freqs.contains(freq) {
            freqs.push(CorrelatedFreq {
                freq: freq.clone(),
                common_callsigns: callsigns.clone(),
            });
        }
    }
    let mut freqs = freqs.clone();
    freqs.sort_by(|a, b| {
        b.common_callsigns
            .len()
            .partial_cmp(&a.common_callsigns.len())
            .unwrap()
    });

    Ok(Json(CorrelatedFreqsRsp { freqs }))
}

#[post("/api/rer/analysis/freq-edit-unit-name")]
pub async fn edit_freq_unit_name(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<EditFreqUnitNameReq>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
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
        &req.filter_tags_option,
        &reqan.without_model_tags,
        &user.id().c(h!())?,
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
            row.update(&txn).await.c(h!())?;
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
    user_id: String,
    dbx: &DbConn,
) -> Result<Vec<T>, AppError>
where
    T: FromSavedFilter,
{
    let saved_filters = sigint_saved_filter::Entity::find()
        .filter(sigint_saved_filter::Column::Login.eq(Some(user_id)))
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    Ok(Json(
        select_saved_filter_list(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Analysis,
            user.id().c(h!())?,
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    Ok(Json(
        select_saved_filter_list(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Duty,
            user.id().c(h!())?,
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    Ok(Json(
        saved_filter_upsert_1(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Analysis,
            user.id().c(h!())?,
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    Ok(Json(
        saved_filter_upsert_1(
            sea_orm_active_enums::SigintSavedFilterTypeEnum::Duty,
            user.id().c(h!())?,
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
    user_id: String,
    dbx: &DbConn,
    name: String,
    req: serde_json::Value,
) -> Result<Vec<T>, AppError>
where
    T: FromSavedFilter,
{
    let m_filter = sigint_saved_filter::Entity::find()
        .filter(sigint_saved_filter::Column::Name.eq(name.clone()))
        .filter(sigint_saved_filter::Column::Login.eq(Some(user_id.clone())))
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
                login: Set(Some(user_id.clone())),
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let filter_type = filter_type_form_path(path.into_inner().as_str())?;
    let saved_filter = sigint_saved_filter::Entity::find_by_id(req.id)
        .filter(sigint_saved_filter::Column::Login.eq(Some(user.id().c(h!())?)))
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let filter_type = filter_type_form_path(path.into_inner().as_str())?;
    let saved_filter =
        sigint_saved_filter::Entity::find_by_id(req.into_inner())
            .filter(
                sigint_saved_filter::Column::Login.eq(Some(user.id().c(h!())?)),
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
    let user_id = &user.id().c(h!())?;
    let res = bi_new_callsigns(user_id, &env, &req.into_inner())
        .await
        .context(h!())?;

    Ok(Json(res))
}

pub async fn bi_new_callsigns(
    user_id: &str,
    env: &Env,
    req: &AnalysisStatsReq,
) -> Result<NewCallsignsRes, AppError> {
    has_role(&env.dbx, user_id, "Rer").await.c(h!())?;

    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    #[derive(FromQueryResult)]
    struct Row {
        callsigns: Option<serde_json::Value>,
        timestamp: Option<NaiveDateTime>,
    }
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
        .column_as(sigint_inbox_item::Column::Callsigns, "callsigns")
        .column_as(sigint_inbox_item::Column::Datetime, "timestamp")
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(
                get_identity_sigint_groups(&env.dbx, user_id)
                    .await
                    .c(h!())?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let rows_res = filter_selected_senders(rows_res, &req.selected_senders)?;
    let rows_res = filter_selected_freqs(rows_res, &req.selected_freqs)?;
    let rows_res = filter_selected_posts(rows_res, &req.selected_posts)?;
    let rows_res = filter_selected_units(
        rows_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let rows_res = filter_selected_locations(
        rows_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let rows_res =
        filter_selected_callsigns(rows_res, &req.selected_callsigns)?;
    let rows_res = filter_search(rows_res, &req.search)?;
    let rows_res = filter_selected_tags(
        rows_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        user_id,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let rows_res =
        filter_selected_aors(rows_res, &req.selected_aors).context(h!())?;
    let rows_res = filter_selected_networks(
        rows_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let rows_res = filter_selected_metadata_for_analysis_stats(rows_res, req)?;
    let mut rows_res = rows_res
        .into_model::<Row>()
        .stream(&env.dbx)
        .await
        .c(h!())?;

    let mut callsigns_in_period = BTreeSet::new();
    while let Some(item) = rows_res.try_next().await.c(h!())? {
        let Some(callsigns) = item.callsigns else {
            continue;
        };
        let callsigns: Vec<String> =
            serde_json::from_value(callsigns).context(h!())?;
        for callsign in callsigns {
            callsigns_in_period.insert(callsign);
        }
    }

    // go back 30 days
    let dt_till = dt_since;
    let dt_since = dt_since - chrono::Duration::days(30);
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
        .column_as(sigint_inbox_item::Column::Callsigns, "callsigns")
        .column_as(sigint_inbox_item::Column::Datetime, "timestamp")
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(
                get_identity_sigint_groups(&env.dbx, user_id)
                    .await
                    .c(h!())?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let rows_res = filter_selected_senders(rows_res, &req.selected_senders)?;
    let rows_res = filter_selected_freqs(rows_res, &req.selected_freqs)?;
    let rows_res = filter_selected_posts(rows_res, &req.selected_posts)?;
    let rows_res = filter_selected_units(
        rows_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let rows_res = filter_selected_locations(
        rows_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let rows_res =
        filter_selected_callsigns(rows_res, &req.selected_callsigns)?;
    let rows_res = filter_search(rows_res, &req.search)?;
    let rows_res = filter_selected_tags(
        rows_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        user_id,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let rows_res = filter_selected_networks(
        rows_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let rows_res = filter_selected_metadata_for_analysis_stats(rows_res, req)?;
    let mut rows_res = rows_res
        .into_model::<Row>()
        .stream(&env.dbx)
        .await
        .c(h!())?;

    let mut callsign_last_seen: BTreeMap<String, NaiveDateTime> =
        BTreeMap::new();
    while let Some(item) = rows_res.try_next().await.c(h!())? {
        let Some(callsigns) = item.callsigns else {
            continue;
        };
        let callsigns: Vec<String> =
            serde_json::from_value(callsigns).context(h!())?;
        let Some(timestamp) = item.timestamp else {
            continue;
        };
        for callsign in callsigns {
            callsign_last_seen
                .entry(callsign)
                .and_modify(|e| {
                    if *e < timestamp {
                        *e = timestamp;
                    }
                })
                .or_insert(timestamp);
        }
    }

    let seen_24h = callsign_last_seen
        .iter()
        .filter(|(_, v)| **v > dt_till - chrono::Duration::hours(24))
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>();
    let seen_7days = callsign_last_seen
        .iter()
        .filter(|(_, v)| **v > dt_till - chrono::Duration::days(7))
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>();
    let seen_30days = callsign_last_seen
        .iter()
        .filter(|(_, v)| **v > dt_till - chrono::Duration::days(30))
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>();
    let not_seen_24h = callsigns_in_period
        .iter()
        .filter(|k| !seen_24h.contains(k))
        .cloned()
        .collect::<Vec<_>>();
    let not_seen_7days = callsigns_in_period
        .iter()
        .filter(|k| !seen_7days.contains(k))
        .cloned()
        .collect::<Vec<_>>();
    let not_seen_30days = callsigns_in_period
        .iter()
        .filter(|k| !seen_30days.contains(k))
        .cloned()
        .collect::<Vec<_>>();

    Ok(NewCallsignsRes {
        not_seen_24h,
        not_seen_7days,
        not_seen_30days,
    })
}

#[post("/api/rer/message/comments-batch")]
pub async fn batch_message_comments(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<BatchMessageCommentsReq>,
) -> Result<Json<MessageComments>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let message_ids: Vec<i64> =
        req.messages.iter().map(|m| m.message_id).collect();
    let comments =
        batch_message_comments_bl(&env.dbx, &login, &message_ids).await?;
    Ok(Json(comments))
}

pub async fn batch_message_comments_bl(
    dbx: &DatabaseConnection,
    login: &str,
    message_ids: &[i64],
) -> Result<MessageComments, AppError> {
    let message_ids = accessible_message_ids(dbx, login, message_ids).await?;
    let comments = sigint_comment::Entity::find()
        .filter(sigint_comment::Column::SignalMessageId.eq_any(message_ids))
        .order_by_asc(sigint_comment::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())?;
    let mut res: BTreeMap<i64, Vec<MessageComment>> = BTreeMap::new();
    for comment in comments {
        let message_id = comment.signal_message_id;
        let mut comm_vec = match res.get(&message_id) {
            None => vec![],
            Some(v) => v.clone(),
        };
        comm_vec.push(MessageComment {
            message_id,
            id: comment.id,
            comment: comment.comment,
            login: comment.login,
        });
        res.insert(message_id, comm_vec);
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

async fn accessible_message_ids(
    dbx: &DatabaseConnection,
    login: &str,
    message_ids: &[i64],
) -> Result<Vec<i64>, AppError> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }

    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;

    Ok(signal_message::Entity::find()
        .select_only()
        .distinct()
        .column(signal_message::Column::Id)
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()))
        .filter(
            signal_message_group::Column::GroupMasterKey.eq_any(sigint_groups),
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let message = signal_message::Entity::find_by_id(req.message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let comments = sigint_comment::Entity::find()
        .filter(sigint_comment::Column::SignalMessageId.eq(req.message_id))
        .order_by_asc(sigint_comment::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for comment in comments {
        res.push(MessageComment {
            id: comment.id,
            message_id: message.id,
            comment: comment.comment,
            login: comment.login,
        });
    }
    Ok(Json(res))
}

#[post("/api/rer/analysis/message-draft-events")]
pub async fn message_draft_events(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DraftCommentEventsReq>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;

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
#[post("/api/rer/analysis/stats/groups")]
async fn group_stats(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<GroupStatsRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let is_admin = crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .is_ok();
    let master_keys_noimport =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(&login))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;
    let master_keys_noimport_count = master_keys_noimport.len();
    let groups =
        stats::fetch_groups(&req, &user, &env, master_keys_noimport.clone())
            .await
            .context(h!())?;
    let groups = if should_include_missing_secret_groups(&req) {
        include_missing_secret_groups(&env.dbx, groups, &master_keys_noimport)
            .await
            .context(h!())?
    } else {
        groups
    };
    let group_names = collect_group_names(&groups, &env.dbx, is_admin)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let master_keys: Vec<String> = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let senders = stats::fetch_senders(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let posts = stats::fetch_posts(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let freqs = stats::fetch_freqs(&req, &user, &env, master_keys)
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let login = user.id().c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let callsigns = stats::fetch_callsigns(&req, &user, &env, master_keys)
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let login = user.id().c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let metadata = stats::fetch_metadata_stats(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let tags = stats::fetch_tags(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let units = stats::fetch_units(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let locations = fetch_locations(&user, &env, &req, master_keys)
        .await
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let aors = stats::fetch_aors(&req, &user, &env, master_keys)
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
    let mut locations_map = BTreeMap::new();
    stats::fetch_locations(req, user, env, master_keys)
        .await
        .context(h!())?
        .into_iter()
        .for_each(|stat| {
            let location = stat.location;
            let old_count = locations_map.get(&location).unwrap_or(&0);
            let count = old_count + stat.count;
            locations_map.insert(location, count);
        });
    let locations = locations_map
        .into_iter()
        .map(|(location, count)| AnalysisStatsLocation { location, count })
        .collect_vec();
    Ok(locations)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let networks = stats::fetch_networks(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;

    let master_keys = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let master_keys_noimport =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;

    let groups =
        stats::fetch_groups(&req, &user, &env, master_keys_noimport.clone())
            .await
            .context(h!())?;
    let groups = if should_include_missing_secret_groups(&req) {
        include_missing_secret_groups(&env.dbx, groups, &master_keys_noimport)
            .await
            .context(h!())?
    } else {
        groups
    };
    let groups_count = groups.len() as i64;
    let senders_count =
        stats::count_senders(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let freqs_count =
        stats::count_freqs(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let posts_count =
        stats::count_posts(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let callsigns_count =
        stats::count_callsigns(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let units_count =
        stats::count_units(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let (units_exact_matches_count, units_non_exact_matches_count) =
        stats::count_unit_exact_match_breakdown(
            &req,
            &user,
            &env,
            master_keys.clone(),
        )
        .await
        .context(h!())?;
    let locations_count =
        stats::count_locations(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let tags_count = stats::count_tags(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let aors_count = stats::count_aors(&req, &user, &env, master_keys.clone())
        .await
        .context(h!())?;
    let networks_count =
        stats::count_networks(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;
    let (count_overall, count_selected) =
        stats::fetch_counts(&req, &user, &env, master_keys.clone())
            .await
            .context(h!())?;

    Ok(Json(CountStatsRsp {
        count_overall,
        count_selected,
        groups_count,
        senders_count,
        freqs_count,
        posts_count,
        callsigns_count,
        units_count,
        units_exact_matches_count,
        units_non_exact_matches_count,
        locations_count,
        tags_count,
        aors_count,
        networks_count,
    }))
}

/// STATS
#[post("/api/rer/analysis/stats/groups/count")]
async fn group_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let master_keys_noimport =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;
    let groups =
        stats::fetch_groups(&req, &user, &env, master_keys_noimport.clone())
            .await
            .context(h!())?;
    let groups =
        include_missing_secret_groups(&env.dbx, groups, &master_keys_noimport)
            .await
            .context(h!())?;
    let groups_count = groups.len() as i64;
    Ok(Json(groups_count))
}

#[post("/api/rer/analysis/stats/senders/count")]
async fn sender_stats_count(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
) -> Result<Json<i64>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys: Vec<String> = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let senders_count = stats::count_senders(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let posts_count = stats::count_posts(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Rer", "Api"]).await?;

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let freqs_count = stats::count_freqs(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let callsigns_count =
        stats::count_callsigns(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let tags_count = stats::count_tags(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let units_count = stats::count_units(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let locations_count =
        stats::count_locations(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let aors_count = stats::count_aors(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .context(h!())?;
    let networks_count = stats::count_networks(&req, &user, &env, master_keys)
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;

    let instant = std::time::Instant::now();

    let master_keys = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let master_keys_noimport =
        get_identity_sigint_groups_noimport(&env.dbx, &user, &env.config)
            .await
            .context(h!())?;

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
    let mut result = BTreeMap::new();
    let mut sender_keys = vec![];
    for sender in senders {
        sender_keys.push(sender.uuid.clone());
    }
    let signal_profiles = signal_profile::Entity::find()
        .select_only()
        .columns([
            signal_profile::Column::Uuid,
            signal_profile::Column::FamilyName,
            signal_profile::Column::GivenName,
        ])
        .filter(signal_profile::Column::Uuid.eq_any(sender_keys.clone()))
        .into_tuple::<(String, Option<String>, Option<String>)>()
        .all(txn)
        .await
        .context(h!())?;
    let mut signal_profiles_map = BTreeMap::new();
    for (key, family_name, given_name) in signal_profiles {
        signal_profiles_map.insert(
            key,
            SignalProfileRsp {
                given_name,
                family_name,
            },
        );
    }
    for s in sender_keys {
        let entry = signal_profiles_map.remove(&s);
        result.insert(s, entry);
    }

    Ok(result)
}
async fn collect_group_names(
    groups: &Vec<AnalysisStatsGroup>,
    txn: &DatabaseConnection,
    is_admin: bool,
) -> anyhow::Result<Vec<SignalGroupEntry>> {
    let mut result = vec![];
    let group_keys = groups.iter().map(|x| x.master_key.clone()).collect_vec();
    let signal_groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .select_only()
        .columns([
            signal_group::Column::MasterKey,
            signal_group::Column::Name,
            signal_group::Column::IgnoreOperativny,
        ])
        .filter(signal_group::Column::MasterKey.eq_any(group_keys.clone()))
        .into_tuple::<(String, Option<String>, bool)>()
        .all(txn)
        .await
        .context(h!())?;
    let mut resolved_keys = vec![];
    let keys: Vec<String> = signal_groups
        .iter()
        .map(|(key, _, _)| key.clone())
        .collect();
    let stats: BTreeMap<String, SignalGroupStats> =
        collect_group_stats(keys.clone(), txn).await.context(h!())?;

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

    for (master_key, name, ignore_operativny) in signal_groups {
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
                group_stats: stats,
                admin_data: group_admin_data,
                areas_of_responsibility: aors,
            });
        }
    }
    let whatsapp_groups = whatsapp_group::Entity::find()
        .filter(whatsapp_group::Column::Deleted.eq(false))
        .select_only()
        .columns([whatsapp_group::Column::Jid, whatsapp_group::Column::Name])
        .filter(whatsapp_group::Column::Jid.eq_any(group_keys.clone()))
        .filter(whatsapp_group::Column::Jid.ne_any(resolved_keys))
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

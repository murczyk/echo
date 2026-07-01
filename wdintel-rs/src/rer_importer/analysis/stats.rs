use crate::rer_importer::types::SenderFrequencyBreakdown;
use crate::types::ShortContext;
use crate::types::{debug, warn};
use actix_identity::Identity;
use actix_web::web::Json;
use chrono::Duration;
use echo_migration::{Expr, JoinType};
use sea_orm::sea_query::{SimpleExpr, UnionType};
use sea_orm::FromQueryResult;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::error::Error as StdError;

use crate::entities::sigint_inbox_item::Entity;
use crate::entities::{
    sigint_inbox_item, sigint_inbox_item_metadata, sigint_post, signal_message,
    signal_message_group,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::analysis::*;
use crate::stats::*;
use crate::types::Env;

pub async fn fetch_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_groups_for_login(&req.0, login_value.as_str(), env, master_keys).await
}

pub async fn fetch_groups_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    let req_json = Json(req.clone());

    if should_read_stats_aggregated(&req_json, env, dt_since, dt_till)
        .c(h!())?
    {
        let result = read_group_stats_aggregated(
            &env.dbx,
            master_keys,
            dt_since,
            dt_till,
        )
        .await
        .c(h!())?;
        return Ok(result);
    }
    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    #[derive(FromQueryResult)]
    struct GroupsRes {
        master_key: Option<String>,
        count: i64,
    }
    let instant = std::time::Instant::now();

    let groups_res =
        build_groups_query(req, login_str, dt_since, dt_till, master_keys)?;

    let groups_res: Vec<GroupsRes> = groups_res
        .into_model::<GroupsRes>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut groups = vec![];
    for x in groups_res {
        let Some(master_key) = x.master_key else {
            continue;
        };
        groups.push(AnalysisStatsGroup {
            master_key,
            count: x.count,
        });
    }
    debug!("groups op took: {:?}", instant.elapsed());
    Ok(groups)
}

fn apply_metadata_filters<E>(
    query: Select<E>,
    req: &AnalysisStatsReq,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    Ok(
        filter_selected_metadata_for_analysis_stats(query, req)
            .context(h!())?,
    )
}

fn effective_groups_with_access(
    selected_groups: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Vec<String> {
    let allowed_groups_set = allowed_groups.iter().collect::<HashSet<_>>();

    selected_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())
        .map(|groups| {
            groups
                .iter()
                .filter(|group| allowed_groups_set.contains(group))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| allowed_groups.to_vec())
}

fn apply_joined_group_rows_filter<Q>(
    query: Q,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    allowed_groups: &[String],
) -> Q
where
    Q: QueryFilter,
{
    let effective_groups =
        effective_groups_with_access(selected_groups, allowed_groups);

    let query = if effective_groups.is_empty() {
        query.filter(Expr::cust("FALSE"))
    } else {
        query.filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(effective_groups),
        )
    };

    match selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        Some(selected_senders) => query.filter(
            signal_message_group::Column::Sender
                .eq_any(selected_senders.clone()),
        ),
        None => query,
    }
}

fn apply_message_aor_scope<E>(
    query: Select<E>,
    selected_aors: &Option<Vec<i64>>,
) -> Select<E>
where
    E: EntityTrait,
{
    match selected_aors_filter_condition(selected_aors) {
        Some(condition) => query.filter(condition),
        None => query,
    }
}

pub async fn count_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    let read_db = env.replica();
    let login_value = user.id().c(h!())?;
    let groups_res = build_groups_query(
        &req.0,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = groups_res.count(&read_db).await.c(h!())?;
    Ok(count as i64)
}

fn build_groups_query(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let accessible_groups = master_keys.clone();
    let groups_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .select_only()
        .column_as(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::GroupMasterKey,
            )),
            "master_key",
        )
        .column_as(
            Expr::cust(
                r#"COUNT(DISTINCT "signal_message_group"."signal_message_id")"#,
            ),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .group_by(Expr::col((
            signal_message_group::Entity,
            signal_message_group::Column::GroupMasterKey,
        )));
    let groups_res = apply_joined_group_rows_filter(
        groups_res,
        &None,
        &req.selected_senders,
        &accessible_groups,
    );
    let groups_res =
        filter_selected_freqs(groups_res, &req.selected_freqs).context(h!())?;
    let groups_res =
        filter_selected_posts(groups_res, &req.selected_posts).context(h!())?;
    let groups_res = filter_selected_units(
        groups_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let groups_res = filter_selected_locations(
        groups_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let groups_res =
        filter_selected_callsigns(groups_res, &req.selected_callsigns)
            .context(h!())?;
    let groups_res = filter_selected_networks(
        groups_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let groups_res = apply_metadata_filters(groups_res, req)?;
    let groups_res = filter_search(groups_res, &req.search).context(h!())?;
    let groups_res =
        filter_selected_aors(groups_res, &req.selected_aors).context(h!())?;
    let groups_res =
        match selected_aor_group_facet_condition(&req.selected_aors) {
            Some(condition) => groups_res.filter(condition),
            None => groups_res,
        };
    let groups_res = filter_selected_tags(
        groups_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    Ok(groups_res)
}

pub async fn fetch_senders(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_senders_for_login(&req.0, login_value.as_str(), env, master_keys)
        .await
}

pub async fn fetch_senders_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_sender_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    #[derive(FromQueryResult)]
    struct SendersRes {
        uuid: Option<String>,
        count: i64,
    }
    #[derive(FromQueryResult)]
    struct SenderFreqRes {
        uuid: Option<String>,
        freq: Option<String>,
        post_id: Option<i64>,
        count: i64,
    }
    #[derive(FromQueryResult)]
    struct SenderPerDayRes {
        uuid: Option<String>,
        date: String,
        count: i64,
    }

    let instant = std::time::Instant::now();
    let senders_query = build_senders_query(
        &&req,
        login_str,
        dt_since,
        dt_till,
        master_keys.clone(),
    )?;
    // println!(
    //     "> senders_res: {}",
    //     senders_res.build(DbBackend::Postgres).to_string()
    // );
    // println!(
    //     "> senders_res: {}",
    //     senders_res.build(DbBackend::Postgres).to_string()
    // );
    let senders_res: Vec<SendersRes> = senders_query
        .into_model::<SendersRes>()
        .all(&env.dbx)
        .await
        .context(h!())?;

    let sender_stats_groups = sender_stats_groups(&req, &master_keys);

    let freq_query =
        build_join_for_sender_stats(&sender_stats_groups, &req.selected_aors)
            .select_only()
            .column_as(signal_message_group::Column::Sender, "uuid")
            .column(sigint_inbox_item::Column::Freq)
            .column(sigint_inbox_item::Column::PostId)
            .column_as(
                Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
                "count",
            )
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
            .group_by(signal_message_group::Column::Sender)
            .group_by(sigint_inbox_item::Column::Freq)
            .group_by(sigint_inbox_item::Column::PostId);
    let freq_query = apply_sender_dimension_filters(freq_query, &req);
    let freq_query = apply_sender_filters_for_login(
        freq_query,
        &req,
        login_str,
        master_keys.clone(),
    )?;
    let freq_rows: Vec<SenderFreqRes> = freq_query
        .into_model::<SenderFreqRes>()
        .all(&env.dbx)
        .await
        .context(h!())?;

    let per_day_expr = Expr::cust_with_exprs(
        "to_char(($1 AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')::date, 'DD.MM.YYYY')",
        [Expr::col(sigint_inbox_item::Column::Datetime).into_simple_expr()],
    );
    let per_day_query =
        build_join_for_sender_stats(&sender_stats_groups, &req.selected_aors)
            .select_only()
            .column_as(signal_message_group::Column::Sender, "uuid")
            .column_as(per_day_expr.clone(), "date")
            .column_as(
                Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
                "count",
            )
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
            .group_by(signal_message_group::Column::Sender)
            .group_by(per_day_expr);
    let per_day_query = apply_sender_dimension_filters(per_day_query, &req);
    let per_day_query = apply_sender_filters_for_login(
        per_day_query,
        &req,
        login_str,
        master_keys,
    )?;
    let per_day_rows: Vec<SenderPerDayRes> = per_day_query
        .into_model::<SenderPerDayRes>()
        .all(&env.dbx)
        .await
        .context(h!())?;

    let post_ids = freq_rows
        .iter()
        .filter_map(|row| row.post_id)
        .collect::<BTreeSet<_>>();
    let post_ids = post_ids.into_iter().collect::<Vec<_>>();
    let post_names = if post_ids.is_empty() {
        BTreeMap::new()
    } else {
        sigint_post::Entity::find()
            .filter(sigint_post::Column::Id.eq_any(post_ids))
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .map(|post| (post.id, post.name))
            .collect::<BTreeMap<_, _>>()
    };
    let mut freq_map: BTreeMap<String, Vec<SenderFrequencyBreakdown>> =
        BTreeMap::new();
    for row in freq_rows {
        let Some(uuid) = row.uuid else { continue };
        let post = row.post_id.and_then(|id| post_names.get(&id).cloned());
        freq_map
            .entry(uuid)
            .or_default()
            .push(SenderFrequencyBreakdown {
                freq: row.freq,
                post,
                count: row.count,
            });
    }

    let mut per_day_map: BTreeMap<String, BTreeMap<String, i64>> =
        BTreeMap::new();
    for row in per_day_rows {
        let Some(uuid) = row.uuid else { continue };
        per_day_map
            .entry(uuid)
            .or_default()
            .entry(row.date)
            .and_modify(|c| *c += row.count)
            .or_insert(row.count);
    }

    let mut senders = vec![];
    for x in senders_res {
        let Some(uuid) = x.uuid else { continue };
        let freq_breakdown = freq_map.get(&uuid).cloned().unwrap_or_default();
        let per_day = per_day_map.get(&uuid).cloned().unwrap_or_default();
        senders.push(AnalysisStatsSender {
            uuid,
            count: x.count,
            freq_breakdown,
            per_day,
        });
    }
    debug!("senders op took: {:?}", instant.elapsed());
    Ok(senders)
}

pub async fn count_senders(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();
    let login_value = user.id().context(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res = build_senders_query(
        &req,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_senders_query(
    req: &&Json<AnalysisStatsReq>,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let sender_stats_groups = sender_stats_groups(req, &master_keys);
    let senders_res =
        build_join_for_sender_stats(&sender_stats_groups, &req.selected_aors)
            .select_only()
            .column_as(signal_message_group::Column::Sender, "uuid")
            .column_as(
                Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
                "count",
            )
            // .filter(signal_message::Column::DuplicateOf.is_null())
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
            // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
            .group_by(signal_message_group::Column::Sender);
    let senders_res = apply_sender_dimension_filters(senders_res, req);
    let senders_res = filter_selected_groups_and_senders_with_access(
        senders_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let senders_res = filter_selected_freqs(senders_res, &req.selected_freqs)
        .context(h!())?;
    let senders_res = filter_selected_posts(senders_res, &req.selected_posts)
        .context(h!())?;
    let senders_res = filter_selected_units(
        senders_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let senders_res = filter_selected_locations(
        senders_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let senders_res =
        filter_selected_callsigns(senders_res, &req.selected_callsigns)
            .context(h!())?;
    let senders_res = filter_selected_tags(
        senders_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let senders_res = filter_selected_networks(
        senders_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let senders_res = apply_metadata_filters(senders_res, &req.0)?;
    let senders_res = filter_search(senders_res, &req.search).context(h!())?;
    Ok(senders_res)
}

fn sender_stats_groups(
    req: &Json<AnalysisStatsReq>,
    master_keys: &[String],
) -> Vec<String> {
    effective_groups_with_access(&req.selected_groups, master_keys)
}

fn build_join_for_sender_stats(
    sender_stats_groups: &[String],
    selected_aors: &Option<Vec<i64>>,
) -> Select<Entity> {
    let sender_stats_groups = sender_stats_groups.to_vec();

    let query = build_join_for_sigint_inbox_item().join(
        JoinType::InnerJoin,
        signal_message::Relation::SignalMessageGroup.def(),
    );

    if sender_stats_groups.is_empty() {
        query.filter(Expr::cust("FALSE"))
    } else {
        let query = query.filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(sender_stats_groups),
        );
        apply_message_aor_scope(query, selected_aors)
    }
}

fn apply_sender_dimension_filters(
    query: Select<Entity>,
    req: &Json<AnalysisStatsReq>,
) -> Select<Entity> {
    match req
        .selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        Some(selected_senders) => query.filter(
            signal_message_group::Column::Sender
                .eq_any(selected_senders.clone()),
        ),
        None => query,
    }
}

fn apply_sender_filters_for_login<E>(
    query: Select<E>,
    req: &Json<AnalysisStatsReq>,
    login_str: &str,
    master_keys: Vec<String>,
) -> Result<Select<E>, AppError>
where
    E: EntityTrait,
{
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let query = filter_selected_groups_and_senders_with_access(
        query,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let query =
        filter_selected_freqs(query, &req.selected_freqs).context(h!())?;
    let query =
        filter_selected_posts(query, &req.selected_posts).context(h!())?;
    let query = filter_selected_units(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let query = filter_selected_locations(
        query,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let query = filter_selected_callsigns(query, &req.selected_callsigns)
        .context(h!())?;
    let query = filter_selected_tags(
        query,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let query = filter_selected_networks(
        query,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let query = apply_metadata_filters(query, &req.0)?;
    let query = filter_search(query, &req.search).context(h!())?;
    let query =
        filter_selected_aors(query, &req.selected_aors).context(h!())?;
    if !master_keys.is_empty() {
        return Ok(query.filter(message_in_groups_exists(master_keys)));
    }
    Ok(query)
}

pub async fn fetch_posts(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsPost>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if should_read_stats_aggregated(req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_post_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct PostsRes {
        post: String,
        count: i64,
    }
    let post_res =
        build_posts_query(&req, &user, master_keys, dt_since, dt_till)?;
    println!("test q: {}", post_res.build(DbBackend::Postgres));
    let post_res: Vec<PostsRes> = post_res
        .into_model::<PostsRes>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut posts = vec![];
    for x in post_res {
        posts.push(AnalysisStatsPost {
            post: x.post,
            count: x.count,
        });
    }
    debug!("posts op took: {:?}", instant.elapsed());
    Ok(posts)
}

pub async fn count_posts(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res =
        build_posts_query(&req, &user, master_keys, dt_since, dt_till)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}
fn build_posts_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let post_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::col((sigint_post::Entity, sigint_post::Column::Name))
                .if_null(""),
            "post",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let post_res = filter_selected_groups_and_senders_with_access(
        post_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let post_res = filter_selected_units(
        post_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let post_res =
        filter_selected_freqs(post_res, &req.selected_freqs).context(h!())?;
    let post_res =
        filter_selected_posts(post_res, &req.selected_posts).context(h!())?;
    let post_res = filter_selected_locations(
        post_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let post_res = filter_selected_callsigns(post_res, &req.selected_callsigns)
        .context(h!())?;
    let post_res = filter_selected_tags(
        post_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        &user.id().context(h!())?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let post_res = filter_selected_networks(
        post_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let post_res = apply_metadata_filters(post_res, &req.0)?;
    let post_res = filter_search(post_res, &req.search).context(h!())?;
    let post_res =
        filter_selected_aors(post_res, &req.selected_aors).context(h!())?;
    Ok(post_res)
}

pub async fn fetch_freqs(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_freqs_for_login(&req.0, login_value.as_str(), env, master_keys).await
}

pub async fn fetch_freqs_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsFreq>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let req_json = Json(req.clone());

    if should_read_stats_aggregated(&req_json, env, dt_since, dt_till)
        .c(h!())?
    {
        let result = read_frequency_stats_aggregated(
            env,
            master_keys,
            dt_since,
            dt_till,
        )
        .await
        .c(h!())?;
        return Ok(result);
    }

    let _instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct FreqsRes {
        freq: String,
        count: i64,
    }
    let freqs_res =
        build_freqs_query(req, login_str, dt_since, dt_till, master_keys)?;
    // debug!(
    //     "> freqs_res: {}",
    //     freqs_res.build(DbBackend::Postgres).to_string()
    // );

    let new_freqs = get_new_freqs(&env.dbx, dt_since, dt_till)
        .await
        .context(h!())?;
    let freqs = freqs_res
        .into_model::<FreqsRes>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|f| AnalysisStatsFreq {
            is_new: new_freqs.contains(&f.freq),
            freq: f.freq,
            count: f.count,
        })
        .collect::<Vec<AnalysisStatsFreq>>();

    // debug!("freqs op took: {:?}", instant.elapsed());
    Ok(freqs)
}

pub(crate) async fn get_new_freqs(
    db: &DatabaseConnection,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Vec<String>, AppError> {
    const COMPARISON_PERIOD_DAYS: u8 = 10;
    let comparison_period_start = dt_since
        - Duration::try_days(COMPARISON_PERIOD_DAYS.into())
            .context(h!())
            .map_err(Into::<AppError>::into)?;

    let date_time_col = sigint_inbox_item::Column::Datetime;
    let query = sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .distinct()
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .filter(date_time_col.gte(dt_since))
        .filter(date_time_col.lte(dt_till))
        .filter(
            sigint_inbox_item::Column::Freq.not_in_subquery(
                Query::select()
                    .column(sigint_inbox_item::Column::Freq)
                    .distinct()
                    .and_where(sigint_inbox_item::Column::Freq.is_not_null())
                    .and_where(date_time_col.lt(dt_since))
                    .and_where(date_time_col.gt(comparison_period_start))
                    .from(sigint_inbox_item::Entity)
                    .to_owned(),
            ),
        )
        .order_by_asc(sigint_inbox_item::Column::Freq);

    trace!(
        "> get_new_freqs query: {}",
        query.build(DbBackend::Postgres)
    );

    let new_freqs = query.into_tuple::<String>().all(db).await.context(h!())?;

    Ok(new_freqs)
}

pub async fn count_freqs(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let login_value = user.id().c(h!())?;
    let groups_res = build_freqs_query(
        &req.0,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_freqs_query(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let freqs_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::col(sigint_inbox_item::Column::Freq).if_null(""),
            "freq",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let freqs_res = filter_selected_groups_and_senders_with_access(
        freqs_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let freqs_res = filter_selected_units(
        freqs_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let freqs_res = filter_selected_posts(freqs_res, &req.selected_posts)?;
    let freqs_res = filter_selected_locations(
        freqs_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let freqs_res =
        filter_selected_callsigns(freqs_res, &req.selected_callsigns)
            .context(h!())?;
    let freqs_res = filter_selected_tags(
        freqs_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let freqs_res = filter_selected_networks(
        freqs_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let freqs_res = apply_metadata_filters(freqs_res, req)?;
    let freqs_res = filter_search(freqs_res, &req.search).context(h!())?;
    let freqs_res =
        filter_selected_aors(freqs_res, &req.selected_aors).context(h!())?;
    Ok(freqs_res)
}

pub async fn fetch_callsigns(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_callsigns_for_login(&req.0, login_value.as_str(), env, master_keys)
        .await
}

pub async fn fetch_callsigns_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_callsign_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct CallsignsRes {
        callsign: Option<String>,
        count: i64,
    }
    let callsigns_res = build_callsigns_query(
        &req.0,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )?;
    // println!(
    //     "> callsigns_res: {}",
    //     callsigns_res.build(DbBackend::Postgres).to_string()
    // );
    let callsigns_res: Vec<CallsignsRes> = callsigns_res
        .into_model::<CallsignsRes>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut callsigns = vec![];
    for x in callsigns_res {
        let Some(callsign) = x.callsign else { continue };
        callsigns.push(AnalysisStatsCallsign {
            callsign,
            count: x.count,
        });
    }

    debug!("callsigns op took: {:?}", instant.elapsed());
    Ok(callsigns)
}

pub async fn count_callsigns(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let login_value = user.id().c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res = build_callsigns_query(
        &req.0,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

pub async fn fetch_metadata_stats(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<MetadataStatsRsp, AppError> {
    let login_value = user.id().context(h!())?;
    fetch_metadata_stats_for_login(
        &req.0,
        login_value.as_str(),
        env,
        master_keys,
    )
    .await
}

pub async fn fetch_metadata_stats_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<MetadataStatsRsp, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let messages_q = build_metadata_messages_query(
        &req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )
    .context(h!())?;

    let ccs = fetch_metadata_value_stats(
        &env.dbx,
        messages_q.clone(),
        sigint_inbox_item_metadata::Column::ColorCode,
    )
    .await
    .context(h!())?;
    let hashes = fetch_metadata_value_stats(
        &env.dbx,
        messages_q.clone(),
        sigint_inbox_item_metadata::Column::HashId,
    )
    .await
    .context(h!())?;
    let senders = fetch_metadata_value_stats(
        &env.dbx,
        messages_q.clone(),
        sigint_inbox_item_metadata::Column::SenderId,
    )
    .await
    .context(h!())?;
    let receivers = fetch_metadata_value_stats(
        &env.dbx,
        messages_q.clone(),
        sigint_inbox_item_metadata::Column::CallGroupId,
    )
    .await
    .context(h!())?;

    Ok(MetadataStatsRsp {
        ccs,
        senders,
        receivers,
        hashes,
    })
}

fn build_metadata_messages_query(
    req: &Json<AnalysisStatsReq>,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let messages_q = build_join_for_sigint_inbox_item()
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    apply_sender_filters_for_login(messages_q, req, login_str, master_keys)
}

#[derive(FromQueryResult)]
struct MetadataValueRes {
    value: Option<String>,
    count: i64,
}

async fn fetch_metadata_value_stats(
    db: &DatabaseConnection,
    messages_q: Select<sigint_inbox_item::Entity>,
    column: sigint_inbox_item_metadata::Column,
) -> Result<Vec<AnalysisStatsMetadataValue>, AppError> {
    let messages_subquery = messages_q
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .to_owned()
        .into_query();
    let metadata_res: Vec<MetadataValueRes> = sigint_inbox_item_metadata::Entity::find()
        .select_only()
        .column_as(
            Expr::col((sigint_inbox_item_metadata::Entity, column)).if_null(""),
            "value",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "sigint_inbox_item_metadata"."sigint_inbox_item_id")"#),
            "count",
        )
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId
                .in_subquery(messages_subquery),
        )
        .filter(Expr::col((sigint_inbox_item_metadata::Entity, column)).is_not_null())
        .filter(
            Expr::col((sigint_inbox_item_metadata::Entity, column)).ne(""),
        )
        .group_by(Expr::cust("1"))
        .order_by_desc(Expr::cust("2"))
        .order_by_asc(Expr::cust("1"))
        .into_model::<MetadataValueRes>()
        .all(db)
        .await
        .context(h!())?;

    Ok(metadata_res
        .into_iter()
        .filter_map(|row| {
            row.value.and_then(|value| {
                let value = value.trim().to_string();
                if value.is_empty() {
                    None
                } else {
                    Some(AnalysisStatsMetadataValue {
                        value,
                        count: row.count,
                    })
                }
            })
        })
        .collect())
}

fn build_callsigns_query(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let callsigns_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::cust("jsonb_array_elements_text(callsigns)"),
            "callsign",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(SimpleExpr::Custom("callsign".to_string()));
    let callsigns_res = filter_selected_groups_and_senders_with_access(
        callsigns_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )?;
    let callsigns_res =
        filter_selected_freqs(callsigns_res, &req.selected_freqs)?;
    let callsigns_res =
        filter_selected_posts(callsigns_res, &req.selected_posts)?;
    let callsigns_res = filter_selected_units(
        callsigns_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let callsigns_res = filter_selected_locations(
        callsigns_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let callsigns_res = filter_selected_tags(
        callsigns_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let callsigns_res = filter_selected_networks(
        callsigns_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let callsigns_res = apply_metadata_filters(callsigns_res, req)?;
    let callsigns_res = filter_search(callsigns_res, &req.search)?;
    let callsigns_res = filter_selected_aors(callsigns_res, &req.selected_aors)
        .context(h!())?;
    Ok(callsigns_res)
}

pub async fn fetch_tags(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_tags_for_login(&req.0, login_value.as_str(), env, master_keys).await
}

pub async fn fetch_tags_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if req.without_model_tags != Some(true)
        && should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())?
    {
        let result =
            read_tag_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct TagsRes {
        tag_id: i64,
        count: i64,
    }
    let tags_res =
        build_tags_query(&req.0, login_str, dt_since, dt_till, master_keys)?;

    let tags_res: Vec<TagsRes> = tags_res
        .into_model::<TagsRes>()
        .all(&env.dbx)
        .await
        .c(h!())?;

    let tags: Vec<_> = tags_res
        .iter()
        .map(|item| AnalysisStatsTag {
            tag_id: item.tag_id,
            count: item.count,
        })
        .collect();

    if instant.elapsed().as_secs() > 4 {
        debug!("tags op took: {:?}; req: {:?}", instant.elapsed(), req);
    } else if instant.elapsed().as_secs() > 1 {
        debug!("tags op took: {:?}", instant.elapsed());
    }

    Ok(tags)
}

pub async fn count_tags(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let login_value = user.id().c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res = build_tags_query(
        &req.0,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_tags_query(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let mut tags_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_tag::Relation::SigintInboxItem
                .def()
                .rev()
                .on_condition(|_left, right| {
                    Expr::col((
                        right,
                        sigint_inbox_item_tag::Column::Confidence,
                    ))
                    .gte(TAG_MINIMUM_CONFIDENCE)
                    .into_condition()
                }),
        )
        .select_only()
        .column(sigint_inbox_item_tag::Column::TagId)
        .column_as(Expr::count(Expr::val(1)), "count")
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .group_by(sigint_inbox_item_tag::Column::TagId);
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
    if req.without_model_tags == Some(true) {
        tags_res =
            tags_res.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }
    let tags_res = filter_selected_groups_and_senders_with_access(
        tags_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )?;
    let tags_res = filter_selected_freqs(tags_res, &req.selected_freqs)?;
    let tags_res = filter_selected_posts(tags_res, &req.selected_posts)?;
    let tags_res = filter_selected_units(
        tags_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let tags_res = filter_selected_locations(
        tags_res,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let tags_res =
        filter_selected_callsigns(tags_res, &req.selected_callsigns)?;
    let tags_res = filter_selected_tags(
        tags_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let tags_res = filter_selected_networks(
        tags_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let tags_res = apply_metadata_filters(tags_res, req)?;
    let tags_res = filter_search(tags_res, &req.search)?;
    let tags_res =
        filter_selected_aors(tags_res, &req.selected_aors).context(h!())?;
    Ok(tags_res)
}

pub async fn fetch_units(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsUnit>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if should_read_stats_aggregated(req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_unit_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct UnitsRes {
        unit: Option<String>,
        count: i64,
    }
    let units_res =
        build_units_query(&req, &user, dt_since, dt_till, master_keys)?;
    // println!(
    //     "> units_res: {}",
    //     units_res.build(DbBackend::Postgres).to_string()
    // );
    let units_res: Vec<UnitsRes> = units_res
        .into_model::<UnitsRes>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut units = vec![];
    for x in units_res {
        let unit = m_unit_to_unidenfitied(x.unit);
        units.push(AnalysisStatsUnit {
            count: x.count,
            unit,
        });
    }

    // let units = vec![];

    debug!("units op took: {:?}", instant.elapsed());
    Ok(units)
}

pub async fn count_units(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res =
        build_units_query(&req, &user, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

pub async fn count_unit_exact_match_breakdown(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let mut exact_req = req.0.clone();
    exact_req.units_exact_match_only = Some(true);
    let (_, exact_matches_count) =
        fetch_counts(&Json(exact_req), user, env, master_keys.clone())
            .await
            .context(h!())?;

    let mut combined_req = req.0.clone();
    combined_req.units_exact_match_only = Some(false);
    let (_, total_matches_count) =
        fetch_counts(&Json(combined_req), user, env, master_keys)
            .await
            .context(h!())?;

    let non_exact_matches_count =
        (total_matches_count - exact_matches_count).max(0);

    Ok((exact_matches_count, non_exact_matches_count))
}

fn build_units_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let units_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::col(sigint_inbox_item::Column::UnitV2).if_null(""),
            "unit",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let units_res = filter_selected_groups_and_senders_with_access(
        units_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let units_res =
        filter_selected_freqs(units_res, &req.selected_freqs).context(h!())?;
    let units_res =
        filter_selected_posts(units_res, &req.selected_posts).context(h!())?;
    let units_res = filter_selected_locations(
        units_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let units_res =
        filter_selected_callsigns(units_res, &req.selected_callsigns)
            .context(h!())?;
    let units_res = filter_selected_tags(
        units_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        &user.id().context(h!())?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let units_res = filter_selected_networks(
        units_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let units_res = apply_metadata_filters(units_res, &req.0)?;
    let units_res = filter_search(units_res, &req.search).context(h!())?;
    let units_res =
        filter_selected_aors(units_res, &req.selected_aors).context(h!())?;
    Ok(units_res)
}

pub async fn fetch_locations(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_locations_for_login(&req.0, login_value.as_str(), env, master_keys)
        .await
}

pub async fn fetch_locations_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsLocation>, AppError> {
    let req = Json(req.clone());
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    if should_read_stats_aggregated(&req, env, dt_since, dt_till).c(h!())? {
        let result =
            read_location_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct LocationsRes {
        location: Option<String>,
        count: i64,
    }
    let locations_res = build_locations_query_for_login(
        &req.0,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )?;
    // println!(
    //     "> locations_res: {}",
    //     locations_res.build(DbBackend::Postgres).to_string()
    // );
    let locations_res = locations_res
        .into_model::<LocationsRes>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|l| (l.location, l.count))
        .collect_vec();
    let mut locations = vec![];
    for (location, count) in locations_res {
        let location = m_location_to_unidenfitied(location);
        to_location_list(&location)
            .into_iter()
            .for_each(|location| {
                // variable already named `location`; redundant rebind removed
                locations.push(AnalysisStatsLocation { count, location });
            });
    }
    debug!("locations op took: {:?}", instant.elapsed());
    Ok(locations)
}

pub async fn count_locations(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res =
        build_locations_query(&req, &user, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_locations_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let login_value = user.id().context(h!())?;
    build_locations_query_for_login(
        &req.0,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )
}

fn build_locations_query_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let locations_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::col(sigint_inbox_item::Column::LocationV2).if_null(""),
            "location",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let locations_res = filter_selected_groups_and_senders_with_access(
        locations_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let locations_res = filter_selected_units(
        locations_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let locations_res =
        filter_selected_freqs(locations_res, &req.selected_freqs)
            .context(h!())?;
    let locations_res =
        filter_selected_posts(locations_res, &req.selected_posts)
            .context(h!())?;
    let locations_res = filter_selected_locations(
        locations_res,
        &req.selected_locations,
        req.include_peleng_locations.unwrap_or(false),
    )
    .context(h!())?;
    let locations_res =
        filter_selected_callsigns(locations_res, &req.selected_callsigns)
            .context(h!())?;
    let locations_res = filter_selected_tags(
        locations_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let locations_res = filter_selected_networks(
        locations_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let locations_res = apply_metadata_filters(locations_res, req)?;
    let locations_res =
        filter_search(locations_res, &req.search).context(h!())?;
    let locations_res = filter_selected_aors(locations_res, &req.selected_aors)
        .context(h!())
        .context(h!())?;
    Ok(locations_res)
}

pub async fn fetch_aors(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_aors_for_login(&req.0, login_value.as_str(), env, master_keys).await
}

pub async fn fetch_aors_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsAor>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let req_json = Json(req.clone());

    if should_read_stats_aggregated(&req_json, env, dt_since, dt_till)
        .c(h!())?
    {
        let result =
            read_aor_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(result);
    }

    let instant = std::time::Instant::now();
    let stmt =
        build_aors_query(req, login_str, dt_since, dt_till, master_keys)?;
    let aors_res: Vec<AorsRes> = AorsRes::find_by_statement(stmt)
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut aors = vec![];
    for x in aors_res {
        aors.push(AnalysisStatsAor {
            count: x.count,
            aor_id: x.aor_id,
        });
    }
    debug!("aors op took: {:?}", instant.elapsed());
    Ok(aors)
}

#[derive(FromQueryResult)]
struct AorsRes {
    aor_id: i64,
    count: i64,
}

pub async fn count_aors(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    if should_read_stats_aggregated(req, env, dt_since, dt_till).c(h!())? {
        let aors =
            read_aor_stats_aggregated(env, master_keys, dt_since, dt_till)
                .await
                .c(h!())?;
        return Ok(aors.len() as i64);
    }

    let login_value = user.id().c(h!())?;
    let stmt = build_aors_query(
        &req.0,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )?;
    let count = AorsRes::find_by_statement(stmt)
        .all(&read_db)
        .await
        .context(h!())?
        .len();
    Ok(count as i64)
}

fn build_aors_query(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Statement, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let messages_q = sigint_inbox_item::Entity::find()
        .select_only()
        .column_as(
            Expr::cust(r#"DISTINCT "signal_message"."id""#),
            "message_id",
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let messages_q = apply_joined_group_rows_filter(
        messages_q,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    );
    let messages_q =
        filter_selected_freqs(messages_q, &req.selected_freqs).context(h!())?;
    let messages_q =
        filter_selected_posts(messages_q, &req.selected_posts).context(h!())?;
    let messages_q = filter_selected_locations(
        messages_q,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let messages_q =
        filter_selected_callsigns(messages_q, &req.selected_callsigns)
            .context(h!())?;
    let messages_q = filter_selected_tags(
        messages_q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let messages_q = filter_search(messages_q, &req.search).context(h!())?;
    let messages_q = apply_metadata_filters(messages_q, req)?;
    let messages_q =
        filter_selected_aors(messages_q, &req.selected_aors).context(h!())?;

    let messages_cte_alias = Alias::new("messages_aor_cte");
    let messages_alias = Alias::new("messages_aor");
    let group_message_alias = Alias::new("group_message_aor");
    let group_aor_alias = Alias::new("group_aor_link");
    let group_value_alias = Alias::new("group_aor_value");
    let network_message_alias = Alias::new("network_message_aor");
    let network_alias = Alias::new("network_aor");
    let network_aor_alias = Alias::new("network_aor_link");
    let network_value_alias = Alias::new("network_aor_value");

    let mut group_message_aors = Query::select()
        .expr_as(
            Expr::col((messages_alias.clone(), Alias::new("message_id"))),
            Alias::new("message_id"),
        )
        .expr_as(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
            Alias::new("aor_id"),
        )
        .from_as(messages_cte_alias.clone(), messages_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            signal_message_group::Entity,
            group_message_alias.clone(),
            Condition::all().add(
                Expr::col((
                    group_message_alias.clone(),
                    signal_message_group::Column::SignalMessageId,
                ))
                .equals((messages_alias.clone(), Alias::new("message_id"))),
            ),
        )
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
                    group_message_alias,
                    signal_message_group::Column::GroupMasterKey,
                )),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            group_value_alias.clone(),
            Expr::col((group_aor_alias, signal_group_aor::Column::AorId))
                .equals((
                    group_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
        )
        .and_where(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(
            Expr::col((
                group_value_alias.clone(),
                area_of_responsibility::Column::IsTopLevel,
            ))
            .eq(true),
        )
        .to_owned();
    if let Some(condition) = selected_aor_overlap_condition(
        group_value_alias.clone(),
        &req.selected_aors,
    ) {
        group_message_aors.cond_where(condition);
    }

    let mut network_message_aors = Query::select()
        .expr_as(
            Expr::col((messages_alias.clone(), Alias::new("message_id"))),
            Alias::new("message_id"),
        )
        .expr_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::Id,
            )),
            Alias::new("aor_id"),
        )
        .from_as(messages_cte_alias.clone(), messages_alias.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            network_message_alias.clone(),
            Condition::all().add(
                Expr::col((
                    network_message_alias.clone(),
                    sigint_inbox_item_network::Column::SigintInboxItemId,
                ))
                .equals((messages_alias, Alias::new("message_id"))),
            ),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            network_alias.clone(),
            Condition::all().add(
                Expr::col((network_alias.clone(), sigint_network::Column::Id))
                    .equals((
                        network_message_alias,
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
            network_value_alias.clone(),
            Expr::col((network_aor_alias, sigint_network_aor::Column::AorId))
                .equals((
                    network_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
        )
        .and_where(
            Expr::col((network_alias, sigint_network::Column::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::Deleted,
            ))
            .eq(false),
        )
        .and_where(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::IsTopLevel,
            ))
            .eq(true),
        )
        .to_owned();
    if let Some(condition) = selected_aor_overlap_condition(
        network_value_alias.clone(),
        &req.selected_aors,
    ) {
        network_message_aors.cond_where(condition);
    }

    let sql = format!(
        "WITH {messages_cte} AS ({messages_sql}) \
         SELECT aor_id, COUNT(DISTINCT message_id) AS count \
         FROM ({group_sql} UNION ALL {network_sql}) AS message_aors \
         GROUP BY 1",
        messages_cte = messages_cte_alias.to_string(),
        messages_sql = messages_q.into_query().to_string(PostgresQueryBuilder),
        group_sql = group_message_aors.to_string(PostgresQueryBuilder),
        network_sql = network_message_aors.to_string(PostgresQueryBuilder),
    );

    Ok(Statement::from_string(DbBackend::Postgres, sql))
}

#[derive(FromQueryResult)]
struct NetworksRes {
    network_id: Option<i64>,
    msg_count: i64,
}

pub async fn fetch_networks(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsNetwork>, AppError> {
    let login_value = user.id().c(h!())?;
    fetch_networks_for_login(
        &req.0,
        login_value.as_str(),
        &env.dbx,
        master_keys,
    )
    .await
}

pub async fn fetch_networks_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    db: &DatabaseConnection,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsNetwork>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();

    let networks_query = build_networks_query_for_login(
        req,
        login_str,
        dt_since,
        dt_till,
        master_keys,
    )?;

    let stmt = Statement::from_string(
        DbBackend::Postgres,
        networks_query.to_string(PostgresQueryBuilder),
    );

    let networks_res: Vec<NetworksRes> =
        NetworksRes::find_by_statement(stmt).all(db).await.c(h!())?;

    let mut networks = vec![];
    for x in networks_res {
        let Some(network_id) = x.network_id else {
            continue;
        };
        networks.push(AnalysisStatsNetwork {
            network_id,
            count: x.msg_count,
        });
    }
    debug!("networks op took: {:?}", instant.elapsed());
    Ok(networks)
}

pub async fn count_networks(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let networks_query =
        build_networks_query(&req.0, user, dt_since, dt_till, master_keys)?;

    // println!(
    //     "> network count res sql: {}",
    //     networks_query.to_string(PostgresQueryBuilder)
    // );

    let stmt = Statement::from_string(
        DbBackend::Postgres,
        networks_query.to_string(PostgresQueryBuilder),
    );

    let networks_res: Vec<NetworksRes> = NetworksRes::find_by_statement(stmt)
        .all(&read_db)
        .await
        .c(h!())?;

    let res = networks_res.len() as i64;

    Ok(res)
}

fn build_networks_query(
    req: &AnalysisStatsReq,
    user: &Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<WithQuery, AppError> {
    let login_value = user.id().c(h!())?;
    build_networks_query_for_login(
        req,
        login_value.as_str(),
        dt_since,
        dt_till,
        master_keys,
    )
}

fn network_stats_group_join_condition(
    message_alias: Alias,
    group_alias: Alias,
    network_left: SimpleExpr,
    network_right: SimpleExpr,
) -> Condition {
    Condition::all()
        .add(
            Expr::col((message_alias, Alias::new("group_master_key")))
                .equals((group_alias.clone(), Alias::new("master_key"))),
        )
        .add(group_network_aor_overlap_condition(
            group_alias,
            network_left,
            network_right,
        ))
}

fn group_network_aor_overlap_condition(
    group_alias: Alias,
    network_left: SimpleExpr,
    network_right: SimpleExpr,
) -> Condition {
    Condition::any()
        .add(
            Condition::all()
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_left")))
                        .gte(network_left.clone()),
                )
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_left")))
                        .lte(network_right.clone()),
                ),
        )
        .add(
            Condition::all()
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_right")))
                        .gte(network_left.clone()),
                )
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_right")))
                        .lte(network_right.clone()),
                ),
        )
        .add(
            Condition::all()
                .add(
                    Expr::col((group_alias.clone(), Alias::new("g_left")))
                        .lte(network_left),
                )
                .add(
                    Expr::col((group_alias, Alias::new("g_right")))
                        .gte(network_right),
                ),
        )
}

fn build_networks_query_for_login(
    req: &AnalysisStatsReq,
    login_str: &str,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<WithQuery, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    // Aliases for CTEs
    let messages_cte_alias = Alias::new("messages_cte");
    let networks_cte_alias = Alias::new("networks_cte");
    let groups_cte_alias = Alias::new("groups_cte");
    let network_value_alias = Alias::new("networks_cte_aor");

    // 1) messages_cte
    let messages_q = sigint_inbox_item::Entity::find()
        .select_only()
        .column_as(Expr::cust(r#"DISTINCT "signal_message"."id""#), "dedup_key")
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Datetime)
        .column_as(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::GroupMasterKey,
            )),
            "group_master_key",
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(master_keys.clone()))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    let messages_q = apply_joined_group_rows_filter(
        messages_q,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    );

    // 2) networks_cte
    let networks_q = sigint_network_freq::Entity::find()
        .select_only()
        .column_as(sigint_network::Column::Id, "network_id")
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveFrom)
        .column(sigint_network_freq::Column::ActiveTo)
        .column_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::LeftBound,
            )),
            "n_left",
        )
        .column_as(
            Expr::col((
                network_value_alias.clone(),
                area_of_responsibility::Column::RightBound,
            )),
            "n_right",
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
            network_value_alias.clone(),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false));
    let networks_q = if req
        .selected_aors
        .as_ref()
        .map(|aors| !aors.is_empty())
        .unwrap_or(false)
    {
        let network_scope_link_alias = Alias::new("network_scope_link");
        let network_scope_value_alias = Alias::new("network_scope_value");
        let mut network_scope_exists = Query::select();
        network_scope_exists
            .expr(Expr::value(1))
            .from_as(
                sigint_network_aor::Entity,
                network_scope_link_alias.clone(),
            )
            .join_as(
                JoinType::InnerJoin,
                area_of_responsibility::Entity,
                network_scope_value_alias.clone(),
                Expr::col((
                    network_scope_link_alias.clone(),
                    sigint_network_aor::Column::AorId,
                ))
                .equals((
                    network_scope_value_alias.clone(),
                    area_of_responsibility::Column::Id,
                )),
            )
            .and_where(
                Expr::col((
                    network_scope_link_alias,
                    sigint_network_aor::Column::NetworkId,
                ))
                .equals((sigint_network::Entity, sigint_network::Column::Id)),
            );
        if let Some(condition) = selected_aor_overlap_condition(
            network_scope_value_alias,
            &req.selected_aors,
        ) {
            network_scope_exists.cond_where(condition);
        }
        networks_q.filter(Expr::exists(network_scope_exists.to_owned()))
    } else {
        networks_q
    };

    // 3) groups_cte
    let groups_q = signal_group::Entity::find()
        .select_only()
        .column(signal_group::Column::MasterKey)
        .column_as(area_of_responsibility::Column::LeftBound, "g_left")
        .column_as(area_of_responsibility::Column::RightBound, "g_right")
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_group_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false));
    let effective_groups =
        effective_groups_with_access(&req.selected_groups, &master_keys);
    let groups_q = if effective_groups.is_empty() {
        groups_q.filter(Expr::cust("FALSE"))
    } else {
        groups_q
            .filter(signal_group::Column::MasterKey.eq_any(effective_groups))
    };
    // add more custom filters to the messages CTE
    let messages_q =
        filter_selected_freqs(messages_q, &req.selected_freqs).context(h!())?;
    let messages_q =
        filter_selected_posts(messages_q, &req.selected_posts).context(h!())?;
    let messages_q = filter_selected_units(
        messages_q,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let messages_q = filter_selected_locations(
        messages_q,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let messages_q =
        filter_selected_callsigns(messages_q, &req.selected_callsigns)
            .context(h!())?;
    let messages_q =
        filter_selected_aors(messages_q, &req.selected_aors).context(h!())?;
    let messages_q = filter_selected_networks(
        messages_q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let messages_q = apply_metadata_filters(messages_q, req)?;
    let messages_q = filter_search(messages_q, &req.search).context(h!())?;
    let messages_q = filter_selected_tags(
        messages_q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;

    let messages_cte = CommonTableExpression::new()
        .query(messages_q.into_query().to_owned())
        .table_name(messages_cte_alias.clone())
        .to_owned();

    let networks_cte = CommonTableExpression::new()
        .query(networks_q.into_query().to_owned())
        .table_name(networks_cte_alias.clone())
        .to_owned();

    let groups_cte = CommonTableExpression::new()
        .query(groups_q.into_query().to_owned())
        .table_name(groups_cte_alias.clone())
        .to_owned();

    // Main SELECT
    let m = Alias::new("m");
    let n = Alias::new("n");
    let g = Alias::new("g");

    let mut freq_matches_q = Query::select();
    freq_matches_q
        .distinct()
        .expr_as(
            Expr::col((m.clone(), Alias::new("dedup_key"))),
            Alias::new("dedup_key"),
        )
        .expr_as(
            Expr::col((n.clone(), Alias::new("network_id"))),
            Alias::new("network_id"),
        )
        .from_as(messages_cte_alias.clone(), m.clone())
        .join_as(
            JoinType::InnerJoin,
            networks_cte_alias.clone(),
            n.clone(),
            Condition::all()
                .add(Expr::col((m.clone(), Alias::new("freq"))).equals((n.clone(), Alias::new("freq"))))
                .add(Expr::col((n.clone(), Alias::new("freq"))).is_not_null())
                .add(Expr::col((m.clone(), Alias::new("datetime"))).gte(Expr::col((n.clone(), Alias::new("active_from")))))
                .add(
                    Expr::col((m.clone(), Alias::new("datetime")))
                        .lte(Expr::cust("COALESCE(n.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')"))
                    ),
        )
        .join_as(
            JoinType::InnerJoin,
            groups_cte_alias.clone(),
            g.clone(),
            network_stats_group_join_condition(
                m.clone(),
                g.clone(),
                Expr::col((n.clone(), Alias::new("n_left"))).into(),
                Expr::col((n.clone(), Alias::new("n_right"))).into(),
            ),
        );

    let linked_m = Alias::new("linked_m");
    let linked_network_link = Alias::new("linked_network_link");
    let linked_network = Alias::new("linked_network");
    let linked_network_aor = Alias::new("linked_network_aor");
    let linked_network_value = Alias::new("linked_network_value");
    let linked_g = Alias::new("linked_g");

    let mut linked_matches_q = Query::select();
    linked_matches_q
        .distinct()
        .expr_as(
            Expr::col((linked_m.clone(), Alias::new("dedup_key"))),
            Alias::new("dedup_key"),
        )
        .expr_as(
            Expr::col((
                linked_network_link.clone(),
                sigint_inbox_item_network::Column::SigintNetworkId,
            )),
            Alias::new("network_id"),
        )
        .from_as(messages_cte_alias.clone(), linked_m.clone())
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            linked_network_link.clone(),
            Expr::col((
                linked_network_link.clone(),
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((linked_m.clone(), Alias::new("dedup_key"))),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Entity,
            linked_network.clone(),
            Expr::col((linked_network.clone(), sigint_network::Column::Id))
                .equals((
                    linked_network_link.clone(),
                    sigint_inbox_item_network::Column::SigintNetworkId,
                )),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_aor::Entity,
            linked_network_aor.clone(),
            Expr::col((
                linked_network_aor.clone(),
                sigint_network_aor::Column::NetworkId,
            ))
            .equals((linked_network.clone(), sigint_network::Column::Id)),
        )
        .join_as(
            JoinType::InnerJoin,
            area_of_responsibility::Entity,
            linked_network_value.clone(),
            Expr::col((
                linked_network_aor.clone(),
                sigint_network_aor::Column::AorId,
            ))
            .equals((
                linked_network_value.clone(),
                area_of_responsibility::Column::Id,
            )),
        )
        .join_as(
            JoinType::InnerJoin,
            groups_cte_alias.clone(),
            linked_g.clone(),
            network_stats_group_join_condition(
                linked_m.clone(),
                linked_g.clone(),
                Expr::col((
                    linked_network_value.clone(),
                    area_of_responsibility::Column::LeftBound,
                ))
                .into(),
                Expr::col((
                    linked_network_value.clone(),
                    area_of_responsibility::Column::RightBound,
                ))
                .into(),
            ),
        )
        .and_where(
            Expr::col((
                linked_network.clone(),
                sigint_network::Column::Deleted,
            ))
            .eq(false),
        );
    if let Some(condition) =
        selected_aor_overlap_condition(linked_network_value, &req.selected_aors)
    {
        linked_matches_q.cond_where(condition);
    }
    freq_matches_q.union(UnionType::All, linked_matches_q.to_owned());

    let message_network_alias = Alias::new("message_network");
    let mut main_q = Query::select();
    main_q
        .expr_as(
            Expr::col((
                message_network_alias.clone(),
                Alias::new("network_id"),
            )),
            Alias::new("network_id"),
        )
        .expr_as(
            Expr::cust("count(distinct message_network.dedup_key)"),
            Alias::new("msg_count"),
        )
        .from_subquery(freq_matches_q.to_owned(), message_network_alias.clone())
        .group_by_col((message_network_alias, Alias::new("network_id")));

    // Build WITH (using Select)
    let query = Query::with()
        .cte(messages_cte)
        .clone()
        .cte(networks_cte)
        .clone()
        .cte(groups_cte)
        .clone()
        .query(main_q)
        .to_owned();

    Ok(query)
}

pub async fn fetch_counts(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let login_value = user.id().c(h!())?;
    fetch_counts_for_login(
        req,
        login_value.as_str(),
        env.get_ref(),
        master_keys,
    )
    .await
}

pub async fn fetch_counts_for_login(
    req: &Json<AnalysisStatsReq>,
    login_str: &str,
    env: &Env,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let (replica_conn, replica_label) = env.replica_with_label();
    match fetch_counts_for_login_with_conn(
        req,
        login_str,
        master_keys.clone(),
        env,
        replica_conn,
    )
    .await
    {
        Ok(res) => Ok(res),
        Err(err)
            if replica_label.is_some() && is_replica_conflict_error(&err) =>
        {
            warn!(
                "Replica {:?} hit recovery conflict for login {login_str}, retrying on primary",
                replica_label
            );
            fetch_counts_for_login_with_conn(
                req,
                login_str,
                master_keys,
                env,
                env.dbx.clone(),
            )
            .await
        }
        Err(err) => Err(err),
    }
}

async fn fetch_counts_for_login_with_conn(
    req: &Json<AnalysisStatsReq>,
    login_str: &str,
    master_keys: Vec<String>,
    env: &Env,
    db_conn: DatabaseConnection,
) -> Result<(i64, i64), AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let read_stats_aggregated =
        can_read_stats_aggregated(&env.config, dt_since, dt_till)
            && is_5min_stats_bucket_range_aligned(dt_since, dt_till);

    let instant = std::time::Instant::now();
    let count_overall: i64 = fetch_count_overall(
        &db_conn,
        dt_since,
        dt_till,
        master_keys.clone(),
        read_stats_aggregated,
    )
    .await
    .context(h!())?;

    if instant.elapsed().as_secs() > 1 {
        debug!("count overall op took: {:?}", instant.elapsed());
    }
    if read_stats_aggregated
        && should_read_stats_aggregated_for_config(
            &req.0,
            &env.config,
            dt_since,
            dt_till,
        )
    {
        return Ok((count_overall, count_overall));
    }
    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct SelectedCountRes {
        count: i64,
    }
    let selected_count_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(master_keys.clone()))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    let selected_count_res = filter_selected_groups_and_senders_with_access(
        selected_count_res,
        &req.selected_groups,
        &req.selected_senders,
        &master_keys,
    )
    .context(h!())?;
    let selected_count_res =
        filter_selected_freqs(selected_count_res, &req.selected_freqs)
            .context(h!())?;
    let selected_count_res =
        filter_selected_posts(selected_count_res, &req.selected_posts)
            .context(h!())?;
    let selected_count_res = filter_selected_units(
        selected_count_res,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let selected_count_res = filter_selected_locations(
        selected_count_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let selected_count_res =
        filter_selected_callsigns(selected_count_res, &req.selected_callsigns)
            .context(h!())?;
    let selected_count_res = filter_selected_tags(
        selected_count_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login_str,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let selected_count_res = filter_selected_networks(
        selected_count_res,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let selected_count_res =
        apply_metadata_filters(selected_count_res, &req.0)?;
    let selected_count_res =
        filter_search(selected_count_res, &req.search).context(h!())?;
    let selected_count_res =
        filter_selected_aors(selected_count_res, &req.selected_aors)
            .context(h!())
            .context(h!())?;
    //println!(
    //    "> selected count res sql (login={}): {}",
    //    login_str,
    //    selected_count_res
    //    .clone()
    //    .build(DbBackend::Postgres)
    //    .to_string();
    //);
    let selected_count_res: SelectedCountRes = selected_count_res
        .into_model::<SelectedCountRes>()
        .one(&db_conn)
        .await
        .context(h!())?
        .unwrap_or(SelectedCountRes { count: 0 });
    let count_selected: i64 = selected_count_res.count;

    if instant.elapsed().as_secs() > 1 {
        debug!("count selected op took: {:?}", instant.elapsed());
    }
    Ok((count_overall, count_selected))
}

async fn fetch_count_overall(
    db: &DatabaseConnection,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
    read_stats_aggregated: bool,
) -> anyhow::Result<i64> {
    if read_stats_aggregated {
        return read_total_stats_aggregated(db, master_keys, dt_since, dt_till)
            .await
            .context(h!());
    }

    #[derive(FromQueryResult)]
    struct OverallCountRes {
        count: i64,
    }
    let overall_count_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(message_in_groups_exists(master_keys.clone()))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    // println!(
    //     "> overall count res sql: {}",
    //     overall_count_res.build(DbBackend::Postgres).to_string()
    // );
    let overall_count_res: OverallCountRes = overall_count_res
        .into_model::<OverallCountRes>()
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    Ok(overall_count_res.count)
}

fn is_replica_conflict_error(err: &AppError) -> bool {
    let mut source: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(err) = source {
        if let Some(sqlx::Error::Database(db_error)) =
            err.downcast_ref::<sqlx::Error>()
        {
            if matches!(db_error.code(), Some(code) if code == "40001") {
                return true;
            }
        }
        source = err.source();
    }
    false
}

fn build_join_for_sigint_inbox_item() -> Select<Entity> {
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
}

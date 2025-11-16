use crate::sigint::sender::preferred_sender_expr;
use crate::types::ShortContext;
use actix_identity::Identity;
use actix_web::web::Json;
use chrono::Duration;
use echo_migration::{Expr, JoinType};
use log::debug;
use sea_orm::FromQueryResult;
use sea_orm::*;
use std::error::Error as StdError;
use tokio::time::{sleep, Duration as TokioDuration};

use crate::entities::{
    sigint_inbox_item, signal_message, signal_message_group,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::analysis::*;
use crate::types::Env;

pub async fn fetch_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsGroup>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    #[derive(FromQueryResult)]
    struct GroupsRes {
        master_key: Option<String>,
        count: i64,
    }
    let instant = std::time::Instant::now();

    let groups_res =
        build_groups_query(&req, user, dt_since, dt_till, master_keys)?;

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

pub async fn count_groups(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).c(h!())?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).c(h!())?;
    let read_db = env.replica();
    let groups_res =
        build_groups_query(&req, user, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.c(h!())?;
    Ok(count as i64)
}

fn build_groups_query(
    req: &&Json<AnalysisStatsReq>,
    user: &Identity,
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
        .filter(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::GroupMasterKey,
            ))
            .is_in(accessible_groups.clone()),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .group_by(Expr::col((
            signal_message_group::Entity,
            signal_message_group::Column::GroupMasterKey,
        )));
    let groups_res = filter_selected_senders(groups_res, &req.selected_senders)
        .context(h!())?;
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
    let groups_res =
        filter_selected_networks(groups_res, &req.selected_networks)
            .context(h!())?;
    let groups_res = filter_search(groups_res, &req.search).context(h!())?;
    let groups_res = filter_selected_tags(
        groups_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        user.id().c(h!())?.as_str(),
    )
    .context(h!())?;
    let groups_res =
        filter_selected_aors(groups_res, &req.selected_aors).context(h!())?;
    Ok(groups_res)
}

pub async fn fetch_senders(
    req: &Json<AnalysisStatsReq>,
    user: &Identity,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsSender>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    #[derive(FromQueryResult)]
    struct SendersRes {
        uuid: Option<String>,
        count: i64,
    }
    let instant = std::time::Instant::now();
    let senders_res =
        build_senders_query(&req, &user, dt_since, dt_till, master_keys)?;
    // println!(
    //     "> senders_res: {}",
    //     senders_res.build(DbBackend::Postgres).to_string()
    // );
    // println!(
    //     "> senders_res: {}",
    //     senders_res.build(DbBackend::Postgres).to_string()
    // );
    let senders_res: Vec<SendersRes> = senders_res
        .into_model::<SendersRes>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut senders = vec![];
    for x in senders_res {
        let Some(uuid) = x.uuid else { continue };
        senders.push(AnalysisStatsSender {
            uuid,
            count: x.count,
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

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res =
        build_senders_query(&req, &user, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_senders_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let senders_res = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(preferred_sender_expr(None), "uuid")
        // .column_as(SimpleExpr::Custom("(SELECT signal_profile.given_name FROM signal_profile WHERE signal_profile.uuid = signal_message.sender)".to_string()), "uuid")
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(preferred_sender_expr(None));
    // .group_by(SimpleExpr::Custom("(SELECT signal_profile.given_name FROM signal_profile WHERE signal_profile.uuid = signal_message.sender)".to_string()));
    let senders_res = filter_selected_groups(senders_res, &req.selected_groups)
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
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id().context(h!())?,
    )
    .context(h!())?;
    let senders_res =
        filter_selected_networks(senders_res, &req.selected_networks)
            .context(h!())?;
    let senders_res = filter_search(senders_res, &req.search).context(h!())?;
    let senders_res =
        filter_selected_aors(senders_res, &req.selected_aors).context(h!())?;
    Ok(senders_res)
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
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let post_res =
        filter_selected_groups(post_res, &req.selected_groups).context(h!())?;
    let post_res = filter_selected_senders(post_res, &req.selected_senders)
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
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id().context(h!())?,
    )
    .context(h!())?;
    let post_res = filter_selected_networks(post_res, &req.selected_networks)
        .context(h!())?;
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
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let _instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct FreqsRes {
        freq: String,
        count: i64,
    }
    let freqs_res =
        build_freqs_query(&req, &user, dt_since, dt_till, master_keys)?;
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

async fn get_new_freqs(
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
    let groups_res =
        build_freqs_query(&req, &user, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_freqs_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
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
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let freqs_res = filter_selected_groups(freqs_res, &req.selected_groups)
        .context(h!())?;
    let freqs_res = filter_selected_senders(freqs_res, &req.selected_senders)
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
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id().context(h!())?,
    )
    .context(h!())?;
    let freqs_res = filter_selected_networks(freqs_res, &req.selected_networks)
        .context(h!())?;
    let freqs_res = filter_search(freqs_res, &req.search).context(h!())?;
    let freqs_res =
        filter_selected_aors(freqs_res, &req.selected_aors).context(h!())?;
    Ok(freqs_res)
}

pub async fn fetch_callsigns(
    req: &Json<AnalysisStatsReq>,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsCallsign>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct CallsignsRes {
        callsign: Option<String>,
        count: i64,
    }
    let callsigns_res =
        build_callsigns_query(&req, dt_since, dt_till, master_keys)?;
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
        build_callsigns_query(&req, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_callsigns_query(
    req: &&Json<AnalysisStatsReq>,
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
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(sea_query::expr::SimpleExpr::Custom("callsign".to_string()));
    let callsigns_res =
        filter_selected_groups(callsigns_res, &req.selected_groups)?;
    let callsigns_res =
        filter_selected_senders(callsigns_res, &req.selected_senders)?;
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
    let callsigns_res =
        filter_selected_networks(callsigns_res, &req.selected_networks)
            .context(h!())?;
    let callsigns_res = filter_search(callsigns_res, &req.search)?;
    let callsigns_res = filter_selected_aors(callsigns_res, &req.selected_aors)
        .context(h!())?;
    Ok(callsigns_res)
}

pub async fn fetch_tags(
    req: &Json<AnalysisStatsReq>,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<Vec<AnalysisStatsTag>, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct TagsRes {
        tag_ids: Option<Vec<i32>>,
        count: i64,
    }
    let tags_res = build_tags_query(&req, dt_since, dt_till, master_keys)?;
    // println!(
    //     "> tags_res: {}",
    //     tags_res.build(DbBackend::Postgres).to_string()
    // );
    let tags_res: Vec<TagsRes> = tags_res
        .into_model::<TagsRes>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut count_per_tag: BTreeMap<i64, i64> = BTreeMap::new();
    for x in tags_res {
        let Some(tag_ids) = x.tag_ids else { continue };
        for tag_id in tag_ids.iter() {
            count_per_tag
                .entry(*tag_id as i64)
                .and_modify(|c| *c += x.count)
                .or_insert(x.count);
        }
    }
    let mut tags = vec![];
    for (tag_id, count) in count_per_tag {
        tags.push(AnalysisStatsTag { tag_id, count });
    }

    if instant.elapsed().as_secs() > 4 {
        debug!("tags op took: {:?}; req: {:?}", instant.elapsed(), req);
    } else if instant.elapsed().as_secs() > 1 {
        debug!("tags op took: {:?}", instant.elapsed());
    }

    Ok(tags)
}

pub async fn count_tags(
    req: &Json<AnalysisStatsReq>,
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
) -> Result<i64, AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let read_db = env.replica();

    let instant = std::time::Instant::now();
    trace!("get identity master keys op took: {:?}", instant.elapsed());
    let groups_res = build_tags_query(&req, dt_since, dt_till, master_keys)?;
    let count = groups_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_tags_query(
    req: &&Json<AnalysisStatsReq>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let tags_res = sigint_inbox_item::Entity::find()
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
            Expr::cust("array(select jsonb_array_elements_text(tags))::int[]"),
            "tag_ids",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys.clone()))
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(sea_query::expr::SimpleExpr::Custom("tag_ids".to_string()));
    let tags_res = filter_selected_groups(tags_res, &req.selected_groups)?;
    let tags_res = filter_selected_senders(tags_res, &req.selected_senders)?;
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
    let tags_res = filter_selected_networks(tags_res, &req.selected_networks)
        .context(h!())?;
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
        let unit = crate::config::m_unit_to_unidenfitied(x.unit);
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
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let units_res = filter_selected_groups(units_res, &req.selected_groups)
        .context(h!())?;
    let units_res = filter_selected_senders(units_res, &req.selected_senders)
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
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id().context(h!())?,
    )
    .context(h!())?;
    let units_res = filter_selected_networks(units_res, &req.selected_networks)
        .context(h!())?;
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
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct LocationsRes {
        location: Option<String>,
        count: i64,
    }
    let locations_res =
        build_locations_query(&req, &user, dt_since, dt_till, master_keys)?;
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
        let location = crate::config::m_location_to_unidenfitied(location);
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
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));
    let locations_res =
        filter_selected_groups(locations_res, &req.selected_groups)
            .context(h!())?;
    let locations_res =
        filter_selected_senders(locations_res, &req.selected_senders)
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
    let locations_res =
        filter_selected_callsigns(locations_res, &req.selected_callsigns)
            .context(h!())?;
    let locations_res = filter_selected_tags(
        locations_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id().context(h!())?,
    )
    .context(h!())?;
    let locations_res =
        filter_selected_networks(locations_res, &req.selected_networks)
            .context(h!())?;
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
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let instant = std::time::Instant::now();

    #[derive(FromQueryResult)]
    struct AorsRes {
        aor_id: i64,
        count: i64,
    }
    let aors_res =
        build_aors_query(&req, &user, dt_since, dt_till, master_keys)?;
    // println!(
    //     "> aors_res: {}",
    //     aors_res.build(DbBackend::Postgres).to_string()
    // );
    let aors_res: Vec<AorsRes> = aors_res
        .into_model::<AorsRes>()
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

    let aors_res =
        build_aors_query(&req, &user, dt_since, dt_till, master_keys)?;
    let count = aors_res.count(&read_db).await.context(h!())?;
    Ok(count as i64)
}

fn build_aors_query(
    req: &&Json<AnalysisStatsReq>,
    user: &&Identity,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    master_keys: Vec<String>,
) -> Result<Select<sigint_inbox_item::Entity>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let aors_res = sigint_inbox_item::Entity::find()
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
        .join(
            JoinType::LeftJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group_aor::Relation::AreaOfResponsibility.def(),
        )
        .select_only()
        .column_as(
            Expr::col((
                area_of_responsibility::Entity,
                area_of_responsibility::Column::Id,
            )),
            "aor_id",
        )
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(message_in_groups_exists(master_keys))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .group_by(Expr::cust("1"));
    let aors_res =
        filter_selected_groups(aors_res, &req.selected_groups).context(h!())?;
    let aors_res = filter_selected_senders(aors_res, &req.selected_senders)
        .context(h!())?;
    let aors_res =
        filter_selected_freqs(aors_res, &req.selected_freqs).context(h!())?;
    let aors_res =
        filter_selected_posts(aors_res, &req.selected_posts).context(h!())?;
    let aors_res = filter_selected_locations(
        aors_res,
        &req.selected_locations,
        include_peleng_locations,
    )
    .context(h!())?;
    let aors_res = filter_selected_callsigns(aors_res, &req.selected_callsigns)
        .context(h!())?;
    let aors_res = filter_selected_tags(
        aors_res,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id().context(h!())?,
    )
    .context(h!())?;
    let aors_res = filter_search(aors_res, &req.search).context(h!())?;
    let aors_res =
        filter_selected_aors(aors_res, &req.selected_aors).context(h!())?;
    Ok(aors_res)
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
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;

    let instant = std::time::Instant::now();

    let networks_query =
        build_networks_query(&req, user, dt_since, dt_till, master_keys)?;

    let stmt = Statement::from_string(
        DbBackend::Postgres,
        networks_query.to_string(PostgresQueryBuilder),
    );

    let networks_res: Vec<NetworksRes> = NetworksRes::find_by_statement(stmt)
        .all(&env.dbx)
        .await
        .c(h!())?;

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
        build_networks_query(&req, user, dt_since, dt_till, master_keys)?;

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
    req: &&Json<AnalysisStatsReq>,
    user: &Identity,
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
        .filter(message_in_groups_exists(master_keys))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));

    // 2) networks_cte
    let networks_q = sigint_network_freq::Entity::find()
        .select_only()
        .column_as(sigint_network::Column::Id, "network_id")
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveFrom)
        .column(sigint_network_freq::Column::ActiveTo)
        .column_as(area_of_responsibility::Column::LeftBound, "n_left")
        .column_as(area_of_responsibility::Column::RightBound, "n_right")
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false));

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
        .filter(signal_group::Column::Deleted.eq(false));

    // add more custom filters to the messages CTE
    let messages_q = filter_selected_senders(messages_q, &req.selected_senders)
        .context(h!())?;
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
        filter_selected_networks(messages_q, &req.selected_networks)
            .context(h!())?;
    let messages_q = filter_search(messages_q, &req.search).context(h!())?;
    let messages_q = filter_selected_tags(
        messages_q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        user.id().c(h!())?.as_str(),
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

    let mut main_q = Query::select();
    main_q
        .expr_as(Expr::col((n.clone(), Alias::new("network_id"))), Alias::new("network_id"))
        .expr_as(Expr::cust("count(1)"), Alias::new("msg_count"))
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
            Condition::all()
                .add(Expr::col((m.clone(), Alias::new("group_master_key"))).equals((g.clone(), Alias::new("master_key"))))
                .add(
                    Condition::any()
                        .add(
                            Condition::all()
                                .add(Expr::col((g.clone(), Alias::new("g_left"))).gte(Expr::col((n.clone(), Alias::new("n_left")))))
                                .add(Expr::col((g.clone(), Alias::new("g_left"))).lte(Expr::col((n.clone(), Alias::new("n_right")))))
                        )
                        .add(
                            Condition::all()
                                .add(Expr::col((g.clone(), Alias::new("g_right"))).gte(Expr::col((n.clone(), Alias::new("n_left")))))
                                .add(Expr::col((g.clone(), Alias::new("g_right"))).lte(Expr::col((n.clone(), Alias::new("n_right")))))
                        )
                        .add(
                            Condition::all()
                                .add(Expr::col((g.clone(), Alias::new("g_left"))).lte(Expr::col((n.clone(), Alias::new("n_left")))))
                                .add(Expr::col((g.clone(), Alias::new("g_right"))).gte(Expr::col((n.clone(), Alias::new("n_right")))))
                        )
                ),
        )
        .group_by_col((n.clone(), Alias::new("network_id")));

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
    const MAX_RETRIES: usize = 3;
    const BASE_DELAY_MS: u64 = 200;

    let mut attempt = 0;
    loop {
        match fetch_counts_for_login_once(
            req,
            login_str,
            env,
            master_keys.clone(),
        )
        .await
        {
            Ok(res) => return Ok(res),
            Err(err) => {
                let should_retry = attempt + 1 < MAX_RETRIES
                    && is_replica_conflict_error(&err);
                if !should_retry {
                    return Err(err);
                }
                attempt += 1;
                warn!(
                    "fetch_counts_for_login retry {attempt}/{MAX_RETRIES} \
                     for login {login_str} after replica conflict"
                );
                let delay = BASE_DELAY_MS * attempt as u64;
                sleep(TokioDuration::from_millis(delay)).await;
            }
        }
    }
}

async fn fetch_counts_for_login_once(
    req: &Json<AnalysisStatsReq>,
    login_str: &str,
    env: &Env,
    master_keys: Vec<String>,
) -> Result<(i64, i64), AppError> {
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).context(h!())?;
    let dt_till =
        dt_from_millis(req.till_date_noninclusive_ms).context(h!())?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let read_db = env.replica();

    let instant = std::time::Instant::now();

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
        .one(&read_db)
        .await
        .context(h!())?
        .context(h!())?;
    let count_overall: i64 = overall_count_res.count;

    if instant.elapsed().as_secs() > 1 {
        debug!("count overall op took: {:?}", instant.elapsed());
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
    let selected_count_res =
        filter_selected_groups(selected_count_res, &req.selected_groups)
            .context(h!())?;
    let selected_count_res =
        filter_selected_senders(selected_count_res, &req.selected_senders)
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
        &req.or_with_extended_form,
        &req.filter_tags_option,
        login_str,
    )
    .context(h!())?;
    let selected_count_res =
        filter_selected_networks(selected_count_res, &req.selected_networks)
            .context(h!())?;
    let selected_count_res =
        filter_search(selected_count_res, &req.search).context(h!())?;
    let selected_count_res =
        filter_selected_aors(selected_count_res, &req.selected_aors)
            .context(h!())
            .context(h!())?;
    // let selected_count_sql = selected_count_res
    //     .clone()
    //     .build(DbBackend::Postgres)
    //     .to_string();
    // println!(
    //     "> selected count res sql (login={login_str}): {selected_count_sql}"
    // );
    let selected_count_res: SelectedCountRes = selected_count_res
        .into_model::<SelectedCountRes>()
        .one(&read_db)
        .await
        .context(h!())?
        .unwrap_or(SelectedCountRes { count: 0 });
    let count_selected: i64 = selected_count_res.count;

    if instant.elapsed().as_secs() > 1 {
        debug!("count selected op took: {:?}", instant.elapsed());
    }
    Ok((count_overall, count_selected))
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

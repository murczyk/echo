use super::*;
use crate::config::{
    DAILY_MESSAGE_STATS_FACET_CACHE_MAX_BYTES,
    DAILY_MESSAGE_STATS_FACET_CACHE_MAX_ENTRIES,
    DAILY_MESSAGE_STATS_FACET_CACHE_TTL_MS,
};
use once_cell::sync::Lazy;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

#[derive(Serialize)]
enum Cached {
    Counts(DailyMessageStatsFacetRsp),
    Senders(DailyMessageStatsSendersRsp),
}

static CACHE: Lazy<cache::Cache<Cached>> = Lazy::new(|| {
    cache::Cache::new(
        Duration::from_millis(DAILY_MESSAGE_STATS_FACET_CACHE_TTL_MS),
        DAILY_MESSAGE_STATS_FACET_CACHE_MAX_ENTRIES,
        DAILY_MESSAGE_STATS_FACET_CACHE_MAX_BYTES,
    )
});

pub(super) fn digest(value: &impl Serialize) -> anyhow::Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).c(h!())?)
    ))
}

pub(super) async fn access(
    user: &Identity,
    env: &Env,
) -> anyhow::Result<(uuid::Uuid, filters::Access, String)> {
    ensure_base_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    let organism_id = crate::users::load_active_login(&env.dbx, &login)
        .await
        .c(h!())?
        .organism_id;
    let mut groups = if organism_id.is_some() {
        get_identity_sigint_groups(&env.dbx, &login).await.c(h!())?
    } else {
        vec![]
    };
    groups.sort();
    groups.dedup();
    let labels_revision =
        crate::organism::labels::revision(&env.dbx).await.c(h!())?;
    let revision =
        digest(&(groups.clone(), organism_id, labels_revision)).c(h!())?;
    Ok((
        login,
        filters::Access::for_organism(groups, organism_id),
        revision,
    ))
}

pub(super) fn normalized(
    mut filter: DailyMessageStatsReq,
    allowed: &[String],
) -> DailyMessageStatsReq {
    filter.grouping = DailyMessageStatsGrouping::DailyStatsGroups;
    filter.cursor = None;
    if filter.selected_groups.is_some() {
        filter.selected_groups = Some(filters::groups(&filter, allowed));
    }
    if let Some(values) = &mut filter.selected_unit_ids {
        values.sort();
        values.dedup();
    }
    if let Some(values) = &mut filter.selected_senders {
        values.sort_by(|left, right| left.sender.cmp(&right.sender));
        values.dedup_by(|left, right| left.sender == right.sender);
    }
    filter
}

#[post("/api/rer/analysis/stats/daily-messages/catalog")]
pub async fn daily_catalog(
    user: Identity,
    env: Data<Env>,
    req: Json<DailyMessageStatsCatalogReq>,
) -> Result<Json<DailyMessageStatsCatalogRsp>, AppError> {
    let (_, groups, revision) = access(&user, &env).await.c(h!())?;
    Ok(Json(
        catalog::load(&env, &req, groups, revision).await.c(h!())?,
    ))
}

#[post("/api/rer/analysis/stats/daily-messages/facet-counts")]
pub async fn daily_facet_counts(
    user: Identity,
    env: Data<Env>,
    req: Json<DailyMessageStatsFacetReq>,
) -> Result<Json<DailyMessageStatsFacetRsp>, AppError> {
    let (login, groups, revision) = access(&user, &env).await.c(h!())?;
    let mut filter = req.filter.clone();
    date_range(&filter).c(h!())?;
    let hierarchy = match req.facet {
        DailyMessageStatsFacet::DailyGroupsFacet => {
            filter.selected_groups = None;
            None
        }
        DailyMessageStatsFacet::DailyUnitsFacet => {
            filter.selected_unit_ids = None;
            Some(crate::sigint::unit::hierarchy::load(&env).await.c(h!())?)
        }
    };
    let filter = normalized(filter, &groups.groups);
    let key = digest(&json!([
        crate::read_query::pool_identity(&env.dbx),
        login,
        revision,
        req.facet,
        filter,
        hierarchy
            .as_ref()
            .map(|tree| (&tree.revision, req.include_children))
    ]))
    .c(h!())?;
    let started = Instant::now();
    let (value, disposition) = CACHE
        .get(key, || async {
            let counts = if let Some(tree) = &hierarchy {
                filter_counts::load(
                    &env.dbx,
                    &filter,
                    groups,
                    tree,
                    req.include_children,
                )
                .await
                .c(h!())?
                .into_iter()
                .map(|entry| DailyMessageStatsFacetCount {
                    value: entry.value,
                    count: entry.count,
                })
                .collect()
            } else {
                facets::groups(&env.dbx, &filter, groups).await.c(h!())?
            };
            Ok(Cached::Counts(DailyMessageStatsFacetRsp {
                counts,
                access_revision: revision,
                hierarchy_revision: hierarchy.map(|tree| tree.revision),
                generated_at_ms: Utc::now().timestamp_millis(),
            }))
        })
        .await
        .c(h!())?;
    log::info!(target:"analytics_route", "request_id={} stage=daily_stats_facet facet={:?} cache={} elapsed_ms={}", crate::read_query::request_id(),req.facet,disposition,started.elapsed().as_millis());
    let Cached::Counts(response) = value.as_ref() else {
        return Err(
            anyhow::anyhow!("unexpected daily stats cache entry").into()
        );
    };
    Ok(Json(response.clone()))
}

#[post("/api/rer/analysis/stats/daily-messages/senders")]
pub async fn daily_senders(
    user: Identity,
    env: Data<Env>,
    req: Json<DailyMessageStatsSendersReq>,
) -> Result<Json<DailyMessageStatsSendersRsp>, AppError> {
    let (login, groups, revision) = access(&user, &env).await.c(h!())?;
    date_range(&req.filter).c(h!())?;
    decode_cursor(&req.cursor).c(h!())?;
    let mut req = req.into_inner();
    req.filter.selected_senders = None;
    req.filter = normalized(req.filter, &groups.groups);
    let key = digest(&json!([
        crate::read_query::pool_identity(&env.dbx),
        login,
        revision,
        "senders",
        req
    ]))
    .c(h!())?;
    let started = Instant::now();
    let (value, disposition) = CACHE
        .get(key, || async {
            Ok(Cached::Senders(
                facets::senders(&env.dbx, &req, groups, revision)
                    .await
                    .c(h!())?,
            ))
        })
        .await
        .c(h!())?;
    log::info!(target:"analytics_route", "request_id={} stage=daily_stats_facet facet=senders cache={} elapsed_ms={}",crate::read_query::request_id(),disposition,started.elapsed().as_millis());
    let Cached::Senders(response) = value.as_ref() else {
        return Err(
            anyhow::anyhow!("unexpected daily stats cache entry").into()
        );
    };
    Ok(Json(response.clone()))
}

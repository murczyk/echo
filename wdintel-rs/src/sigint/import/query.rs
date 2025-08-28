use crate::entities::*;
use crate::h;
use anyhow::Context;
use sea_orm::*;
use std::collections::BTreeMap;

pub async fn find_existing_modulations<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<modulation::Model>,
) -> anyhow::Result<BTreeMap<String, i32>>
where
    C: ConnectionTrait + 'async_trait,
{
    let names = recs.iter().map(|rec| rec.name.clone()).collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = modulation::Entity::find()
        .filter(modulation::Column::Name.is_in(names))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|rec| (rec.name, rec.id))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sources<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<source::Model>,
) -> anyhow::Result<BTreeMap<String, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let names = recs.iter().map(|rec| rec.name.clone()).collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = source::Entity::find()
        .filter(source::Column::Name.is_in(names))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|rec| (rec.name, rec.id))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_signals<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_signal::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_signal::Entity::find()
        .filter(sigint_signal::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_units<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_unit::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_networks<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network::Entity::find()
        .filter(sigint_network::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_posts<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_post::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_post::Entity::find()
        .filter(sigint_post::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_descriptions<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_description::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_description::Entity::find()
        .filter(sigint_network_description::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_freqs<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_freq::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_callsigns<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_callsign::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_callsign::Entity::find()
        .filter(sigint_network_callsign::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_callsigns<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_callsign::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_units<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_unit::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_unit_changelogs<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_unit_changelog::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_unit_changelog::Entity::find()
        .filter(
            sigint_network_unit_changelog::Column::SigintOriginId.is_in(ids),
        )
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_callsign_changelogs<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_callsign_changelog::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_callsign_changelog::Entity::find()
        .filter(sigint_callsign_changelog::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_signal_changelogs<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_signal_changelog::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_signal_changelog::Entity::find()
        .filter(sigint_signal_changelog::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_posts<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_post::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_post::Entity::find()
        .filter(sigint_network_post::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_freq_changelogs<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_freq_changelog::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_freq_changelog::Entity::find()
        .filter(
            sigint_network_freq_changelog::Column::SigintOriginId.is_in(ids),
        )
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

pub async fn find_existing_sigint_network_changelogs<'a, 'async_trait, C>(
    txn: &C,
    recs: &Vec<sigint_network_changelog::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = recs
        .iter()
        .flat_map(|rec| rec.sigint_origin_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    };

    let ids_map = sigint_network_changelog::Entity::find()
        .filter(sigint_network_changelog::Column::SigintOriginId.is_in(ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|rec| rec.sigint_origin_id.map(|id| (id, rec.id)))
        .collect();
    Ok(ids_map)
}

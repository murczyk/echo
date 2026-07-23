use crate::entities::{
    sigint_network_callsign, sigint_network_unit, sigint_unit,
};
use crate::error::AppError;
use crate::h;
use crate::sigint::callsign::types::UpdateNetworkCallsignReq;
use crate::types::Mode;
use crate::types::*;
use anyhow::Context;
use sea_orm::*;
use std::collections::HashMap;

pub async fn oneoff_fix_network_callsigns(mode: Mode) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let callsigns_to_backfill = sigint_network_callsign::Entity::find()
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(sigint_network_callsign::Column::Developing.eq(false))
        .filter(sigint_network_callsign::Column::UnitDeveloping.eq(false))
        .filter(sigint_network_callsign::Column::SigintCallsignId.is_null())
        .all(&dbx)
        .await
        .c(h!())?;
    let network_unit_ids =
        load_network_unit_ids(&dbx, &callsigns_to_backfill).await?;
    let mut counter = 0;
    let mut skipped = 0;
    for network_callsign in callsigns_to_backfill {
        let Some(unit_id) = resolve_unit_id(
            network_callsign.unit_id,
            network_callsign.sigint_network_id,
            &network_unit_ids,
        ) else {
            let network_unit_count = network_unit_ids
                .get(&network_callsign.sigint_network_id)
                .map_or(0, Vec::len);
            warn!(
                "cannot fix callsign #{} ({}): no unit ID specified and network #{} has {} units",
                network_callsign.id,
                network_callsign.sigint_callsign,
                network_callsign.sigint_network_id,
                network_unit_count,
            );
            skipped += 1;
            continue;
        };
        let callsign_id = network_callsign.id;
        let callsign = network_callsign.sigint_callsign.clone();
        if let Err(e) = fix_callsign(&dbx, network_callsign, unit_id).await {
            error!(
                "failed to fix callsign #{callsign_id} ({callsign}): {:#?}",
                e
            );
        } else {
            counter += 1;
        }
    }
    info!("fixed {counter} callsigns, skipped {skipped}, quitting");
    Ok(())
}

async fn load_network_unit_ids(
    dbx: &DatabaseConnection,
    callsigns: &[sigint_network_callsign::Model],
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let network_ids = callsigns
        .iter()
        .map(|callsign| callsign.sigint_network_id)
        .collect::<Vec<_>>();
    let network_units = sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .columns([
            sigint_network_unit::Column::NetworkId,
            sigint_network_unit::Column::UnitId,
        ])
        .filter(sigint_network_unit::Column::NetworkId.is_in(network_ids))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .distinct()
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut network_unit_ids = HashMap::new();
    for (network_id, unit_id) in network_units {
        network_unit_ids
            .entry(network_id)
            .or_insert_with(Vec::new)
            .push(unit_id);
    }
    Ok(network_unit_ids)
}

fn resolve_unit_id(
    callsign_unit_id: Option<i64>,
    network_id: i64,
    network_unit_ids: &HashMap<i64, Vec<i64>>,
) -> Option<i64> {
    callsign_unit_id.or_else(|| {
        let unit_ids = network_unit_ids.get(&network_id)?;
        match unit_ids.as_slice() {
            [unit_id] => Some(*unit_id),
            _ => None,
        }
    })
}

async fn fix_callsign(
    dbx: &DatabaseConnection,
    network_callsign: sigint_network_callsign::Model,
    unit_id: i64,
) -> Result<(), AppError> {
    let txn = dbx.begin().await.c(h!())?;
    let req = UpdateNetworkCallsignReq {
        id: network_callsign.id,
        network_id: network_callsign.sigint_network_id,
        callsign: network_callsign.sigint_callsign.clone(),
        position: network_callsign.position.clone(),
        comment: network_callsign.comment.clone(),
        source_id: network_callsign.source_id,
        radio_freq: network_callsign.radio_freq.clone(),
        unit_id: Some(unit_id),
        unit_developing: network_callsign.unit_developing,
        developing: false,
        main_radio_station: network_callsign.main_radio_station,
        command_control: network_callsign.command_control,
    };
    crate::sigint::callsign::bl_network_callsign::ensure_callsign(
        &req,
        "system",
        &txn,
        &network_callsign,
        unit_id,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_unit_id_prefers_callsign_unit() {
        let network_unit_ids = HashMap::from([(10, vec![2])]);

        assert_eq!(resolve_unit_id(Some(1), 10, &network_unit_ids), Some(1));
    }

    #[test]
    fn resolve_unit_id_uses_only_network_unit() {
        let network_unit_ids = HashMap::from([(10, vec![1])]);

        assert_eq!(resolve_unit_id(None, 10, &network_unit_ids), Some(1));
    }

    #[test]
    fn resolve_unit_id_rejects_ambiguous_network_units() {
        let network_unit_ids = HashMap::from([(10, vec![1, 2]), (11, vec![])]);

        assert_eq!(resolve_unit_id(None, 10, &network_unit_ids), None);
        assert_eq!(resolve_unit_id(None, 11, &network_unit_ids), None);
        assert_eq!(resolve_unit_id(None, 12, &network_unit_ids), None);
    }
}

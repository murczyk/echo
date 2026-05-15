use crate::entities::sigint_network_callsign;
use crate::error::AppError;
use crate::h;
use crate::sigint::callsign::types::UpdateNetworkCallsignReq;
use crate::types::Mode;
use crate::types::*;
use anyhow::Context;
use sea_orm::*;

pub async fn oneoff_fix_network_callsigns(mode: Mode) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let callsigns_to_backfill = sigint_network_callsign::Entity::find()
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(sigint_network_callsign::Column::Developing.eq(false))
        .filter(sigint_network_callsign::Column::SigintCallsignId.is_null())
        .all(&dbx)
        .await
        .c(h!())?;
    let mut counter = 0;
    for c in callsigns_to_backfill {
        let Some(unit_id) = &c.unit_id.clone() else {
            error!("cannot fix callsign {}, no unit ID specified!", c.id);
            continue;
        };
        let c_id = c.id;
        let callsign = c.sigint_callsign.clone();
        if let Err(e) = fix_callsign(&dbx, c, unit_id).await {
            error!("failed to fix callsign #{c_id} ({callsign}): {:#?}", e);
        } else {
            counter += 1;
        }
    }
    info!("fixed {counter} callsigns, quitting");
    Ok(())
}

async fn fix_callsign(
    dbx: &DatabaseConnection,
    c: sigint_network_callsign::Model,
    unit_id: &i64,
) -> Result<(), AppError> {
    let cc = c.clone();
    let txn = dbx.begin().await.c(h!())?;
    let req = UpdateNetworkCallsignReq {
        id: c.id,
        network_id: c.sigint_network_id,
        callsign: c.sigint_callsign,
        position: c.position,
        comment: c.comment,
        source_id: c.source_id,
        radio_freq: c.radio_freq,
        unit_id: c.unit_id,
        unit_developing: c.unit_developing,
        developing: false,
        main_radio_station: c.main_radio_station,
    };
    crate::sigint::callsign::bl_network_callsign::ensure_callsign(
        &req, "system", &txn, &cc, *unit_id,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

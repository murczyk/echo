use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::*;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use futures::stream;
use futures_util::StreamExt;
use sea_orm::*;

#[post("/api/rer/callsign-info")]
async fn rer_callsign_info(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerCallsignInfoReq>,
) -> Result<Json<Vec<CallsignInfo>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;

    Ok(Json(
        rer_callsign_info_single(&env.dbx, &req.callsign.clone()).await?,
    ))
}

async fn rer_callsign_info_single(
    dbx: &sea_orm::DatabaseConnection,
    callsign: &String,
) -> Result<Vec<CallsignInfo>, AppError> {
    let callsigns_data = sigint_callsign::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .filter(sigint_callsign::Column::Callsign.eq(callsign.to_lowercase()))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .context(h!())?;
    let callsign_ids = callsigns_data
        .iter()
        .map(|(x, _)| x.id.clone())
        .collect::<Vec<_>>();
    let reported_networks_per_callsign =
        collect_reported_networks_per_callsign(callsign_ids, dbx)
            .await
            .context(h!())?;
    let res: Vec<CallsignInfo> = callsigns_data
        .into_iter()
        .filter_map(|(callsign, is_unit)| {
            is_unit.map(|unit| CallsignInfo {
                id: callsign.id,
                callsign: callsign.callsign,
                position: callsign.position,
                comment: callsign.comment.to_string()
                    + callsign
                        .developing
                        .then(|| " (в дорозвідці)")
                        .unwrap_or(""),
                unit_1: unit.name,
                unit_2: "".to_string(),
                unit_id: Some(unit.id),
                network_ids_reported_id: reported_networks_per_callsign
                    .get(&callsign.id)
                    .cloned()
                    .unwrap_or(vec![]),
            })
        })
        .collect::<Vec<CallsignInfo>>();
    Ok(res)
}

async fn collect_reported_networks_per_callsign(
    callsign_ids: Vec<i64>,
    dbx: &sea_orm::DatabaseConnection,
) -> Result<BTreeMap<i64, Vec<i64>>, AppError> {
    let reported_in = crate::entities::sigint_network_callsign::Entity::find()
        .filter(
            crate::entities::sigint_network_callsign::Column::SigintCallsignId
                .is_in(callsign_ids),
        )
        .filter(
            crate::entities::sigint_network_callsign::Column::Deleted.eq(false),
        )
        .filter(
            crate::entities::sigint_network_callsign::Column::IsReported
                .eq(true),
        )
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.sigint_network_id, x.sigint_callsign_id))
        .collect::<Vec<_>>();
    let mut reported_networks_per_callsign: BTreeMap<i64, Vec<i64>> =
        BTreeMap::new();
    for (sigint_network_id, sigint_callsign_id) in reported_in {
        let mut network_ids = reported_networks_per_callsign
            .remove(&sigint_callsign_id)
            .unwrap_or(vec![]);
        network_ids.push(sigint_network_id);
        reported_networks_per_callsign.insert(sigint_callsign_id, network_ids);
    }
    Ok(reported_networks_per_callsign)
}

#[post("/api/rer/callsign-info-batch-old")]
async fn rer_callsign_info_batch_old(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerCallsignInfoBatchReq>,
) -> Result<Json<Vec<CallsignInfoRes>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let dbx = &env.dbx.clone();
    let res = stream::iter(req.callsigns.clone().into_iter())
        .then(|callsign| async move {
            rer_callsign_info_single(dbx, &callsign)
                .await
                .map(|res| CallsignInfoRes { callsign, res })
        })
        .collect::<Vec<Result<CallsignInfoRes, _>>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(res))
}

#[post("/api/rer/callsign-info-batch")]
async fn rer_callsign_info_batch(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerCallsignInfoBatchReq>,
) -> Result<Json<Vec<CallsignInfoRes>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let res = load_callsigns(&env, req.callsigns.clone()).await?;
    Ok(Json(res))
}

pub async fn load_callsigns(
    env: &Data<Env>,
    callsigns_txt: Vec<String>,
) -> Result<Vec<CallsignInfoRes>, AppError> {
    let dbx = &env.dbx.clone();

    let mut res: Vec<CallsignInfoRes> = Vec::new();
    let mut lowercased = callsigns_txt
        .iter()
        .map(|c| c.to_lowercase())
        .unique()
        .collect::<Vec<String>>();

    let mut callsigns = vec![];

    while !lowercased.is_empty() {
        let (lowercased_to_query, new_lowercased) =
            cap_string_vector(lowercased);
        lowercased = new_lowercased;

        sigint_callsign::Entity::find()
            .find_also_related(sigint_unit::Entity)
            .filter(
                sigint_callsign::Column::Callsign
                    .is_in(lowercased_to_query.clone()),
            )
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Active.eq(true))
            .filter(sigint_callsign::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|c| callsigns.push(c));
    }

    let callsign_ids = callsigns
        .iter()
        .map(|(x, _)| x.id.clone())
        .collect::<Vec<_>>();

    let reported_networks_per_callsign =
        collect_reported_networks_per_callsign(callsign_ids, dbx)
            .await
            .context(h!())?;

    for c in callsigns_txt.iter() {
        let mut res_single = CallsignInfoRes {
            callsign: c.clone(),
            res: Vec::new(),
        };
        for (callsign, is_unit) in callsigns.iter() {
            if callsign.callsign == c.to_lowercase() {
                if let Some(unit) = is_unit {
                    res_single.res.push(CallsignInfo {
                        id: callsign.id,
                        callsign: callsign.callsign.clone(),
                        position: callsign.position.clone(),
                        comment: callsign.comment.to_string()
                            + callsign
                                .developing
                                .then(|| " (в дорозвідці)")
                                .unwrap_or(""),
                        unit_1: unit.name.clone(),
                        unit_2: "".to_string(),
                        unit_id: Some(unit.id),
                        network_ids_reported_id: reported_networks_per_callsign
                            .get(&callsign.id)
                            .cloned()
                            .unwrap_or(vec![]),
                    });
                }
            }
        }
        res.push(res_single);
    }
    Ok(res)
}

// sql accepts max of ~65500 entries in where statement
fn cap_string_vector(source: Vec<String>) -> (Vec<String>, Vec<String>) {
    let len = source.len();
    if len <= 65000 {
        (source, Vec::new())
    } else {
        let first_part = source[0..65000].to_vec();
        let second_part = source[65000..].to_vec();
        (first_part, second_part)
    }
}

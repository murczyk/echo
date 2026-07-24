use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::*;
use crate::users::ensure_rer_role;
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::*;

#[post("/api/rer/callsign-info")]
async fn rer_callsign_info(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerCallsignInfoReq>,
) -> Result<Json<Vec<CallsignInfo>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;

    Ok(Json(
        rer_callsign_info_single(&env.dbx, &req.callsign.clone())
            .await
            .c(h!())?,
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
        .c(h!())?;
    let callsign_ids =
        callsigns_data.iter().map(|(x, _)| x.id).collect::<Vec<_>>();
    let reported_networks_per_callsign =
        collect_reported_networks_per_callsign(callsign_ids, dbx)
            .await
            .c(h!())?;
    let res: Vec<CallsignInfo> = callsigns_data
        .into_iter()
        .filter_map(|(callsign, is_unit)| {
            is_unit.map(|unit| CallsignInfo {
                id: callsign.id,
                callsign: callsign.callsign,
                position: callsign.position,
                comment: callsign.comment.to_string()
                    + if callsign.developing {
                        " (в дорозвідці)"
                    } else {
                        ""
                    },
                unit_1: unit.name,
                unit_2: "".to_string(),
                unit_id: Some(unit.id),
                network_ids_reported_in: reported_networks_per_callsign
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
    // First, get the callsign texts for the given IDs
    let callsign_records = crate::entities::sigint_callsign::Entity::find()
        .filter(
            crate::entities::sigint_callsign::Column::Id
                .eq_any(callsign_ids.clone()),
        )
        .all(dbx)
        .await
        .c(h!())?;

    let callsign_texts: Vec<String> = callsign_records
        .iter()
        .map(|c| c.callsign.clone())
        .collect();

    // Create a mapping from callsign text to callsign ID
    let text_to_id: std::collections::HashMap<String, i64> = callsign_records
        .into_iter()
        .map(|c| (c.callsign.clone(), c.id))
        .collect();

    // Find network callsign records that match the callsign texts
    let reported_in = crate::entities::sigint_network_callsign::Entity::find()
        .filter(
            crate::entities::sigint_network_callsign::Column::SigintCallsign
                .eq_any(callsign_texts),
        )
        .filter(
            crate::entities::sigint_network_callsign::Column::Deleted.eq(false),
        )
        .all(dbx)
        .await
        .c(h!())?;

    let mut reported_networks_per_callsign: BTreeMap<i64, Vec<i64>> =
        BTreeMap::new();

    for record in reported_in {
        if let Some(&callsign_id) = text_to_id.get(&record.sigint_callsign) {
            let mut network_ids = reported_networks_per_callsign
                .remove(&callsign_id)
                .unwrap_or_default();
            network_ids.push(record.sigint_network_id);
            reported_networks_per_callsign.insert(callsign_id, network_ids);
        }
    }
    Ok(reported_networks_per_callsign)
}

#[post("/api/rer/callsign-info-batch")]
async fn rer_callsign_info_batch(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RerCallsignInfoBatchReq>,
) -> Result<Json<Vec<CallsignInfoRes>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let network_callsigns = req
        .callsigns
        .iter()
        .map(|c| CallsignNetworks {
            network_ids: vec![],
            callsign: c.clone(),
        })
        .collect_vec();
    let res = load_callsigns(&env, network_callsigns).await.c(h!())?;
    Ok(Json(res))
}

pub async fn load_callsigns(
    env: &Data<Env>,
    callsigns_data: Vec<CallsignNetworks>,
) -> Result<Vec<CallsignInfoRes>, AppError> {
    let dbx = &env.dbx.clone();

    let mut res: Vec<CallsignInfoRes> = Vec::new();
    let requested_callsigns = requested_callsigns(&callsigns_data);
    let mut lowercased = requested_callsigns.clone();

    let mut callsigns = vec![];

    while !lowercased.is_empty() {
        let (lowercased_to_query, new_lowercased) =
            cap_string_vector(lowercased);
        lowercased = new_lowercased;

        sigint_callsign::Entity::find()
            .find_also_related(sigint_unit::Entity)
            .filter(
                sigint_callsign::Column::Callsign
                    .eq_any(lowercased_to_query.clone()),
            )
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Active.eq(true))
            .filter(sigint_callsign::Column::Deleted.eq(false))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|c| callsigns.push(c));
    }

    let callsign_ids = callsigns.iter().map(|(c, _)| c.id).collect::<Vec<_>>();
    let catalog_by_id = callsigns
        .iter()
        .map(|(callsign, unit)| (callsign.id, (callsign, unit)))
        .collect::<HashMap<_, _>>();
    let mut network_ids_reported_in: HashMap<i64, Vec<i64>> = HashMap::new();
    sigint_network_callsign::Entity::find()
        .filter(
            sigint_network_callsign::Column::SigintCallsignId
                .is_in(callsign_ids),
        )
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network_callsign::Column::SigintCallsignId)
        .column(sigint_network_callsign::Column::SigintNetworkId)
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .for_each(|(callsign_id, network_id)| {
            network_ids_reported_in
                .entry(callsign_id)
                .and_modify(|e| e.push(network_id))
                .or_insert(vec![network_id]);
        });

    let mut network_callsigns = Vec::new();
    let mut network_callsigns_to_query = requested_callsigns.clone();
    while !network_callsigns_to_query.is_empty() {
        let (callsigns_to_query, remaining_callsigns) =
            cap_string_vector(network_callsigns_to_query);
        network_callsigns_to_query = remaining_callsigns;
        network_callsigns.extend(
            sigint_network_callsign::Entity::find()
                .find_also_related(sigint_network::Entity)
                .filter(sigint_network_callsign::Column::Deleted.eq(false))
                .filter(sigint_network::Column::Deleted.eq(false))
                .filter(
                    Expr::cust(
                        "lower(sigint_network_callsign.sigint_callsign)",
                    )
                    .is_in(callsigns_to_query),
                )
                .all(dbx)
                .await
                .c(h!())?,
        );
    }
    let network_unit_ids = network_callsigns
        .iter()
        .filter_map(|(network_callsign, _)| network_callsign.unit_id)
        .unique()
        .collect_vec();
    let mut network_unit_names = HashMap::new();
    let mut network_unit_ids_to_query = network_unit_ids;
    while !network_unit_ids_to_query.is_empty() {
        let (unit_ids_to_query, remaining_unit_ids) =
            cap_vector(network_unit_ids_to_query);
        network_unit_ids_to_query = remaining_unit_ids;
        let units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(unit_ids_to_query))
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Active.eq(true))
            .all(dbx)
            .await
            .c(h!())?;
        network_unit_names
            .extend(units.into_iter().map(|unit| (unit.id, unit.name)));
    }

    for rec in callsigns_data {
        let c = rec.callsign;
        let mut res_single = CallsignInfoRes {
            callsign: c.clone(),
            res: Vec::new(),
            network_hints: Some(Vec::new()),
        };
        for (callsign, is_unit) in callsigns.iter() {
            if callsign.callsign == c.to_lowercase() {
                if let Some(unit) = is_unit {
                    res_single.res.push(CallsignInfo {
                        id: callsign.id,
                        callsign: callsign.callsign.clone(),
                        position: callsign.position.clone(),
                        comment: callsign.comment.to_string()
                            + if callsign.developing {
                                " (в дорозвідці)"
                            } else {
                                ""
                            },
                        unit_1: unit.name.clone(),
                        unit_2: "".to_string(),
                        unit_id: Some(unit.id),
                        network_ids_reported_in: network_ids_reported_in
                            .get(&callsign.id)
                            .cloned()
                            .unwrap_or_default(),
                    });
                }
            }
        }
        for (network_callsign, _) in &network_callsigns {
            if callsign_text_matches(&network_callsign.sigint_callsign, &c) {
                let catalog = network_callsign
                    .sigint_callsign_id
                    .and_then(|id| catalog_by_id.get(&id));
                let network_formation = network_callsign
                    .unit_id
                    .and_then(|unit_id| network_unit_names.get(&unit_id))
                    .map(String::as_str);
                let catalog_formation = catalog.and_then(|(_, unit)| {
                    unit.as_ref().map(|unit| unit.name.as_str())
                });
                let formation = resolve_network_hint_formation(
                    network_formation,
                    catalog_formation,
                );
                res_single
                    .network_hints
                    .as_mut()
                    .expect("initialized")
                    .push(CallsignNetworkHint {
                        network_id: network_callsign.sigint_network_id,
                        callsign: network_callsign.sigint_callsign.clone(),
                        position: network_callsign
                            .position
                            .clone()
                            .filter(|position| !position.trim().is_empty())
                            .or_else(|| {
                                catalog.map(|(callsign, _)| {
                                    callsign.position.clone()
                                })
                            })
                            .unwrap_or_default(),
                        formation,
                    });
            }
        }
        res.push(res_single);
    }
    Ok(res)
}

fn resolve_network_hint_formation(
    network_unit_name: Option<&str>,
    catalog_unit_name: Option<&str>,
) -> String {
    network_unit_name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| catalog_unit_name.filter(|name| !name.trim().is_empty()))
        .unwrap_or_default()
        .to_string()
}

fn requested_callsigns(callsigns_data: &[CallsignNetworks]) -> Vec<String> {
    callsigns_data
        .iter()
        .map(|item| item.callsign.to_lowercase())
        .unique()
        .collect_vec()
}

fn callsign_text_matches(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

// sql accepts max of ~65500 entries in where statement
fn cap_string_vector(source: Vec<String>) -> (Vec<String>, Vec<String>) {
    cap_vector(source)
}

fn cap_vector<T: Clone>(source: Vec<T>) -> (Vec<T>, Vec<T>) {
    let len = source.len();
    if len <= 65000 {
        (source, Vec::new())
    } else {
        let first_part = source[0..65000].to_vec();
        let second_part = source[65000..].to_vec();
        (first_part, second_part)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        callsign_text_matches, cap_string_vector, requested_callsigns,
        resolve_network_hint_formation,
    };
    use crate::rer_importer::types::CallsignNetworks;

    #[test]
    fn uses_network_unit_when_catalog_result_is_empty() {
        assert_eq!(
            resolve_network_hint_formation(Some("4 мср"), None),
            "4 мср"
        );
    }

    #[test]
    fn network_unit_wins_over_catalog_unit() {
        assert_eq!(
            resolve_network_hint_formation(Some("4 мср"), Some("каталог")),
            "4 мср"
        );
    }

    #[test]
    fn falls_back_to_catalog_unit_when_network_unit_is_missing() {
        assert_eq!(
            resolve_network_hint_formation(None, Some("каталог")),
            "каталог"
        );
    }

    #[test]
    fn ignores_blank_unit_names() {
        assert_eq!(
            resolve_network_hint_formation(Some("  "), Some(" каталог ")),
            " каталог "
        );
        assert_eq!(resolve_network_hint_formation(Some("  "), Some(" ")), "");
    }

    #[test]
    fn deduplicates_requested_callsigns() {
        let callsigns = vec![
            CallsignNetworks {
                callsign: "ВЕТЕР".to_string(),
                network_ids: vec![],
            },
            CallsignNetworks {
                callsign: "ветер".to_string(),
                network_ids: vec![],
            },
        ];
        assert_eq!(requested_callsigns(&callsigns), vec!["ветер"]);
    }

    #[test]
    fn chunks_at_the_sql_parameter_boundary() {
        let source = (0..65_001).map(|id| id.to_string()).collect::<Vec<_>>();
        let (first, second) = cap_string_vector(source);
        assert_eq!(first.len(), 65_000);
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn matches_callsign_text_case_insensitively() {
        assert!(callsign_text_matches("ВЕТЕР", "ветер"));
        assert!(callsign_text_matches("MiXeD", "mixed"));
        assert!(!callsign_text_matches("ВЕТЕР", "БУРЯ"));
    }
}

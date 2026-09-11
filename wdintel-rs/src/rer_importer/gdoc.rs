use crate::config::RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::*;
use crate::users::ensure_rer_role;
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::sea_query::{Expr, ExprTrait, Func};
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
    env: &Env,
    callsigns_data: Vec<CallsignNetworks>,
) -> Result<Vec<CallsignInfoRes>, AppError> {
    let requests = prepare_callsign_requests(callsigns_data);
    if requests.is_empty() {
        return Ok(Vec::new());
    }

    let requested_callsigns = requested_callsigns(&requests);
    let catalog_rows =
        load_catalog_callsigns(&env.dbx, requested_callsigns.clone())
            .await
            .c(h!())?;
    let catalog_ids = catalog_rows
        .iter()
        .map(|(callsign, _)| callsign.id)
        .collect_vec();
    let reported_network_ids = load_reported_network_ids(&env.dbx, catalog_ids)
        .await
        .c(h!())?;
    let catalog = CatalogLookup::new(catalog_rows, reported_network_ids);
    let network_callsigns =
        load_network_callsigns_for_requests(&env.dbx, &requests, &catalog)
            .await
            .c(h!())?;
    let network_unit_names =
        load_network_unit_names(&env.dbx, &network_callsigns)
            .await
            .c(h!())?;
    let network_callsigns = NetworkCallsignLookup::new(network_callsigns);

    Ok(requests
        .into_iter()
        .map(|request| {
            build_callsign_response(
                request,
                &catalog,
                &network_callsigns,
                &network_unit_names,
            )
        })
        .collect())
}

struct CallsignRequest {
    callsign: String,
    normalized_callsign: String,
    network_ids: Vec<i64>,
}

fn prepare_callsign_requests(
    callsigns_data: Vec<CallsignNetworks>,
) -> Vec<CallsignRequest> {
    callsigns_data
        .into_iter()
        .map(|item| {
            let mut network_ids = item.network_ids;
            network_ids.sort_unstable();
            network_ids.dedup();
            CallsignRequest {
                normalized_callsign: item.callsign.to_lowercase(),
                callsign: item.callsign,
                network_ids,
            }
        })
        .collect()
}

fn requested_callsigns(requests: &[CallsignRequest]) -> Vec<String> {
    requests
        .iter()
        .map(|request| request.normalized_callsign.clone())
        .unique()
        .collect_vec()
}

#[derive(Debug, PartialEq)]
struct NetworkCallsignQueryGroup {
    callsigns: Vec<String>,
    network_scope: Option<Vec<i64>>,
}

fn network_callsign_query_groups(
    requests: &[CallsignRequest],
) -> Vec<NetworkCallsignQueryGroup> {
    let unscoped_callsigns = requests
        .iter()
        .filter(|request| request.network_ids.is_empty())
        .map(|request| request.normalized_callsign.clone())
        .unique()
        .collect_vec();
    let unscoped_callsign_set =
        unscoped_callsigns.iter().cloned().collect::<HashSet<_>>();
    let scoped_callsigns = requests
        .iter()
        .filter(|request| {
            !request.network_ids.is_empty()
                && !unscoped_callsign_set.contains(&request.normalized_callsign)
        })
        .map(|request| request.normalized_callsign.clone())
        .unique()
        .collect_vec();
    let scoped_callsign_set =
        scoped_callsigns.iter().cloned().collect::<HashSet<_>>();
    let network_scope = requests
        .iter()
        .filter(|request| {
            scoped_callsign_set.contains(&request.normalized_callsign)
        })
        .flat_map(|request| request.network_ids.iter().copied())
        .unique()
        .sorted()
        .collect_vec();

    let mut groups = Vec::new();
    if !unscoped_callsigns.is_empty() {
        groups.push(NetworkCallsignQueryGroup {
            callsigns: unscoped_callsigns,
            network_scope: None,
        });
    }
    if !scoped_callsigns.is_empty() {
        groups.push(NetworkCallsignQueryGroup {
            callsigns: scoped_callsigns,
            network_scope: Some(network_scope),
        });
    }
    groups
}

type CatalogRow = (sigint_callsign::Model, Option<sigint_unit::Model>);

async fn load_catalog_callsigns(
    dbx: &DatabaseConnection,
    mut callsigns_to_query: Vec<String>,
) -> Result<Vec<CatalogRow>, AppError> {
    let mut catalog_rows = Vec::new();
    while !callsigns_to_query.is_empty() {
        let (callsign_chunk, remaining_callsigns) =
            cap_vector(callsigns_to_query);
        callsigns_to_query = remaining_callsigns;
        catalog_rows.extend(
            sigint_callsign::Entity::find()
                .find_also_related(sigint_unit::Entity)
                .filter(sigint_callsign::Column::Callsign.is_in(callsign_chunk))
                .filter(sigint_callsign::Column::Deleted.eq(false))
                .filter(sigint_unit::Column::Deleted.eq(false))
                .filter(sigint_unit::Column::Active.eq(true))
                .all(dbx)
                .await
                .c(h!())?,
        );
    }
    catalog_rows.sort_by_key(|(callsign, _)| callsign.id);
    Ok(catalog_rows)
}

async fn load_reported_network_ids(
    dbx: &DatabaseConnection,
    mut catalog_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut network_ids_by_catalog_id = HashMap::<i64, Vec<i64>>::new();
    while !catalog_ids.is_empty() {
        let (catalog_id_chunk, remaining_catalog_ids) = cap_vector(catalog_ids);
        catalog_ids = remaining_catalog_ids;
        for (catalog_id, network_id) in sigint_network_callsign::Entity::find()
            .filter(
                sigint_network_callsign::Column::SigintCallsignId
                    .is_in(catalog_id_chunk),
            )
            .filter(sigint_network_callsign::Column::Deleted.eq(false))
            .select_only()
            .column(sigint_network_callsign::Column::SigintCallsignId)
            .column(sigint_network_callsign::Column::SigintNetworkId)
            .into_tuple::<(i64, i64)>()
            .all(dbx)
            .await
            .c(h!())?
        {
            network_ids_by_catalog_id
                .entry(catalog_id)
                .or_default()
                .push(network_id);
        }
    }
    for network_ids in network_ids_by_catalog_id.values_mut() {
        network_ids.sort_unstable();
        network_ids.dedup();
    }
    Ok(network_ids_by_catalog_id)
}

fn network_callsigns_base_query(
    network_scope: Option<&[i64]>,
) -> Select<sigint_network_callsign::Entity> {
    let mut query = sigint_network_callsign::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_callsign::Relation::SigintNetwork.def(),
        )
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false));
    if let Some(network_ids) = network_scope {
        query = query.filter(
            sigint_network_callsign::Column::SigintNetworkId
                .is_in(network_ids.iter().copied()),
        );
    }
    query.order_by_asc(sigint_network_callsign::Column::Id)
}

fn network_callsigns_by_text_query(
    callsigns: &[String],
    network_scope: Option<&[i64]>,
) -> Select<sigint_network_callsign::Entity> {
    network_callsigns_base_query(network_scope).filter(
        Func::lower(Expr::col((
            sigint_network_callsign::Entity,
            sigint_network_callsign::Column::SigintCallsign,
        )))
        .is_in(callsigns.iter().cloned()),
    )
}

fn network_callsigns_by_catalog_id_query(
    catalog_ids: &[i64],
    network_scope: Option<&[i64]>,
) -> Select<sigint_network_callsign::Entity> {
    network_callsigns_base_query(network_scope).filter(
        sigint_network_callsign::Column::SigintCallsignId
            .is_in(catalog_ids.iter().copied()),
    )
}

fn network_scope_chunks(network_scope: Option<&[i64]>) -> Vec<Option<&[i64]>> {
    match network_scope {
        Some(network_ids) => network_ids
            .chunks(RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE)
            .map(Some)
            .collect(),
        None => vec![None],
    }
}

async fn load_network_callsigns(
    dbx: &DatabaseConnection,
    mut requested_callsigns: Vec<String>,
    mut catalog_ids: Vec<i64>,
    network_scope: Option<&[i64]>,
) -> Result<Vec<sigint_network_callsign::Model>, AppError> {
    let mut network_callsigns = BTreeMap::new();
    let network_scope_chunks = network_scope_chunks(network_scope);
    while !requested_callsigns.is_empty() {
        let (callsign_chunk, remaining_callsigns) =
            cap_vector(requested_callsigns);
        requested_callsigns = remaining_callsigns;
        for network_scope in &network_scope_chunks {
            for network_callsign in
                network_callsigns_by_text_query(&callsign_chunk, *network_scope)
                    .all(dbx)
                    .await
                    .c(h!())?
            {
                network_callsigns
                    .entry(network_callsign.id)
                    .or_insert(network_callsign);
            }
        }
    }
    while !catalog_ids.is_empty() {
        let (catalog_id_chunk, remaining_catalog_ids) = cap_vector(catalog_ids);
        catalog_ids = remaining_catalog_ids;
        for network_scope in &network_scope_chunks {
            for network_callsign in network_callsigns_by_catalog_id_query(
                &catalog_id_chunk,
                *network_scope,
            )
            .all(dbx)
            .await
            .c(h!())?
            {
                network_callsigns
                    .entry(network_callsign.id)
                    .or_insert(network_callsign);
            }
        }
    }
    Ok(network_callsigns.into_values().collect())
}

async fn load_network_callsigns_for_requests(
    dbx: &DatabaseConnection,
    requests: &[CallsignRequest],
    catalog: &CatalogLookup,
) -> Result<Vec<sigint_network_callsign::Model>, AppError> {
    let mut network_callsigns = BTreeMap::new();
    for group in network_callsign_query_groups(requests) {
        let catalog_ids = catalog.catalog_ids_for_callsigns(&group.callsigns);
        for network_callsign in load_network_callsigns(
            dbx,
            group.callsigns,
            catalog_ids,
            group.network_scope.as_deref(),
        )
        .await
        .c(h!())?
        {
            network_callsigns
                .entry(network_callsign.id)
                .or_insert(network_callsign);
        }
    }
    Ok(network_callsigns.into_values().collect())
}

async fn load_network_unit_names(
    dbx: &DatabaseConnection,
    network_callsigns: &[sigint_network_callsign::Model],
) -> Result<HashMap<i64, String>, AppError> {
    let mut unit_ids = network_callsigns
        .iter()
        .filter_map(|network_callsign| network_callsign.unit_id)
        .unique()
        .collect_vec();
    let mut unit_names = HashMap::new();
    while !unit_ids.is_empty() {
        let (unit_id_chunk, remaining_unit_ids) = cap_vector(unit_ids);
        unit_ids = remaining_unit_ids;
        let units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(unit_id_chunk))
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Active.eq(true))
            .all(dbx)
            .await
            .c(h!())?;
        unit_names.extend(units.into_iter().map(|unit| (unit.id, unit.name)));
    }
    Ok(unit_names)
}

struct CatalogHint {
    position: String,
    formation: String,
}

struct CatalogLookup {
    info_by_callsign: HashMap<String, Vec<CallsignInfo>>,
    hint_by_id: HashMap<i64, CatalogHint>,
    ids_by_callsign: HashMap<String, Vec<i64>>,
}

impl CatalogLookup {
    fn new(
        catalog_rows: Vec<CatalogRow>,
        reported_network_ids: HashMap<i64, Vec<i64>>,
    ) -> Self {
        let mut info_by_callsign = HashMap::<String, Vec<CallsignInfo>>::new();
        let mut hint_by_id = HashMap::new();
        let mut ids_by_callsign = HashMap::<String, Vec<i64>>::new();

        for (callsign, unit) in catalog_rows {
            let Some(unit) = unit else {
                continue;
            };
            let normalized_callsign = callsign.callsign.to_lowercase();
            ids_by_callsign
                .entry(normalized_callsign.clone())
                .or_default()
                .push(callsign.id);
            hint_by_id.insert(
                callsign.id,
                CatalogHint {
                    position: callsign.position.clone(),
                    formation: unit.name.clone(),
                },
            );
            info_by_callsign
                .entry(normalized_callsign)
                .or_default()
                .push(CallsignInfo {
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
                    unit_2: String::new(),
                    unit_id: Some(unit.id),
                    network_ids_reported_in: reported_network_ids
                        .get(&callsign.id)
                        .cloned()
                        .unwrap_or_default(),
                });
        }

        Self {
            info_by_callsign,
            hint_by_id,
            ids_by_callsign,
        }
    }

    fn catalog_ids_for_callsigns(&self, callsigns: &[String]) -> Vec<i64> {
        callsigns
            .iter()
            .filter_map(|callsign| self.ids_by_callsign.get(callsign))
            .flatten()
            .copied()
            .unique()
            .sorted()
            .collect()
    }
}

struct NetworkCallsignLookup {
    by_id: BTreeMap<i64, sigint_network_callsign::Model>,
    ids_by_callsign: HashMap<String, Vec<i64>>,
    ids_by_catalog_id: HashMap<i64, Vec<i64>>,
}

impl NetworkCallsignLookup {
    fn new(network_callsigns: Vec<sigint_network_callsign::Model>) -> Self {
        let mut by_id = BTreeMap::new();
        let mut ids_by_callsign = HashMap::<String, Vec<i64>>::new();
        let mut ids_by_catalog_id = HashMap::<i64, Vec<i64>>::new();

        for network_callsign in network_callsigns {
            let id = network_callsign.id;
            ids_by_callsign
                .entry(network_callsign.sigint_callsign.to_lowercase())
                .or_default()
                .push(id);
            if let Some(catalog_id) = network_callsign.sigint_callsign_id {
                ids_by_catalog_id.entry(catalog_id).or_default().push(id);
            }
            by_id.insert(id, network_callsign);
        }

        Self {
            by_id,
            ids_by_callsign,
            ids_by_catalog_id,
        }
    }

    fn matching<'a>(
        &'a self,
        request: &CallsignRequest,
        catalog_ids: Option<&Vec<i64>>,
    ) -> Vec<&'a sigint_network_callsign::Model> {
        let mut matching_ids = BTreeSet::new();
        if let Some(ids) =
            self.ids_by_callsign.get(&request.normalized_callsign)
        {
            matching_ids.extend(ids);
        }
        for catalog_id in catalog_ids.into_iter().flatten() {
            if let Some(ids) = self.ids_by_catalog_id.get(catalog_id) {
                matching_ids.extend(ids);
            }
        }

        matching_ids
            .into_iter()
            .filter_map(|id| self.by_id.get(id))
            .filter(|network_callsign| {
                request.network_ids.is_empty()
                    || request
                        .network_ids
                        .binary_search(&network_callsign.sigint_network_id)
                        .is_ok()
            })
            .collect()
    }
}

fn build_callsign_response(
    request: CallsignRequest,
    catalog: &CatalogLookup,
    network_callsigns: &NetworkCallsignLookup,
    network_unit_names: &HashMap<i64, String>,
) -> CallsignInfoRes {
    let catalog_ids = catalog.ids_by_callsign.get(&request.normalized_callsign);
    let mut seen_hints = HashSet::new();
    let network_hints = network_callsigns
        .matching(&request, catalog_ids)
        .into_iter()
        .map(|network_callsign| {
            let catalog_hint = network_callsign
                .sigint_callsign_id
                .and_then(|id| catalog.hint_by_id.get(&id));
            let network_formation = network_callsign
                .unit_id
                .and_then(|unit_id| network_unit_names.get(&unit_id))
                .map(String::as_str);
            let catalog_formation =
                catalog_hint.map(|hint| hint.formation.as_str());
            CallsignNetworkHint {
                id: network_callsign.id,
                network_id: network_callsign.sigint_network_id,
                position: network_callsign
                    .position
                    .as_ref()
                    .filter(|position| !position.trim().is_empty())
                    .cloned()
                    .or_else(|| catalog_hint.map(|hint| hint.position.clone()))
                    .unwrap_or_default(),
                formation: resolve_network_hint_formation(
                    network_formation,
                    catalog_formation,
                ),
            }
        })
        .filter(|hint| {
            seen_hints.insert((
                hint.network_id,
                hint.position.clone(),
                hint.formation.clone(),
            ))
        })
        .collect();

    CallsignInfoRes {
        res: catalog
            .info_by_callsign
            .get(&request.normalized_callsign)
            .cloned()
            .unwrap_or_default(),
        callsign: request.callsign,
        network_hints,
    }
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

fn cap_vector<T>(mut source: Vec<T>) -> (Vec<T>, Vec<T>) {
    if source.len() <= RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE {
        (source, Vec::new())
    } else {
        let remaining = source.split_off(RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE);
        (source, remaining)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_network_callsign;
    use crate::rer_importer::types::CallsignNetworks;

    fn request(callsign: &str, network_ids: Vec<i64>) -> CallsignRequest {
        prepare_callsign_requests(vec![CallsignNetworks {
            callsign: callsign.to_string(),
            network_ids,
        }])
        .remove(0)
    }

    fn network_callsign(
        id: i64,
        network_id: i64,
        callsign: &str,
        catalog_id: Option<i64>,
        position: Option<&str>,
    ) -> sigint_network_callsign::Model {
        sigint_network_callsign::Model {
            id,
            sigint_network_id: network_id,
            deleted: false,
            created_at: Default::default(),
            sigint_callsign: callsign.to_string(),
            sigint_origin_id: None,
            position: position.map(str::to_string),
            comment: None,
            sigint_callsign_id: catalog_id,
            source_id: None,
            radio_freq: None,
            developing: false,
            unit_developing: false,
            unit_id: None,
            main_radio_station: false,
            original_id: None,
            command_control: false,
            full_name: None,
        }
    }

    fn catalog_lookup() -> CatalogLookup {
        CatalogLookup {
            info_by_callsign: HashMap::new(),
            hint_by_id: HashMap::from([(
                7,
                CatalogHint {
                    position: "catalog position".to_string(),
                    formation: "catalog formation".to_string(),
                },
            )]),
            ids_by_callsign: HashMap::from([("ветер".to_string(), vec![7])]),
        }
    }

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
    fn prepares_and_deduplicates_requested_callsigns() {
        let requests = prepare_callsign_requests(vec![
            CallsignNetworks {
                callsign: "ВЕТЕР".to_string(),
                network_ids: vec![20, 10, 20],
            },
            CallsignNetworks {
                callsign: "ветер".to_string(),
                network_ids: vec![],
            },
        ]);

        assert_eq!(requests[0].normalized_callsign, "ветер");
        assert_eq!(requests[0].network_ids, vec![10, 20]);
        assert_eq!(requested_callsigns(&requests), vec!["ветер"]);
    }

    #[test]
    fn preserves_scoping_for_mixed_query_batches() {
        let requests = vec![
            request("one", vec![20, 10]),
            request("two", vec![]),
            request("three", vec![30]),
            request("one", vec![40]),
        ];

        assert_eq!(
            network_callsign_query_groups(&requests),
            vec![
                NetworkCallsignQueryGroup {
                    callsigns: vec!["two".to_string()],
                    network_scope: None,
                },
                NetworkCallsignQueryGroup {
                    callsigns: vec!["one".to_string(), "three".to_string()],
                    network_scope: Some(vec![10, 20, 30, 40]),
                },
            ]
        );
    }

    #[test]
    fn avoids_requerying_a_callsign_that_also_needs_unscoped_hints() {
        let requests = vec![
            request("one", vec![10]),
            request("one", vec![]),
            request("two", vec![20]),
        ];

        assert_eq!(
            network_callsign_query_groups(&requests),
            vec![
                NetworkCallsignQueryGroup {
                    callsigns: vec!["one".to_string()],
                    network_scope: None,
                },
                NetworkCallsignQueryGroup {
                    callsigns: vec!["two".to_string()],
                    network_scope: Some(vec![20]),
                },
            ]
        );
    }

    #[test]
    fn chunks_at_the_sql_parameter_boundary() {
        let source = (0..=RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE)
            .map(|id| id.to_string())
            .collect::<Vec<_>>();
        let (first, second) = cap_vector(source);
        assert_eq!(first.len(), RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE);
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn chunks_network_scope_for_queries_with_two_in_clauses() {
        let network_ids = (0..=RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE as i64)
            .collect::<Vec<_>>();
        let chunk_lengths = network_scope_chunks(Some(&network_ids))
            .into_iter()
            .map(|chunk| chunk.unwrap().len())
            .collect_vec();

        assert_eq!(chunk_lengths, vec![RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE, 1]);
    }

    #[test]
    fn network_text_query_is_case_insensitive_and_scoped() {
        let query = network_callsigns_by_text_query(
            &["ветер".to_string()],
            Some(&[10, 20]),
        );
        let sql = query.build(DatabaseBackend::Postgres).to_string();

        assert!(sql.contains("INNER JOIN \"sigint_network\""), "{sql}");
        assert!(
            sql.contains(
                "LOWER(\"sigint_network_callsign\".\"sigint_callsign\") IN"
            ),
            "{sql}"
        );
        assert!(
            sql.contains(
                "\"sigint_network_callsign\".\"sigint_network_id\" IN"
            ),
            "{sql}"
        );
        assert!(!sql.contains("\"sigint_network\".\"name\" AS"), "{sql}");
    }

    #[test]
    fn unscoped_network_query_does_not_add_a_network_id_filter() {
        let query =
            network_callsigns_by_text_query(&["ветер".to_string()], None);
        let sql = query.build(DatabaseBackend::Postgres).to_string();

        assert!(
            !sql.contains(
                "\"sigint_network_callsign\".\"sigint_network_id\" IN"
            ),
            "{sql}"
        );
    }

    #[test]
    fn builds_scoped_ordered_deduplicated_hints_with_catalog_fallbacks() {
        let network_callsigns = NetworkCallsignLookup::new(vec![
            network_callsign(40, 20, "ВЕТЕР", None, Some("other network")),
            network_callsign(30, 10, "Ветер-1", Some(7), Some("second")),
            network_callsign(20, 10, "ВЕТЕР", Some(7), None),
            network_callsign(10, 10, "ВЕТЕР", Some(7), None),
        ]);
        let response = build_callsign_response(
            request("ветер", vec![10]),
            &catalog_lookup(),
            &network_callsigns,
            &HashMap::new(),
        );

        assert_eq!(
            response.network_hints,
            vec![
                CallsignNetworkHint {
                    id: 10,
                    network_id: 10,
                    position: "catalog position".to_string(),
                    formation: "catalog formation".to_string(),
                },
                CallsignNetworkHint {
                    id: 30,
                    network_id: 10,
                    position: "second".to_string(),
                    formation: "catalog formation".to_string(),
                },
            ]
        );
    }

    #[test]
    fn scoped_requests_include_only_requested_network_hints() {
        let network_callsigns = NetworkCallsignLookup::new(vec![
            network_callsign(10, 10, "ВЕТЕР", None, Some("current")),
            network_callsign(20, 20, "ВЕТЕР", None, Some("other")),
        ]);
        let response = build_callsign_response(
            request("ветер", vec![10]),
            &CatalogLookup {
                info_by_callsign: HashMap::new(),
                hint_by_id: HashMap::new(),
                ids_by_callsign: HashMap::new(),
            },
            &network_callsigns,
            &HashMap::new(),
        );

        assert_eq!(
            response
                .network_hints
                .iter()
                .map(|hint| hint.network_id)
                .collect_vec(),
            vec![10]
        );
    }

    #[test]
    fn unscoped_requests_include_all_exact_network_hints() {
        let network_callsigns = NetworkCallsignLookup::new(vec![
            network_callsign(10, 10, "ВЕТЕР", None, Some("current")),
            network_callsign(20, 20, "ВЕТЕР", None, Some("other")),
        ]);
        let response = build_callsign_response(
            request("ветер", vec![]),
            &CatalogLookup {
                info_by_callsign: HashMap::new(),
                hint_by_id: HashMap::new(),
                ids_by_callsign: HashMap::new(),
            },
            &network_callsigns,
            &HashMap::new(),
        );

        assert_eq!(
            response
                .network_hints
                .iter()
                .map(|hint| hint.network_id)
                .collect_vec(),
            vec![10, 20]
        );
    }

    #[test]
    fn blank_network_fields_still_produce_a_hint() {
        let network_callsigns =
            NetworkCallsignLookup::new(vec![network_callsign(
                10,
                10,
                "ВЕТЕР",
                None,
                Some("  "),
            )]);
        let response = build_callsign_response(
            request("ветер", vec![10]),
            &CatalogLookup {
                info_by_callsign: HashMap::new(),
                hint_by_id: HashMap::new(),
                ids_by_callsign: HashMap::new(),
            },
            &network_callsigns,
            &HashMap::new(),
        );

        assert_eq!(response.network_hints.len(), 1);
        assert_eq!(response.network_hints[0].position, "");
        assert_eq!(response.network_hints[0].formation, "");
    }

    #[test]
    fn catalog_rows_follow_the_normalized_requested_callsign() {
        let catalog = CatalogLookup {
            info_by_callsign: HashMap::from([(
                "ветер".to_string(),
                vec![CallsignInfo {
                    id: 7,
                    callsign: "ВЕТЕР".to_string(),
                    position: "position".to_string(),
                    comment: String::new(),
                    unit_1: "unit".to_string(),
                    unit_2: String::new(),
                    unit_id: Some(1),
                    network_ids_reported_in: vec![],
                }],
            )]),
            hint_by_id: HashMap::new(),
            ids_by_callsign: HashMap::new(),
        };
        let response = build_callsign_response(
            request("ВЕТЕР", vec![]),
            &catalog,
            &NetworkCallsignLookup::new(vec![]),
            &HashMap::new(),
        );

        assert_eq!(response.res.len(), 1);
        assert_eq!(response.res[0].callsign, "ВЕТЕР");
    }

    #[test]
    fn matches_a_different_network_text_through_catalog_id() {
        let network_callsigns =
            NetworkCallsignLookup::new(vec![network_callsign(
                1,
                10,
                "Ветер-1",
                Some(7),
                None,
            )]);
        let response = build_callsign_response(
            request("ветер", vec![]),
            &catalog_lookup(),
            &network_callsigns,
            &HashMap::new(),
        );

        assert_eq!(response.network_hints.len(), 1);
        assert_eq!(response.network_hints[0].network_id, 10);
    }
}

use crate::location::trie::Trie;
use crate::location::types::Language;
pub use crate::location::types::SettlementsDataConfig;
pub(crate) use crate::location::types::{
    CoordinateWithLocality, FindSettlementReq, LocalityDetails,
    MapCoordinatesReq, SettlementDetails, SettlementFileRow,
};
use crate::types::*;
use crate::users::ensure_rer_role;
use actix_web::web::Json;
use actix_web::{get, post, HttpRequest};
use itertools::Itertools;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::ConnectionTrait;
use std::collections::BTreeSet;
use std::fs;

pub mod aor_config;
pub mod peleng;
pub mod trie;
pub mod types;
pub mod utils;
pub mod worker;

pub type SettlementsData = (
    Vec<String>,
    Vec<String>,
    Trie<SettlementDetails>,
    BTreeMap<i32, SettlementDetails>,
    BTreeMap<String, Vec<SettlementDetails>>,
);

#[post("/api/location/map-coordinates")]
async fn map_coordinates(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MapCoordinatesReq>,
) -> Result<Json<Vec<CoordinateWithLocality>>, AppError> {
    let login = crate::users::login_id_from_identity(&user).c(h!())?;
    crate::users::ensure_rer_role_by_id(&env.dbx, &login)
        .await
        .c(h!())?;

    let coords = req.into_inner().coords;
    let indexed_coords = coords
        .iter()
        .enumerate()
        .map(|(index, coord)| {
            (
                index as i64,
                milgeo_rs::coord_util::LatLng {
                    lat: coord.lat,
                    lng: coord.lon,
                },
            )
        })
        .collect();
    let mapped_coords = milgeo_rs::coord_util::map_coords(
        indexed_coords,
        env.mil_geo.clone(),
        3,
    )
    .await
    .c(h!())?;

    let result = coords
        .into_iter()
        .enumerate()
        .map(|(index, coords)| CoordinateWithLocality {
            coords,
            locality: mapped_coords
                .get(&(index as i64))
                .into_iter()
                .flatten()
                .next()
                .map(|locality| LocalityDetails {
                    settlement_name: locality.settlement_name.clone(),
                    direction: locality.direction.clone(),
                    distance_m: locality.distance_m,
                    is_rf: locality.is_rf,
                }),
        })
        .collect();

    Ok(Json(result))
}

#[post("/api/settlement/find")]
async fn find_locations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FindSettlementReq>,
) -> Result<Json<Vec<SettlementDetails>>, AppError> {
    let login = crate::users::login_id_from_identity(&user)?;
    crate::users::ensure_rer_role_by_id(&env.dbx, &login)
        .await
        .c(h!())?;
    let req = req.into_inner();
    let aor_scope =
        resolve_settlement_request_aor_scope(&env.dbx, &login, &req).await?;
    let locations = find_settlements_by_name_scope(
        env.settlements.clone(),
        req.query,
        req.region,
        req.related_coordinates,
        aor_scope.as_deref(),
    )
    .c(h!())?;
    Ok(Json(locations))
}

#[post("/api/settlement/find-prefix")]
async fn find_locations_prefix(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FindSettlementReq>,
) -> Result<Json<Vec<SettlementDetails>>, AppError> {
    let login = crate::users::login_id_from_identity(&user)?;
    crate::users::ensure_rer_role_by_id(&env.dbx, &login)
        .await
        .c(h!())?;
    let req = req.into_inner();
    let aor_scope =
        resolve_settlement_request_aor_scope(&env.dbx, &login, &req).await?;
    let locations = find_settlements_by_prefix_scope(
        env.settlements.clone(),
        req.query,
        req.region,
        req.related_coordinates,
        aor_scope.as_deref(),
    )
    .c(h!())?;

    Ok(Json(locations))
}

async fn resolve_settlement_request_aor_scope<C>(
    dbx: &C,
    login: &uuid::Uuid,
    req: &FindSettlementReq,
) -> Result<Option<Vec<i64>>, AppError>
where
    C: ConnectionTrait,
{
    let group_key = req
        .signal_group_master_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    if group_key.is_some() && req.aor_id.is_some() {
        return Err(AppError::BL {
            msg: "Не можна одночасно передавати signal_group_master_key та aor_id."
                .to_string(),
        });
    }
    let Some(group_key) = group_key else {
        return Ok(req.aor_id.map(|aor_id| vec![aor_id]));
    };
    crate::messenger::group::ensure_identity_group_available(
        dbx, login, group_key,
    )
    .await?;
    let aor_ids =
        crate::messenger::group::resolve_group_aor_ids(dbx, group_key).await?;
    Ok((!aor_ids.is_empty()).then_some(aor_ids))
}

#[cfg(test)]
fn find_settlements_by_prefix(
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    query: String,
    m_region: Option<String>,
    m_src_coords: Option<(f64, f64)>,
    m_aor_id: Option<i64>,
) -> anyhow::Result<Vec<SettlementDetails>> {
    find_settlements_by_prefix_scope(
        settlements,
        query,
        m_region,
        m_src_coords,
        m_aor_id.map(|aor_id| vec![aor_id]).as_deref(),
    )
}

fn find_settlements_by_prefix_scope(
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    query: String,
    m_region: Option<String>,
    m_src_coords: Option<(f64, f64)>,
    m_aor_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<SettlementDetails>> {
    let query = query.trim().to_uppercase();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .c(h!())?;
    let sources = select_settlements_sources(&settlements_lock, m_aor_ids);
    let mut locations = vec![];
    for source in sources {
        let (_, _, _, _, settlements_by_name) = source;
        for (name, settlements) in settlements_by_name.range(query.clone()..) {
            if !name.starts_with(&query) {
                break;
            }
            locations.extend(settlements.iter().cloned());
        }
    }
    Ok(finalize_settlement_search(
        locations,
        m_region,
        m_src_coords,
    ))
}

#[derive(Debug, Deserialize)]
struct FetchRegionsReq {
    aor_id: Option<i64>,
}

#[get("/api/location/regions")]
async fn fetch_regions(
    user: actix_identity::Identity,
    _http_req: HttpRequest,
    req: actix_web::web::Query<FetchRegionsReq>,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<String>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let region_names =
        get_region_names(env.settlements.clone(), req.aor_id).c(h!())?;
    Ok(Json(region_names))
}

fn select_settlements_data(
    config: &SettlementsDataConfig,
    m_aor_id: Option<i64>,
) -> &SettlementsData {
    match m_aor_id {
        Some(aor_id) => match config.aor_id_to_settlements_data.get(&aor_id) {
            Some(data) => data.as_ref(),
            None => {
                warn!(
                    "no settlements config found for aor_id={}, using default settlements list from config.toml",
                    aor_id
                );
                config.default_settlements_data.as_ref()
            }
        },
        None => config.default_settlements_data.as_ref(),
    }
}

fn select_settlements_sources<'a>(
    config: &'a SettlementsDataConfig,
    m_aor_ids: Option<&[i64]>,
) -> Vec<&'a SettlementsData> {
    let Some(aor_ids) = m_aor_ids else {
        return vec![config.default_settlements_data.as_ref()];
    };
    if aor_ids.is_empty() {
        return vec![config.default_settlements_data.as_ref()];
    }

    let mut sources = vec![];
    let mut default_added = false;
    for aor_id in aor_ids {
        if let Some(data) = config.aor_id_to_settlements_data.get(aor_id) {
            sources.push(data.as_ref());
        } else if !default_added {
            sources.push(config.default_settlements_data.as_ref());
            default_added = true;
        }
    }
    sources
}

fn get_region_names(
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    m_aor_id: Option<i64>,
) -> anyhow::Result<Vec<String>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .c(h!())?;
    let config = select_settlements_data(&settlements_lock, m_aor_id);
    let (region_names, _, _, _, _) = config;
    Ok(region_names.clone())
}

fn find_settlements_by_name_scope(
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    query: String,
    m_region: Option<String>,
    m_src_coords: Option<(f64, f64)>,
    m_aor_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<SettlementDetails>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .c(h!())?;
    let sources = select_settlements_sources(&settlements_lock, m_aor_ids);
    let mut matches: Vec<SettlementDetails> = Vec::new();
    let query = query.to_uppercase();
    for source in sources {
        let (_, _, _, settlements, _) = source;
        for s in settlements.values() {
            if s.name.contains(&query) {
                matches.push(s.clone());
            }
        }
    }
    Ok(finalize_settlement_search(matches, m_region, m_src_coords))
}

fn finalize_settlement_search(
    locations: Vec<SettlementDetails>,
    m_region: Option<String>,
    m_src_coords: Option<(f64, f64)>,
) -> Vec<SettlementDetails> {
    let locations = filter_locations_by_region(locations, m_region);
    let mut seen = BTreeSet::new();
    let mut unique_locations = vec![];
    for location in locations {
        if seen.insert(settlement_dedup_key(&location)) {
            unique_locations.push(location);
        }
    }
    unique_locations.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.region.cmp(&right.region))
            .then_with(|| left.language.cmp(&right.language))
            .then_with(|| left.id.cmp(&right.id))
            .then_with(|| {
                settlement_coords_key(left).cmp(&settlement_coords_key(right))
            })
    });
    rank_locations_by_coordinates(unique_locations, m_src_coords)
}

fn settlement_coords_key(location: &SettlementDetails) -> Option<(u64, u64)> {
    location
        .coords
        .map(|(lat, lon)| (lat.to_bits(), lon.to_bits()))
}

fn settlement_dedup_key(
    location: &SettlementDetails,
) -> (Option<i32>, String, String, Language, Option<(u64, u64)>) {
    (
        location.id,
        location.name.clone(),
        location.region.clone(),
        location.language.clone(),
        settlement_coords_key(location),
    )
}

fn filter_locations_by_region(
    mut locations: Vec<SettlementDetails>,
    m_region: Option<String>,
) -> Vec<SettlementDetails> {
    if let Some(region) = m_region {
        locations.retain(|location| location.region == region);
    }
    locations
}

fn rank_locations_by_coordinates(
    mut locations: Vec<SettlementDetails>,
    m_src_coords: Option<(f64, f64)>,
) -> Vec<SettlementDetails> {
    if let Some((lat, lon)) = m_src_coords {
        if locations.len() > 1 {
            let mut new_result = vec![];
            let mut min_distance = -1.0;
            for location in locations {
                if let Some((lat_a, lon_a)) = location.coords {
                    let new_distance =
                        (lat - lat_a).abs() + (lon - lon_a).abs();
                    if min_distance < 0.0 || min_distance / new_distance > 5.0 {
                        min_distance = new_distance;
                        new_result = vec![location];
                    } else if new_distance < min_distance {
                        min_distance = new_distance;
                        new_result.insert(0, location);
                    } else {
                        new_result.push(location);
                    }
                }
            }
            locations = new_result;
        }
    }
    locations
}

pub fn parse_location_with_aor(
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    location: String,
    m_aor_id: Option<i64>,
) -> anyhow::Result<Vec<SettlementDetails>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .c(h!())?;
    let settlements_data = select_settlements_data(&settlements_lock, m_aor_id);
    lazy_static! {
        static ref JUNK_CHAR_RE: Regex =
            Regex::new(r#"[ \(\)\.\-\,\/\:";!\?\*\%\$@0-9]"#).unwrap();
        static ref JUNK_WORD_RE: Regex = Regex::new(
            &r#"\W($s1)"#.replace("$s1", &collect_blacklist().join("|"))
        )
        .unwrap();
    }
    let location = location
        .to_uppercase()
        .replace("Ы", "І")
        .replace("ОБЛ.", "ОБЛАСТЬ")
        .replace("РАЙ.", "РАЙОН")
        .replace("Р-Н. ", "РАЙОН ")
        .replace("Р-Н ", "РАЙОН ")
        .replace("Н.П.", " ")
        .replace("ОБ-ТЬ", "ОБЛАСТЬ");
    let location = JUNK_CHAR_RE.replace_all(&location, " ").to_string();
    let location = JUNK_WORD_RE.replace_all(&location, " ").to_string();
    let location = trim(location);
    let location = try_process_nearest_location(location);
    let words = location
        .split_whitespace()
        .map(|x| x.to_string())
        .collect_vec();
    let result = find_matching_settlements(words, settlements_data).c(h!())?;
    if result.is_empty() {
        return Ok(vec![]);
    }

    let result = deduplicate_settlement_names(result);

    Ok(result)
}

fn try_process_nearest_location(location: String) -> String {
    let mut words = location
        .split_whitespace()
        .map(|x| x.to_string().to_uppercase())
        .collect_vec();
    let mut has_nearest_word = false;
    for rec in collect_near() {
        let mut new_words = vec![];
        for word in words {
            if word.eq(rec) {
                has_nearest_word = true;
            } else {
                new_words.push(word);
            }
        }
        words = new_words;
    }
    if has_nearest_word {
        let mut new_words = vec![];
        for w in words {
            new_words.push(trim_tail(w));
        }
        words = new_words;
    }
    words.join(" ")
}

fn trim_tail(name: String) -> String {
    let mut name_vec = name.chars().collect_vec();
    if name.ends_with("ОГО") {
        name_vec.pop();
        name_vec.pop();
        name_vec.pop();
        name_vec.push('Е')
    } else if name.ends_with("ОЇ") {
        name_vec.pop();
        name_vec.pop();
        name_vec.push('А')
    } else if name.ends_with("ІВ") {
        name_vec.pop();
        name_vec.pop();
        name_vec.push('И')
    }
    let name: String = name_vec.iter().collect();
    name
}

fn find_matching_settlements(
    words: Vec<String>,
    config: &SettlementsData,
) -> anyhow::Result<Vec<SettlementDetails>> {
    let (_region_names, regions, trie, _, _) = config;
    if words.is_empty() {
        return Ok(vec![]);
    }
    let mut result = BTreeMap::new();
    let mut cache = vec![];
    for word in words.clone() {
        let res = match_settlement(&word, trie);
        cache.push((word, res));
    }
    let mut i = 0;
    while i + 2 < words.len() {
        i = handle_three_words_group(regions, trie, &mut result, &mut cache, i)
            .c(h!())?;
    }
    let remainder = words.len() - i;
    if remainder == 1 {
        let new_data = cache.get(i).cloned().c(h!())?.to_owned().1.data;
        for (row, coords) in new_data {
            result.insert(row, coords);
        }
    } else {
        handle_two_words_group(regions, trie, &mut result, &mut cache, i)
            .c(h!())?;
    }
    let mut result = result.into_iter().collect_vec();
    result.sort_by_key(|(key, _data)| key.clone());
    let mut result_data = vec![];
    for (_, row) in result {
        result_data.push(row);
    }
    Ok(result_data)
}

fn handle_two_words_group(
    regions: &[String],
    trie: &Trie<SettlementDetails>,
    result: &mut BTreeMap<String, SettlementDetails>,
    cache: &mut [(String, trie::Result<SettlementDetails>)],
    i: usize,
) -> anyhow::Result<()> {
    let (word0, res0) = cache.get(i).c(h!())?;
    let (word1, res1) = cache.get(i + 1).c(h!())?;
    let query = &format!("{word0} {word1}");
    let joined_res = match_settlement(query, trie);
    let is_region =
        joined_res.data.iter().any(|(row, _)| regions.contains(row));
    if is_region {
        return Ok(());
    }
    let data = if joined_res.data.is_empty() {
        [res0.data.as_slice(), res1.data.as_slice()].concat()
    } else {
        joined_res.data
    };
    for (rec, coords) in data {
        result.insert(rec, coords);
    }
    Ok(())
}

fn handle_three_words_group(
    regions: &[String],
    trie: &Trie<SettlementDetails>,
    result: &mut BTreeMap<String, SettlementDetails>,
    cache: &mut [(String, trie::Result<SettlementDetails>)],
    i: usize,
) -> anyhow::Result<usize> {
    let (word0, res0) = cache.get(i).c(h!())?;
    let (word1, _) = cache.get(i + 1).c(h!())?;
    let mut i = i + 1;
    let joined0 = format!("{word0} {word1}");
    let joined_res = match_settlement(&joined0, trie);
    let data = if !joined_res.data.is_empty() {
        i += 1;
        let is_region =
            joined_res.data.iter().any(|(row, _)| regions.contains(row));
        if is_region {
            vec![]
        } else {
            joined_res.data
        }
    } else {
        res0.data.clone()
    };
    for (k, v) in data {
        result.insert(k, v);
    }
    Ok(i)
}

fn trim(string: String) -> String {
    let mut string = string;
    while string.contains("  ") {
        string = string
            .replace("    ", " ")
            .replace("   ", " ")
            .replace("  ", " ");
    }
    String::from(string.trim())
}

pub(crate) fn remove_standard_location_context_terms(line: &str) -> String {
    line.split_whitespace()
        .filter(|token| !is_standard_location_context_token(token))
        .join(" ")
}

fn is_standard_location_context_token(token: &str) -> bool {
    let token = token.trim_matches(|ch: char| {
        !(ch.is_alphabetic() || ch == '-' || ch == '.' || ch == '/')
    });
    if token.is_empty() {
        return false;
    }

    let token = token.to_uppercase();
    if matches!(token.trim_matches('.'), "Р-Н" | "Н.П" | "Н/П") {
        return true;
    }

    let mut parts =
        token.split(['-', '.', '/']).filter(|part| !part.is_empty());
    let Some(first) = parts.next() else {
        return false;
    };
    is_standard_location_context_word(first)
        && parts.all(is_standard_location_context_word)
}

fn is_standard_location_context_word(word: &str) -> bool {
    let word = normalize_location_context_word(word);
    matches!(
        word.as_str(),
        "ЗАХ"
            | "ЗХ"
            | "СХ"
            | "ПІВН"
            | "ПН"
            | "ПІВД"
            | "ПД"
            | "ЙМ"
            | "ЙМОВ"
            | "ЙМОВІРНО"
    ) || collect_near()
        .into_iter()
        .map(normalize_location_context_word)
        .any(|term| term == word)
}

fn normalize_location_context_word(word: &str) -> String {
    word.replace(r"\.", ".").trim_matches('.').to_uppercase()
}

pub fn load_from_file(
    settlements_paths: Vec<String>,
    mode: Mode,
) -> anyhow::Result<SettlementsData> {
    let mut trie = Trie::<SettlementDetails>::new();
    let mut regions = vec![];

    let root_dir = crate::config::get_data_folder(mode).c(h!())?;
    let mut region_names = BTreeSet::new();

    let mut settlements = BTreeMap::new();
    let mut settlements_by_name: BTreeMap<String, Vec<SettlementDetails>> =
        BTreeMap::new();

    for source in settlements_paths {
        let path = root_dir.join(source.clone());
        if !path.exists() {
            return Err(anyhow!(
                "[{}] cannot load settlements source at {}",
                source,
                path.display()
            ));
        }
        let text = fs::read_to_string(path.clone()).c(h!())?;
        if mode != Mode::Test {
            debug!("[{}] loaded source successfully", &source);
        }
        let data: BTreeMap<String, Vec<SettlementFileRow>> =
            serde_json::from_str(&text).c(h!())?;

        for (region, rows) in data {
            region_names.insert(region.clone());
            for d in rows {
                let language = match &d.language_details {
                    Some(lan) if lan.eq("ru") => Language::Ru,
                    Some(lan) if lan.eq("translit") => Language::UaTranslit,
                    _ => Language::Ua,
                };
                let name = d.name.clone().to_uppercase();
                let details = SettlementDetails {
                    language,
                    name: name.clone(),
                    id: d.id,
                    region: region.clone(),
                    coords: d.coords,
                };
                if let Some(id) = &d.id {
                    settlements.insert(*id, details.clone());
                }
                settlements_by_name
                    .entry(name.clone())
                    .or_default()
                    .push(details.clone());
                trie.insert(&name.clone(), details);
            }
            let region = region.to_uppercase();
            let region_trimmed = region.clone().replace("ОБЛАСТЬ", "ОБЛ");
            regions.push(region.clone());
            regions.push(region_trimmed.clone());
            trie.insert(
                &region,
                SettlementDetails {
                    name: region.clone(),
                    id: None,
                    coords: None,
                    region: region.clone(),
                    language: Language::Ua,
                },
            );
            let key = region_trimmed.clone();
            trie.insert(
                &key,
                SettlementDetails {
                    name: region_trimmed,
                    id: None,
                    coords: None,
                    region,
                    language: Language::Ua,
                },
            );
        }
    }

    let mut region_names = region_names.into_iter().collect_vec();
    region_names.sort();

    Ok((
        region_names,
        regions,
        trie,
        settlements,
        settlements_by_name,
    ))
}

pub fn load_settlements_data_config(
    settlements_paths: Vec<String>,
    mode: Mode,
) -> anyhow::Result<SettlementsDataConfig> {
    let default_settlements_data =
        Arc::new(load_from_file(settlements_paths.clone(), mode).c(h!())?);
    let mut settlements_data_by_config = HashMap::new();
    for source in settlements_paths.iter() {
        let settlements_data =
            load_from_file(vec![source.clone()], mode).c(h!())?;
        settlements_data_by_config
            .insert(source.clone(), Arc::new(settlements_data));
    }
    let available_settlements_configs =
        find_available_settlements_configs(mode).c(h!())?;
    let available_settlements_configs =
        if available_settlements_configs.is_empty() {
            settlements_paths.clone()
        } else {
            available_settlements_configs
        };
    Ok(SettlementsDataConfig {
        aor_id_to_settlements_data: HashMap::new(),
        aor_id_to_config_names: HashMap::new(),
        default_settlements_data,
        default_settlements_files: settlements_paths.clone(),
        settlements_data_by_config,
        available_settlements_configs,
        mode,
    })
}

fn find_available_settlements_configs(
    mode: Mode,
) -> anyhow::Result<Vec<String>> {
    let settlements_dir = crate::config::get_data_folder(mode)
        .c(h!())?
        .join(crate::config::SETTLEMENTS_REGIONS_DIR);
    if !settlements_dir.exists() {
        return Ok(vec![]);
    }

    let mut configs = vec![];
    for entry in fs::read_dir(settlements_dir).c(h!())? {
        let path = entry.c(h!())?.path();
        if !path.is_file()
            || path.extension().and_then(|extension| extension.to_str())
                != Some(crate::config::SETTLEMENTS_REGION_FILE_EXTENSION)
        {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        configs
            .push(format!("{}/{name}", crate::config::SETTLEMENTS_REGIONS_DIR));
    }
    configs.sort();
    Ok(configs)
}

fn match_settlement(
    query: &str,
    trie: &Trie<SettlementDetails>,
) -> trie::Result<SettlementDetails> {
    let len = query.chars().count();
    let distance = if len > 5 {
        Some(1 + (len / 7)) // tweaked based on experiments
    } else {
        None
    };
    let mut result = trie.find_matches(query, distance);
    if result.data.len() > 3 {
        result.data = vec![]; // invalid query, too noisy output
    }
    if result.data.len() > 1 {
        result.data = vec![result.data[0].clone()] // drop alternative names to avoid junk
    }
    result
}

fn collect_near() -> Vec<&'static str> {
    vec![
        "РАЙОН",
        "ВІД",
        "БІЛЯ",
        "МІЖ",
        "ОКОЛИЦІ",
        r#"ОКОЛ\."#,
        "ЗАХІДНІШЕ",
        "СХІДНІШЕ",
        "ПІВНІЧНІШЕ",
        "ПІВДЕННІШЕ",
        "ПІВДЕНІШЕ",
    ]
}

fn collect_blacklist() -> Vec<&'static str> {
    vec![
        "РОЗВІДКИ",
        "РОЗВІДКА",
        "ШТУРМ",
        "ШТУРМОВІ",
        r#"ШТУРМ\."#,
        "ШТУРМОВА",
        "ШТУРМОВЕ",
        "БПЛА",
        "МЕРЕЖА",
        "ВСТАНОВЛЕНА",
        "ВСТАНОВЛЕНО",
        "УКХ",
        "ДМР",
        "САДН",
        "РОТА",
        "РОТИ",
        "ТАНКОВОГО",
        "ПІХОТНОГО",
        "СТРІЛЕЦЬКОГО",
        r#"ІМ"#,
        r#"ЙМ"#,
        "ВІЙСЬКОВА",
        "ВІЙСЬКОВУ",
        "ВІЙСЬКОВОЇ",
        "ВІЙСЬКОВИЙ",
        "ВІЙСЬКОВОГО",
        "УДАРНИЙ",
        "УДАРНИХ",
        "УДАРНОГО",
        "БАТР.",
        "АЗОВСЬКОГО",
        "МОРЯ",
        "КРАСНОДАРСЬКИЙ",
        "БАТАРЕЯ",
        "БАТАРЄЯ",
    ]
}

// removes duplicate names in russian or translit if this settlement is already present in result set
fn deduplicate_settlement_names(
    result: Vec<SettlementDetails>,
) -> Vec<SettlementDetails> {
    let mut aggregated_result: BTreeMap<i32, Vec<SettlementDetails>> =
        BTreeMap::new();

    for rec in result {
        let Some(id) = rec.id else {
            continue;
        };
        aggregated_result.entry(id).or_default().push(rec);
    }
    let mut result = vec![];
    for (_, recs) in aggregated_result {
        let mut recs = recs;
        recs.sort_by_key(|x| x.language.clone());
        if let Some(rec) = recs.into_iter().next() {
            result.push(rec);
        }
    }
    result.sort_by_key(|x| x.name.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::*;
    use crate::functest::tests::*;
    use sea_orm::*;
    use serial_test::serial;

    struct SettlementResolverFixture {
        env: Arc<Env>,
        login: uuid::Uuid,
        accessible_group_key: String,
        inaccessible_group_key: String,
        first_active_aor_id: i64,
        second_active_aor_id: i64,
    }

    async fn settlement_resolver_fixture() -> SettlementResolverFixture {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let zone = mk_sigint_zone(
            &txn,
            sigint_zone::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource = mk_datasource(
            &txn,
            datasource::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let organism = mk_organism(
            &txn,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &txn,
            login::ActiveModel {
                login: Set("settlement-resolver-user".to_string()),
                id: Set(uuid::Uuid::new_v4()),
                sigint_zone_id: Set(Some(zone.id)),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let accessible_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inaccessible_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for group in [&accessible_group, &inaccessible_group] {
            mk_datasource_group(
                &txn,
                datasource_group::ActiveModel {
                    datasource_id: Set(datasource.id),
                    group_master_key: Set(group.master_key.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        mk_sigint_zone_datasource(
            &txn,
            sigint_zone_datasource::ActiveModel {
                sigint_zone_id: Set(zone.id),
                datasource_id: Set(datasource.id),
                group_master_key: Set(accessible_group.master_key.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::sigint::zone::bl::update_signal_group_access_and_admins(
            vec![],
            vec![organism.id],
            vec![],
            true,
            &accessible_group.master_key,
            &txn,
        )
        .await
        .unwrap();

        let deleted_aor = mk_aor(
            &txn,
            area_of_responsibility::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let first_active_aor = mk_aor(
            &txn,
            area_of_responsibility::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_active_aor = mk_aor(
            &txn,
            area_of_responsibility::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut deleted_aor_active = deleted_aor.into_active_model();
        let deleted_aor_id = deleted_aor_active.id.clone().unwrap();
        deleted_aor_active.deleted = Set(true);
        deleted_aor_active.update(&txn).await.unwrap();
        for aor_id in
            [deleted_aor_id, first_active_aor.id, second_active_aor.id]
        {
            mk_signal_group_aor(
                &txn,
                signal_group_aor::ActiveModel {
                    master_key: Set(accessible_group.master_key.clone()),
                    aor_id: Set(aor_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        mk_signal_group_aor(
            &txn,
            signal_group_aor::ActiveModel {
                master_key: Set(accessible_group.master_key.clone()),
                aor_id: Set(first_active_aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        SettlementResolverFixture {
            env,
            login: login.id,
            accessible_group_key: accessible_group.master_key,
            inaccessible_group_key: inaccessible_group.master_key,
            first_active_aor_id: first_active_aor.id,
            second_active_aor_id: second_active_aor.id,
        }
    }

    fn settlement_request(
        signal_group_master_key: Option<String>,
        aor_id: Option<i64>,
    ) -> FindSettlementReq {
        FindSettlementReq {
            query: "мер".to_string(),
            region: None,
            related_coordinates: None,
            aor_id,
            signal_group_master_key,
        }
    }

    #[serial]
    #[tokio::test]
    async fn settlement_resolver_matches_group_aor_selection() {
        let fixture = settlement_resolver_fixture().await;
        let req = settlement_request(
            Some(fixture.accessible_group_key.clone()),
            None,
        );

        let resolved = resolve_settlement_request_aor_scope(
            &fixture.env.dbx,
            &fixture.login,
            &req,
        )
        .await
        .unwrap();
        let parser_aor = crate::messenger::group::resolve_group_aor_id(
            &fixture.env.dbx,
            &fixture.accessible_group_key,
        )
        .await
        .unwrap();
        let parser_aors = crate::messenger::group::resolve_group_aor_ids(
            &fixture.env.dbx,
            &fixture.accessible_group_key,
        )
        .await
        .unwrap();

        assert_eq!(
            resolved,
            Some(vec![
                fixture.first_active_aor_id,
                fixture.second_active_aor_id,
            ])
        );
        assert_eq!(parser_aor, Some(fixture.first_active_aor_id));
        assert_eq!(
            parser_aors,
            vec![fixture.first_active_aor_id, fixture.second_active_aor_id]
        );
    }

    #[serial]
    #[tokio::test]
    async fn settlement_resolver_uses_default_for_no_active_aor() {
        let fixture = settlement_resolver_fixture().await;
        signal_group_aor::Entity::delete_many()
            .filter(
                signal_group_aor::Column::MasterKey
                    .eq(fixture.accessible_group_key.clone()),
            )
            .exec(&fixture.env.dbx)
            .await
            .unwrap();
        let req = settlement_request(Some(fixture.accessible_group_key), None);

        assert_eq!(
            resolve_settlement_request_aor_scope(
                &fixture.env.dbx,
                &fixture.login,
                &req
            )
            .await
            .unwrap(),
            None
        );
    }

    #[serial]
    #[tokio::test]
    async fn settlement_resolver_preserves_explicit_and_blank_legacy_selectors()
    {
        let fixture = settlement_resolver_fixture().await;
        for (group_key, aor_id, expected) in [
            (None, Some(42), Some(vec![42])),
            (None, None, None),
            (Some("   ".to_string()), Some(42), Some(vec![42])),
            (Some("   ".to_string()), None, None),
        ] {
            let req = settlement_request(group_key, aor_id);
            assert_eq!(
                resolve_settlement_request_aor_scope(
                    &fixture.env.dbx,
                    &fixture.login,
                    &req,
                )
                .await
                .unwrap(),
                expected
            );
        }
    }

    #[serial]
    #[tokio::test]
    async fn settlement_resolver_rejects_conflicting_selectors() {
        let fixture = settlement_resolver_fixture().await;
        let req =
            settlement_request(Some(fixture.accessible_group_key), Some(42));

        let error = resolve_settlement_request_aor_scope(
            &fixture.env.dbx,
            &fixture.login,
            &req,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[serial]
    #[tokio::test]
    async fn settlement_resolver_forbids_inaccessible_group() {
        let fixture = settlement_resolver_fixture().await;
        let req =
            settlement_request(Some(fixture.inaccessible_group_key), None);

        let error = resolve_settlement_request_aor_scope(
            &fixture.env.dbx,
            &fixture.login,
            &req,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::Forbidden(_)));
    }

    #[test]
    fn filters_settlements_by_case_insensitive_prefix() {
        let mut settlements_by_name = BTreeMap::new();
        for name in ["ЛИМАН ПЕРШИЙ", "МЕРЕФА", "ЛИМАН ДРУГИЙ"]
        {
            settlements_by_name.insert(
                name.to_string(),
                vec![SettlementDetails {
                    name: name.to_string(),
                    ..Default::default()
                }],
            );
        }
        let settlements_data = Arc::new((
            vec![],
            vec![],
            Trie::new(),
            BTreeMap::new(),
            settlements_by_name,
        ));
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlements_data,
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix(
            settlements,
            " лиман ".to_string(),
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            locations
                .into_iter()
                .map(|location| location.name)
                .collect_vec(),
            vec!["ЛИМАН ДРУГИЙ", "ЛИМАН ПЕРШИЙ"]
        );
    }

    #[test]
    fn preserves_duplicate_settlement_names_when_filtering_by_region() {
        let settlements_by_name = BTreeMap::from([(
            "МИРНЕ".to_string(),
            vec![
                SettlementDetails {
                    name: "МИРНЕ".to_string(),
                    region: "ДОНЕЦЬКА".to_string(),
                    id: Some(1),
                    ..Default::default()
                },
                SettlementDetails {
                    name: "МИРНЕ".to_string(),
                    region: "ЗАПОРІЗЬКА".to_string(),
                    id: Some(2),
                    ..Default::default()
                },
            ],
        )]);
        let settlements_data = Arc::new((
            vec![],
            vec![],
            Trie::new(),
            BTreeMap::new(),
            settlements_by_name,
        ));
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlements_data,
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix(
            settlements,
            "мир".to_string(),
            Some("ДОНЕЦЬКА".to_string()),
            None,
            None,
        )
        .unwrap();

        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].id, Some(1));
    }

    #[test]
    fn excludes_parser_region_aliases_from_prefix_results() {
        let mut parser_trie = Trie::new();
        parser_trie.insert(
            "ХАРКІВСЬКА ОБЛ",
            SettlementDetails {
                name: "ХАРКІВСЬКА ОБЛ".to_string(),
                id: None,
                ..Default::default()
            },
        );
        let settlements_data = Arc::new((
            vec![],
            vec![],
            parser_trie,
            BTreeMap::new(),
            BTreeMap::new(),
        ));
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlements_data,
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix(
            settlements,
            "харківс".to_string(),
            None,
            None,
            None,
        )
        .unwrap();

        assert!(locations.is_empty());
    }

    #[test]
    fn preserves_coordinate_ranked_prefix_order() {
        let settlements_by_name = BTreeMap::from([
            (
                "ЛИМАН АЛЬФА".to_string(),
                vec![SettlementDetails {
                    name: "ЛИМАН АЛЬФА".to_string(),
                    coords: Some((2.0, 2.0)),
                    ..Default::default()
                }],
            ),
            (
                "ЛИМАН ЯНТАР".to_string(),
                vec![SettlementDetails {
                    name: "ЛИМАН ЯНТАР".to_string(),
                    coords: Some((1.0, 1.0)),
                    ..Default::default()
                }],
            ),
        ]);
        let settlements_data = Arc::new((
            vec![],
            vec![],
            Trie::new(),
            BTreeMap::new(),
            settlements_by_name,
        ));
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlements_data,
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix(
            settlements,
            "лиман".to_string(),
            None,
            Some((0.0, 0.0)),
            None,
        )
        .unwrap();

        assert_eq!(
            locations
                .into_iter()
                .map(|location| location.name)
                .collect_vec(),
            vec!["ЛИМАН ЯНТАР", "ЛИМАН АЛЬФА"]
        );
    }

    fn settlement_source(
        settlements: Vec<SettlementDetails>,
    ) -> Arc<SettlementsData> {
        let mut by_id = BTreeMap::new();
        let mut by_name: BTreeMap<String, Vec<SettlementDetails>> =
            BTreeMap::new();
        for settlement in settlements {
            by_id.insert(settlement.id.unwrap(), settlement.clone());
            by_name
                .entry(settlement.name.clone())
                .or_default()
                .push(settlement);
        }
        Arc::new((vec![], vec![], Trie::new(), by_id, by_name))
    }

    #[test]
    fn searches_all_aor_sources_in_global_order_and_deduplicates_exact_rows() {
        let duplicate = SettlementDetails {
            id: Some(1),
            name: "ЛІС".to_string(),
            language: Language::Ua,
            ..Default::default()
        };
        let transliterated = SettlementDetails {
            id: Some(1),
            name: "ЛІС".to_string(),
            language: Language::UaTranslit,
            ..Default::default()
        };
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlement_source(vec![]),
            aor_id_to_settlements_data: HashMap::from([
                (
                    10,
                    settlement_source(vec![duplicate.clone(), transliterated]),
                ),
                (
                    20,
                    settlement_source(vec![
                        duplicate,
                        SettlementDetails {
                            id: Some(2),
                            name: "ЛЯВА".to_string(),
                            language: Language::Ua,
                            ..Default::default()
                        },
                        SettlementDetails {
                            id: Some(3),
                            name: "ЛІС".to_string(),
                            region: "Черкаська область".to_string(),
                            language: Language::Ua,
                            ..Default::default()
                        },
                    ]),
                ),
            ]),
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix_scope(
            settlements,
            "л".to_string(),
            None,
            None,
            Some(&[20, 10]),
        )
        .unwrap();

        assert_eq!(
            locations
                .iter()
                .map(|location| (
                    location.id,
                    location.name.clone(),
                    location.region.clone(),
                    location.language.clone()
                ))
                .collect_vec(),
            vec![
                (Some(1), "ЛІС".to_string(), "".to_string(), Language::Ua),
                (
                    Some(1),
                    "ЛІС".to_string(),
                    "".to_string(),
                    Language::UaTranslit,
                ),
                (
                    Some(3),
                    "ЛІС".to_string(),
                    "Черкаська область".to_string(),
                    Language::Ua,
                ),
                (Some(2), "ЛЯВА".to_string(), "".to_string(), Language::Ua),
            ]
        );
    }

    #[test]
    fn ranks_the_merged_aor_sources_once() {
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlement_source(vec![]),
            aor_id_to_settlements_data: HashMap::from([
                (
                    10,
                    settlement_source(vec![SettlementDetails {
                        id: Some(10),
                        name: "ЛІС".to_string(),
                        coords: Some((2.0, 2.0)),
                        ..Default::default()
                    }]),
                ),
                (
                    20,
                    settlement_source(vec![SettlementDetails {
                        id: Some(20),
                        name: "ЛЯВА".to_string(),
                        coords: Some((1.0, 1.0)),
                        ..Default::default()
                    }]),
                ),
            ]),
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix_scope(
            settlements,
            "л".to_string(),
            None,
            Some((0.0, 0.0)),
            Some(&[10, 20]),
        )
        .unwrap();

        assert_eq!(locations[0].name, "ЛЯВА");
        assert_eq!(locations[1].name, "ЛІС");
    }

    #[test]
    fn adds_default_source_once_for_aors_without_configuration() {
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlement_source(vec![
                SettlementDetails {
                    id: Some(1),
                    name: "ДЕФОЛТ".to_string(),
                    ..Default::default()
                },
            ]),
            aor_id_to_settlements_data: HashMap::from([(
                10,
                settlement_source(vec![SettlementDetails {
                    id: Some(10),
                    name: "ДОДАТКОВИЙ".to_string(),
                    ..Default::default()
                }]),
            )]),
            ..Default::default()
        }));

        let locations = find_settlements_by_name_scope(
            settlements,
            "Д".to_string(),
            None,
            None,
            Some(&[10, 20, 30]),
        )
        .unwrap();

        assert_eq!(
            locations
                .iter()
                .map(|location| location.name.as_str())
                .collect_vec(),
            vec!["ДЕФОЛТ", "ДОДАТКОВИЙ"]
        );
    }

    #[test]
    fn returns_all_prefix_matches() {
        let settlements_by_name = (0..101)
            .map(|index| {
                let name = format!("ЛОКАЦІЯ {index:03}");
                (
                    name.clone(),
                    vec![SettlementDetails {
                        name,
                        ..Default::default()
                    }],
                )
            })
            .collect();
        let settlements_data = Arc::new((
            vec![],
            vec![],
            Trie::new(),
            BTreeMap::new(),
            settlements_by_name,
        ));
        let settlements = Arc::new(RwLock::new(SettlementsDataConfig {
            default_settlements_data: settlements_data,
            ..Default::default()
        }));

        let locations = find_settlements_by_prefix(
            settlements,
            "локація".to_string(),
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(locations.len(), 101);
    }

    #[test]
    fn standard_location_context_terms_include_direction_abbreviations() {
        let result = remove_standard_location_context_terms(
            "БОРІВСЬКА АНДРІЇВКА - зх. МЯСОЖАРІВКА - пд.-сх. ЧАСІВ ЯР",
        );

        assert_eq!(result, "БОРІВСЬКА АНДРІЇВКА - МЯСОЖАРІВКА - ЧАСІВ ЯР");
    }

    #[test]
    fn lists_all_regional_settlements_configs() {
        let configs = find_available_settlements_configs(Mode::Test).unwrap();

        assert!(configs
            .contains(&"settlements_json/kharkivska_oblast.json".to_string()));
        assert!(configs
            .contains(&"settlements_json/kurska_oblast_rf.json".to_string()));
        assert!(configs.windows(2).all(|pair| pair[0] < pair[1]));
    }

    fn parse_location_with_aor_id(
        settlements: Arc<RwLock<SettlementsDataConfig>>,
        location: String,
    ) -> anyhow::Result<Vec<SettlementDetails>> {
        parse_location_with_aor(settlements, location, None)
    }

    fn test_settlements_array(data: Vec<SettlementDetails>) -> Vec<String> {
        let mut result = vec![];
        for row in data {
            result.push(row.name.clone());
            assert!(row.coords.is_some());
            assert!(row.id.is_some());
        }
        result
    }

    #[test]
    pub fn test1() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("\"location\""),
        )
        .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    pub fn test2() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("СТЕПНЕ - МИРНЕ-НЕСТЕРЯНКА"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["МИРНЕ", "НЕСТЕРЯНКА", "СТЕПНЕ"], result);
    }

    #[test]
    pub fn test3() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("рн Миколаївка"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["МИКОЛАЇВКА",], result);
    }

    #[test]
    pub fn test4() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("УКРАЇНСЬКЕ-БАГАТЕ"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["БАГАТЕ", "УКРАЇНСЬКЕ",], result);
    }

    #[test]
    pub fn test5() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result =
            parse_location_with_aor_id(settlements, String::from("ПОРТЛЕНД"))
                .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    pub fn test6() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("РЕМІВКА-СТЕПОВЕ-ПРИЮТНЕ"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ПРИЮТНЕ", "РЕМІВКА", "СТЕПОВЕ",], result);
    }

    #[test]
    pub fn test8() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result =
            parse_location_with_aor_id(settlements, String::from("СТЕПОВЕ"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["СТЕПОВЕ",], result);
    }

    #[test]
    pub fn test9() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Завітне Бажання, Старомлинівка"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СТАРОМЛИНІВКА",], result);
    }

    #[test]
    pub fn test10() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("3123132 vsd сх. Соледар, Донецька обл"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["СОЛЕДАР",], result);
    }

    #[test]
    pub fn test11() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        println!(
            "> config.settlement_paths() = {:?}",
            config.settlement_paths()
        );
        let man = std::env!("CARGO_MANIFEST_DIR");
        println!("> man: {man}");
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("сх. Соледар, Донецька обл."),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["СОЛЕДАР",], result);
    }

    #[test]
    pub fn test11_zx_direction_abbreviation() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("зх. Соледар, Донецька обл."),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["СОЛЕДАР",], result);
    }

    #[test]
    pub fn test12() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("ОЧЕРЕТУВАТЕ-СОЛОДКА БАЛКА"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ОЧЕРЕТУВАТЕ", "СОЛОДКА БАЛКА",], result);
    }

    #[test]
    pub fn test13() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Півд. Мала Токмачка"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["МАЛА ТОКМАЧКА",], result);
    }

    #[test]
    pub fn test14() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("ЛУГОВЕ - ЖЕРЕБ"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЛУГОВЕ",], result);
    }

    #[test]
    pub fn test15() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result =
            parse_location_with_aor_id(settlements, String::from("Робоботине"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["РОБОТИНЕ",], result);
    }

    #[test]
    pub fn test16() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Соледар, Донцька обл., Завітне Бажання"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test17() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Соледар, Донецкая обл., Завітне Божання"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test18() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Завітне Божання, Соледар, Донецьк. обл."),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test19() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Соледар, Донецька обл., Зивітне Божання"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test20() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("Зивітне Божання, Qоледар, Донецька обл."),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test21() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from(
                "Dmre (йм. 5 омбр 4 А) (йм. р-н Новоселівка-Сміле-Гоголівка)",
            ),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ГОГОЛІВКА", "НОВОСЕЛІВКА", "СМІЛЕ"], result);
    }

    #[test]
    pub fn test22() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("р-н Бабиного"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["БАБИНЕ",], result);
    }

    #[test]
    pub fn test23() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(settlements, String::from(r#"УКХ р\м НВ підрозділу 435.25 йм. західніше Роботиного, та Вербове-Романівське"#)).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВЕРБОВЕ", "РОБОТИНЕ", "РОМАНІВСЬКЕ"], result);
    }

    #[test]
    pub fn test24() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("ОГІРЦЕВЕ-ГАТИЩЕ-ВОВЧАНСЬК"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВОВЧАНСЬК", "ГАТИЩЕ", "ОГІРЦЕВЕ"], result);
    }

    #[test]
    pub fn test_pidar1() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(settlements, String::from(r#"УКХ Центр ( гсабатр гсадн 30 мсп 72 мсд 44 АК ЛВО ров (р-н Щебекіно))"#)).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ШЕБЕКИНО"], result);
    }

    #[test]
    pub fn test_pidar2() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(settlements, String::from(
            r#"УКХ р/м НВ арт. підрозділу ( Пеленг Яснізорі- Устинка) Analog"#,
        ))
            .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["УСТИНКА", "ЯСНІ ЗОРІ"], result);
    }

    #[test]
    pub fn test_pidar3() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(settlements, String::from(
            r#"  УКХ р/м артилерійський підрозділ йм. 9 мсп (р-н йм. УСТІНКА) (05.07.2025)"#,
        ))
            .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["УСТІНКА"], result);
    }

    #[test]
    pub fn test_pidar4() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(settlements, String::from(
            r#"  УКХ р/м артилерійський підрозділ йм. 9 мсп (р-н йм. н.п. УСТІНКА) (05.07.2025)"#,
        ))
            .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["УСТІНКА"], result);
    }

    #[test]
    pub fn test_pidar5() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from(r#"    УКХ р/м ім. ТГр 45 абр ВП"#),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(result, Vec::<String>::new());
    }

    #[test]
    pub fn test_failure() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result =
            parse_location_with_aor_id(settlements, String::from("ФРАНКА"))
                .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    pub fn test_regexp1() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("р-н Водяного"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВОДЯНЕ",], result);
    }

    #[test]
    pub fn test_regexp2() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("рай. Кремінної"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["КРЕМІННА",], result);
    }

    #[test]
    pub fn test_regexp3() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("район Вугледара"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВУГЛЕДАР",], result);
    }

    #[test]
    pub fn test_regexp4() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("укх   йм район Пісків"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ПІСКИ",], result);
    }

    #[test]
    pub fn test_regexp5() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("біля Бабиного"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["БАБИНЕ",], result);
    }

    #[test]
    pub fn test_regexp6() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("УКХ р/м Не встановлена мережа (ЦфП_101)"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(Vec::<String>::new(), result);
    }

    #[test]
    pub fn test_regexp7() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let result = parse_location_with_aor_id(
            settlements,
            String::from("13 зсб 252 мсп (урочище Новоєгорівка - Долгоє)"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ДОЛГОЄ", "НОВОЄГОРІВКА"], result);
    }

    #[test]
    pub fn test_parse_with_different_aor_configs() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));

        let alpha = "КВАДРОЗЕБРААЛЬФА".to_string();
        let beta = "МЕТЕОРБЕТАОМЕГА".to_string();

        {
            let mut settlements_lock = settlements.write().unwrap();

            let mut settlements_data_alpha = load_from_file(
                settlements_lock.default_settlements_files.clone(),
                Mode::Test,
            )
            .unwrap();
            let alpha_details = SettlementDetails {
                id: Some(9_000_001),
                name: alpha.clone(),
                region: "ТЕСТОВА ОБЛАСТЬ".to_string(),
                language: Language::Ua,
                coords: Some((48.0, 33.0)),
            };
            settlements_data_alpha
                .3
                .insert(alpha_details.id.unwrap(), alpha_details.clone());
            settlements_data_alpha.2.insert(&alpha, alpha_details);

            let mut settlements_data_beta = load_from_file(
                settlements_lock.default_settlements_files.clone(),
                Mode::Test,
            )
            .unwrap();
            let beta_details = SettlementDetails {
                id: Some(9_000_002),
                name: beta.clone(),
                region: "ТЕСТОВА ОБЛАСТЬ".to_string(),
                language: Language::Ua,
                coords: Some((49.0, 34.0)),
            };
            settlements_data_beta
                .3
                .insert(beta_details.id.unwrap(), beta_details.clone());
            settlements_data_beta.2.insert(&beta, beta_details);

            settlements_lock
                .aor_id_to_settlements_data
                .insert(1, Arc::new(settlements_data_alpha));
            settlements_lock
                .aor_id_to_settlements_data
                .insert(2, Arc::new(settlements_data_beta));
        }

        let aor1 = parse_location_with_aor(
            settlements.clone(),
            alpha.clone(),
            Some(1),
        )
        .unwrap();
        let aor2 = parse_location_with_aor(settlements, alpha.clone(), Some(2))
            .unwrap();

        assert_eq!(test_settlements_array(aor1), vec![alpha]);
        assert!(aor2.is_empty());
    }
}

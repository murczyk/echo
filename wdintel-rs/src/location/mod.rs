use crate::entities::sigint_settlement;
use crate::location::trie::Trie;
use crate::location::types::{CreateSettlementReq, Language};
pub(crate) use crate::location::types::{
    FindSettlementReq, SettlementDetails, SettlementFileRow,
};
use crate::types::*;
use actix_web::web::Json;
use actix_web::{get, post, HttpRequest};
use itertools::Itertools;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;
use serde_json::json;
use std::fs;

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
);

#[post("/api/sigint/settlement/create")]
pub async fn create_settlement(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateSettlementReq>,
) -> Result<Json<i64>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;

    let res = sigint_settlement::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        lat: Set(req.lat),
        lon: Set(req.lng),
        alt_names: Set(json!(req.alternative_names)),
        updated_by: Set(Some(user_id.clone())),
        deleted: NotSet,
        updated_at: NotSet,
        created_at: NotSet,
        openstreetmap_id: Set(req.openstreetmap_id),
    }
    .insert(&env.dbx)
    .await?;

    Ok(Json(res.id))
}

#[post("/api/settlement/find")]
async fn find_locations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FindSettlementReq>,
) -> Result<Json<Vec<SettlementDetails>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let req = req.into_inner();
    let locations = find_locations_by_name(
        env.settlements.clone(),
        req.query,
        req.region,
        req.related_coordinates,
    )
    .context(h!())?;
    Ok(Json(locations))
}

#[get("/api/rer-importer/attachment/")]
async fn fetch_regions(
    user: actix_identity::Identity,
    _http_req: HttpRequest,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<String>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let region_names =
        get_region_names(env.settlements.clone()).context(h!())?;
    Ok(Json(region_names))
}

fn get_region_names(
    settlements: Arc<RwLock<SettlementsData>>,
) -> anyhow::Result<Vec<String>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .context(h!())?;
    let config: &SettlementsData = &settlements_lock;
    let (region_names, _, _, _) = config;
    Ok(region_names.clone())
}

fn find_locations_by_name(
    settlements: Arc<RwLock<SettlementsData>>,
    query: String,
    m_region: Option<String>,
    m_src_coords: Option<(f64, f64)>,
) -> anyhow::Result<Vec<SettlementDetails>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .context(h!())?;
    let config: &SettlementsData = &settlements_lock;
    let (_, _, _, settlements) = config;
    let mut matches: Vec<SettlementDetails> = Vec::new();
    for s in settlements.values() {
        if s.name.contains(&query.to_uppercase()) {
            matches.push(s.clone());
        }
    }
    if let Some(region) = m_region {
        if !matches.is_empty() {
            let mut filtered = vec![];
            for m in matches {
                if m.region.eq(&region) {
                    filtered.push(m);
                }
            }
            matches = filtered;
        }
    }
    if let Some((lat, lon)) = m_src_coords {
        if matches.len() > 1 {
            let mut new_result = vec![];
            let mut min_distance = -1.0;
            for m in matches {
                if let Some((lat_a, lon_a)) = m.coords {
                    let new_distance =
                        (lat - lat_a).abs() + (lon - lon_a).abs();
                    if min_distance < 0.0 || min_distance / new_distance > 5.0 {
                        min_distance = new_distance;
                        new_result = vec![m];
                    } else if new_distance < min_distance {
                        min_distance = new_distance;
                        new_result.insert(0, m);
                    } else {
                        new_result.push(m);
                    }
                }
            }
            matches = new_result;
        }
    }
    Ok(matches)
}

pub fn parse_location(
    settlements: Arc<RwLock<SettlementsData>>,
    location: String,
) -> anyhow::Result<Vec<SettlementDetails>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .context(h!())?;
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
        .replace("ОБ-ТЬ", "ОБЛАСТЬ");
    let location = JUNK_CHAR_RE.replace_all(&location, " ").to_string();
    let location = JUNK_WORD_RE.replace_all(&location, " ").to_string();
    let location = trim(location);
    let location = try_process_nearest_location(location);
    let words = location
        .split_whitespace()
        .map(|x| x.to_string())
        .collect_vec();
    let result =
        find_matching_settlements(words, &settlements_lock).context(h!())?;
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
    let (_region_names, regions, trie, _) = config;
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
            .context(h!())?;
    }
    let remainder = words.len() - i;
    if remainder == 1 {
        let new_data = cache.get(i).cloned().context(h!())?.to_owned().1.data;
        for (row, coords) in new_data {
            result.insert(row, coords);
        }
    } else {
        handle_two_words_group(regions, trie, &mut result, &mut cache, i)
            .context(h!())?;
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
    regions: &Vec<String>,
    trie: &Trie<SettlementDetails>,
    result: &mut BTreeMap<String, SettlementDetails>,
    cache: &mut Vec<(String, trie::Result<SettlementDetails>)>,
    i: usize,
) -> anyhow::Result<()> {
    let (word0, res0) = cache.get(i).context(h!())?;
    let (word1, res1) = cache.get(i + 1).context(h!())?;
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
    regions: &Vec<String>,
    trie: &Trie<SettlementDetails>,
    result: &mut BTreeMap<String, SettlementDetails>,
    cache: &mut Vec<(String, trie::Result<SettlementDetails>)>,
    i: usize,
) -> anyhow::Result<usize> {
    let (word0, res0) = cache.get(i).context(h!())?;
    let (word1, _) = cache.get(i + 1).context(h!())?;
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
    let mut string = string.replace("    ", " ").replace("   ", " ");
    while string.contains("  ") {
        string = string.replace("  ", " ");
    }
    String::from(string.trim())
}

pub fn load_from_file(
    settlements_paths: Vec<String>,
) -> anyhow::Result<SettlementsData> {
    let mut trie = Trie::<SettlementDetails>::new();
    let mut regions = vec![];

    let root_dir = if Path::new("/etc/echo").exists() {
        Path::new("/etc/echo")
    } else {
        Path::new(std::env!("CARGO_MANIFEST_DIR"))
    };
    let mut region_names = BTreeSet::new();

    let mut settlements = BTreeMap::new();

    for source in settlements_paths {
        // info!("[{}] loading source", &source);
        // let path = format!("{}/{}", dir, source.clone());
        let path = root_dir.join(source.clone());
        let text = match path.exists() {
            true => fs::read_to_string(path.clone()).context(h!())?,
            false => {
                warn!(
                    "[{}] cannot load source at {}, loading settlements.json",
                    &source,
                    path.display()
                );
                fs::read_to_string("/etc/echo/settlements.json")
                    .context(h!())?
            }
        };
        // trace!("[{}] loaded source successfully", &source);
        let data: BTreeMap<String, Vec<SettlementFileRow>> =
            serde_json::from_str(&text).context(h!())?;

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

    Ok((region_names, regions, trie, settlements))
}

fn match_settlement(
    query: &String,
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
        r#"ІМ\."#,
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("\"location\"")).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    pub fn test2() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("рн Миколаївка")).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["МИКОЛАЇВКА",], result);
    }

    #[test]
    pub fn test4() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("УКРАЇНСЬКЕ-БАГАТЕ"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["БАГАТЕ", "УКРАЇНСЬКЕ",], result);
    }

    #[test]
    pub fn test5() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("ПОРТЛЕНД")).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    pub fn test6() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("СТЕПОВЕ")).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["СТЕПОВЕ",], result);
    }

    #[test]
    pub fn test9() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("сх. Соледар, Донецька обл."),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["СОЛЕДАР",], result);
    }

    #[test]
    pub fn test12() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("Півд. Мала Токмачка"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["МАЛА ТОКМАЧКА",], result);
    }

    #[test]
    pub fn test14() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("ЛУГОВЕ - ЖЕРЕБ"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ЛУГОВЕ",], result);
    }

    #[test]
    pub fn test15() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("Робоботине")).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["РОБОТИНЕ",], result);
    }

    #[test]
    pub fn test16() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("р-н Бабиного")).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["БАБИНЕ",], result);
    }

    #[test]
    pub fn test23() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(settlements, String::from(r#"УКХ р\м НВ підрозділу 435.25 йм. західніше Роботиного, та Вербове-Романівське"#)).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВЕРБОВЕ", "РОБОТИНЕ", "РОМАНІВСЬКЕ"], result);
    }

    #[test]
    pub fn test24() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(settlements, String::from(r#"УКХ Центр ( гсабатр гсадн 30 мсп 72 мсд 44 АК ЛВО ров (р-н Щебекіно))"#)).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ШЕБЕКИНО"], result);
    }

    #[test]
    pub fn test_pidar2() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(settlements, String::from(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("ФРАНКА")).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    pub fn test_regexp1() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("р-н Водяного")).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВОДЯНЕ",], result);
    }

    #[test]
    pub fn test_regexp2() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("рай. Кремінної"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["КРЕМІННА",], result);
    }

    #[test]
    pub fn test_regexp3() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("район Вугледара"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ВУГЛЕДАР",], result);
    }

    #[test]
    pub fn test_regexp4() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("укх   йм район Пісків"))
                .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ПІСКИ",], result);
    }

    #[test]
    pub fn test_regexp5() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("біля Бабиного")).unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["БАБИНЕ",], result);
    }

    #[test]
    pub fn test_regexp6() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
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
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("13 зсб 252 мсп (урочище Новоєгорівка - Долгоє)"),
        )
        .unwrap();
        let result = test_settlements_array(result);
        assert_eq!(vec!["ДОЛГОЄ", "НОВОЄГОРІВКА"], result);
    }
}

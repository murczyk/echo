use crate::location::trie::Trie;
use crate::types::*;
use crate::utils::m_cap_s;
use itertools::Itertools;
use lazy_static::lazy_static;
use regex::Regex;
use std::fs;

pub(crate) mod peleng;
pub mod trie;
pub mod utils;
pub mod worker;

pub fn parse_location(
    settlements: Arc<RwLock<(Vec<String>, crate::location::trie::Trie)>>,
    location: String,
) -> anyhow::Result<Vec<String>> {
    let settlements_lock = settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .context(h!())?;
    lazy_static! {
        static ref JUNK_CHAR_RE: Regex =
            Regex::new(r#"[ \(\)\.\-\,\/\:";!\?\*\%\$@0-9]"#).unwrap();
        static ref JUNK_WORD_RE: Regex = Regex::new(
            &*r#"\W($s1)"#.replace("$s1", &*collect_blacklist().join("|"))
        )
        .unwrap();
        static ref NEAR_SETTLEMENT_RE: Regex =
            Regex::new(r#"(РАЙОН|ВІД|БІЛЯ) (?<name>\w+)"#).unwrap();
    }
    let location = location
        .to_uppercase()
        .replace("Ы", "І")
        .replace("ОБЛ.", "ОБЛАСТЬ")
        .replace("РАЙ.", "РАЙОН")
        .replace("Р-Н. ", "РАЙОН ")
        .replace("Р-Н ", "РАЙОН ")
        .replace("ОБ-ТЬ", "ОБЛАСТЬ");
    let location = JUNK_WORD_RE.replace_all(&*location, " ").to_string();
    let location =
        update_if_match(location, &NEAR_SETTLEMENT_RE).context(h!())?;
    let location = JUNK_CHAR_RE.replace_all(&*location, " ").to_string();
    let location = JUNK_WORD_RE.replace_all(&*location, " ").to_string();
    let location = trim(location);
    let location = try_append_trimmed_location_name(location);
    let words = location
        .split_whitespace()
        .into_iter()
        .map(|s| trim_tail(String::from(s)))
        .collect_vec();
    let result =
        find_matching_settlements(words, &settlements_lock).context(h!())?;
    Ok(result)
}

fn try_append_trimmed_location_name(location: String) -> String {
    if location.trim().contains(" ") {
        return location;
    }
    let location_fixed = trim_tail(location.clone());
    if !location_fixed.eq(&location) {
        return format!("{} {}", location_fixed, location);
    }
    location
}

fn update_if_match(location: String, regex: &Regex) -> anyhow::Result<String> {
    if let Some(cap) = regex.captures(&*location.clone()) {
        if let Some(name) = m_cap_s(&cap, "name") {
            let name = trim_tail(name);
            let capture = cap
                .iter()
                .next()
                .flatten()
                .context(h!())?
                .as_str()
                .to_string();
            let location = location.replace(&*capture, &*name);
            return update_if_match(location, regex);
        }
    }
    Ok(location)
}

fn trim_tail(name: String) -> String {
    let mut name_vec = name.chars().collect_vec();
    if name.ends_with("ОГО") {
        name_vec.pop();
        name_vec.pop();
        name_vec.pop();
    } else if name.ends_with("ОЇ") || name.ends_with("ІВ") {
        name_vec.pop();
        name_vec.pop();
    }
    let name: String = name_vec.iter().collect();
    name
}

fn find_matching_settlements(
    words: Vec<String>,
    config: &(Vec<String>, Trie),
) -> anyhow::Result<Vec<String>> {
    let (regions, trie) = config;
    if words.is_empty() {
        return Ok(vec![]);
    }
    let mut result = BTreeSet::new();
    let mut cache = vec![];
    for word in words.clone() {
        let res = match_settlement(&word, trie);
        cache.push((word, res));
    }
    let mut i = 0;
    while i + 2 < words.len() {
        i = handle_three_words_group(
            &regions,
            trie,
            &mut result,
            &mut cache,
            i,
        )
        .context(h!())?;
    }
    let remainder = words.len() - i;
    if remainder == 1 {
        let new_data = cache.get(i).context(h!())?.to_owned().1.data;
        for row in new_data {
            result.insert(row);
        }
    } else {
        handle_two_words_group(&regions, trie, &mut result, &mut cache, i)
            .context(h!())?;
    }
    let mut result = result.into_iter().collect_vec();
    result.sort();
    Ok(result)
}

fn handle_two_words_group(
    regions: &Vec<String>,
    trie: &Trie,
    result: &mut BTreeSet<String>,
    cache: &mut Vec<(String, trie::Result)>,
    i: usize,
) -> anyhow::Result<()> {
    let (word0, res0) = cache.get(i).context(h!())?;
    let (word1, res1) = cache.get(i + 1).context(h!())?;
    let query = &format!("{} {}", word0, word1);
    let joined_res = match_settlement(query, trie);
    let is_region = joined_res.data.iter().any(|row| regions.contains(row));
    if is_region {
        return Ok(());
    }
    let data = if joined_res.data.is_empty() {
        [res0.data.as_slice(), res1.data.as_slice()].concat()
    } else {
        joined_res.data
    };
    for rec in data {
        result.insert(rec);
    }
    Ok(())
}

fn handle_three_words_group(
    regions: &Vec<String>,
    trie: &Trie,
    result: &mut BTreeSet<String>,
    cache: &mut Vec<(String, trie::Result)>,
    i: usize,
) -> anyhow::Result<usize> {
    let (word0, res0) = cache.get(i).context(h!())?;
    let (word1, _) = cache.get(i + 1).context(h!())?;
    let mut i = i + 1;
    let joined0 = format!("{} {}", word0, word1);
    let joined_res = match_settlement(&joined0, trie);
    let data = if !joined_res.data.is_empty() {
        i += 1;
        let is_region = joined_res.data.iter().any(|row| regions.contains(row));
        if is_region {
            vec![]
        } else {
            joined_res.data
        }
    } else {
        res0.data.clone()
    };
    for rec in data {
        result.insert(rec);
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
) -> anyhow::Result<(Vec<String>, Trie)> {
    let mut trie = Trie::new();
    let mut regions = vec![];

    let root_dir = if Path::new("/etc/echo").exists() {
        Path::new("/etc/echo")
    } else {
        Path::new(std::env!("CARGO_MANIFEST_DIR"))
    };

    for source in settlements_paths {
        info!("[{}] loading source", &source);
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
        info!("[{}] loaded source successfully", &source);
        let data: BTreeMap<String, Vec<String>> =
            serde_json::from_str(&*text).context(h!())?;

        for (region, rows) in data {
            for row in rows {
                trie.insert(&*row.to_uppercase());
            }
            let region = region.to_uppercase();
            let region_trimmed = region.clone().replace("ОБЛАСТЬ", "ОБЛ");
            regions.push(region.clone());
            regions.push(region_trimmed.clone());
            trie.insert(&*region);
            trie.insert(&*region_trimmed);
        }
    }

    Ok((regions, trie))
}

fn match_settlement(query: &String, trie: &Trie) -> trie::Result {
    let len = query.chars().count();
    let distance = if len > 3 {
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
        "ЗАХІДНІШЕ",
        "СХІДНІШЕ",
        "ПІВНІЧНІШЕ",
        "ПІВДЕННІШЕ",
        "ПІВДЕНІШЕ",
        "ТАНКОВОГО",
        "ПІХОТНОГО",
        "СТРІЛЕЦЬКОГО",
        r#"ІМ\."#,
        "МІЖ",
        "ОКОЛИЦІ",
        r#"ОКОЛ\."#,
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
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub fn test1() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
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
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("СТЕПНЕ - МИРНЕ-НЕСТЕРЯНКА"),
        )
        .unwrap();
        assert_eq!(vec!["МИРНЕ", "НЕСТЕРЯНКА", "СТЕПНЕ"], result);
    }

    #[test]
    pub fn test3() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("рн Миколаївка")).unwrap();
        assert_eq!(vec!["МИКОЛАЇВКА",], result);
    }

    #[test]
    pub fn test4() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("УКРАЇНСЬКЕ-БАГАТЕ"))
                .unwrap();
        assert_eq!(vec!["БАГАТЕ", "УКРАЇНСЬКЕ",], result);
    }

    #[test]
    pub fn test5() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
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
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("РЕМІВКА-СТЕПОВЕ-ПРИЮТНЕ"),
        )
        .unwrap();
        assert_eq!(vec!["ПРИЮТНЕ", "РЕМІВКА", "СТЕПОВЕ",], result);
    }

    #[test]
    pub fn test8() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("СТЕПОВЕ")).unwrap();
        assert_eq!(vec!["СТЕПОВЕ",], result);
    }

    #[test]
    pub fn test9() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("Завітне Бажання, Старомлинівка"),
        )
        .unwrap();
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СТАРОМЛИНІВКА",], result);
    }

    #[test]
    pub fn test10() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("3123132 vsd сх. Соледар, Донецька обл"),
        )
        .unwrap();
        assert_eq!(vec!["СОЛЕДАР",], result);
    }

    #[test]
    pub fn test11() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        println!(
            "> config.settlement_paths() = {:?}",
            config.settlement_paths()
        );
        let man = std::env!("CARGO_MANIFEST_DIR");
        println!("> man: {}", man);
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("сх. Соледар, Донецька обл."),
        )
        .unwrap();
        assert_eq!(vec!["СОЛЕДАР",], result);
    }

    #[test]
    pub fn test12() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("ОЧЕРЕТУВАТЕ-СОЛОДКА БАЛКА"),
        )
        .unwrap();
        assert_eq!(vec!["ОЧЕРЕТУВАТЕ", "СОЛОДКА БАЛКА",], result);
    }

    #[test]
    pub fn test13() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("Півд. Мала Токмачка"))
                .unwrap();
        assert_eq!(vec!["МАЛА ТОКМАЧКА",], result);
    }

    #[test]
    pub fn test14() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("ЛУГОВЕ - ЖЕРЕБ"))
                .unwrap();
        assert_eq!(vec!["ЛУГОВЕ",], result);
    }

    #[test]
    pub fn test15() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("Робоботине")).unwrap();
        assert_eq!(vec!["РОБОТИНЕ",], result);
    }

    #[test]
    pub fn test16() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("Соледар, Донцька обл., Завітне Бажання"),
        )
        .unwrap();
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test17() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("Соледар, Донецкая обл., Завітне Божання"),
        )
        .unwrap();
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test18() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("Завітне Божання, Соледар, Донецьк. обл."),
        )
        .unwrap();
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test19() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("Соледар, Донецька обл., Зивітне Божання"),
        )
        .unwrap();
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test20() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("Зивітне Божання, Qоледар, Донецька обл."),
        )
        .unwrap();
        assert_eq!(vec!["ЗАВІТНЕ БАЖАННЯ", "СОЛЕДАР"], result);
    }

    #[test]
    pub fn test21() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
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
        assert_eq!(vec!["ГОГОЛІВКА", "НОВОСЕЛІВКА", "СМІЛЕ"], result);
    }

    #[test]
    pub fn test22() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("Бабиного")).unwrap();
        assert_eq!(vec!["БАБИНЕ",], result);
    }

    #[test]
    pub fn test23() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(settlements, String::from(r#"УКХ р\м НВ підрозділу 435.25 йм. західніше Роботиного, та Вербове-Романівське"#)).unwrap();
        assert_eq!(vec!["ВЕРБОВЕ", "РОБОТИНЕ", "РОМАНІВСЬКЕ"], result);
    }

    #[test]
    pub fn test_pidar1() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(settlements, String::from(r#"УКХ Центр ( гсабатр гсадн 30 мсп 72 мсд 44 АК ЛВО ров (р-н Щебекіно))"#)).unwrap();
        assert_eq!(vec!["ШЕБЕКИНО"], result);
    }

    #[test]
    pub fn test_pidar2() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(settlements, String::from(
            r#"УКХ р/м НВ арт. підрозділу ( Пеленг Яснізорі- Устинка) Analog"#,
        ))
        .unwrap();
        assert_eq!(vec!["УСТИНКА", "ЯСНІ ЗОРІ"], result);
    }

    #[test]
    pub fn test_pidar3() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from(r#"    УКХ р/м ім. ТГр 45 абр ВП"#),
        )
        .unwrap();
        assert_eq!(result, Vec::<String>::new());
    }

    #[test]
    pub fn test_failure() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
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
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("р-н Водяного")).unwrap();
        assert_eq!(vec!["ВОДЯНЕ",], result);
    }

    #[test]
    pub fn test_regexp2() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("рай. Кремінної"))
                .unwrap();
        assert_eq!(vec!["КРЕМІННА",], result);
    }

    #[test]
    pub fn test_regexp3() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("район Вугледара"))
                .unwrap();
        assert_eq!(vec!["ВУГЛЕДАР",], result);
    }

    #[test]
    pub fn test_regexp4() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("укх   йм район Пісків"))
                .unwrap();
        assert_eq!(vec!["ПІСКИ",], result);
    }

    #[test]
    pub fn test_regexp5() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result =
            parse_location(settlements, String::from("біля Бабиного")).unwrap();
        assert_eq!(vec!["БАБИНЕ",], result);
    }

    #[test]
    pub fn test_regexp6() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("УКХ р/м Не встановлена мережа (ЦфП_101)"),
        )
        .unwrap();
        assert_eq!(Vec::<String>::new(), result);
    }

    #[test]
    pub fn test_regexp7() {
        let config = crate::config::read_config(Mode::Debug).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_from_file(config.settlement_paths().unwrap())
                .unwrap(),
        ));
        let result = parse_location(
            settlements,
            String::from("13 зсб 252 мсп (урочище Новоєгорівка - Долгоє)"),
        )
        .unwrap();
        assert_eq!(vec!["ДОЛГОЄ", "НОВОЄГОРІВКА"], result);
    }
}

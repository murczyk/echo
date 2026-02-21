use crate::entities::*;
use crate::types::*;
use crate::unit::const_units::*;
use lazy_static::lazy_static;
use regex::{Regex, RegexBuilder};
use sea_orm::*;
use std::sync::OnceLock;

mod const_units;
pub mod parser;

static NAMES_RE: OnceLock<Regex> = OnceLock::new();
static DIVISIONS_RE: OnceLock<Regex> = OnceLock::new();
static BATTALIONS_RE: OnceLock<Regex> = OnceLock::new();
static COMPANIES_RE: OnceLock<Regex> = OnceLock::new();
static ARMIES_RE: OnceLock<Regex> = OnceLock::new();
static REGIMENTS_RE: OnceLock<Regex> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitInfo {
    pub unit_type: Option<UnitType>,
    pub number: Option<String>,
    pub name: String,
    pub idx: usize,
}

pub async fn parse_unit<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Option<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let units_list = parse_units(text, dbx).await.c(h!())?;
    Ok(to_unit_txt(units_list))
}

pub fn to_unit_txt(units_list: Vec<String>) -> Option<String> {
    units_list.into_iter().reduce(|a, b| format!("{a}, {b}"))
}

async fn parse_units<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let units_info = parse_existing_units(text, dbx).await.c(h!())?;
    if !units_info.is_empty() {
        return Ok(units_info);
    }

    let mut regiments = collect_regiments(text, dbx).await.c(h!())?;
    if regiments.is_empty() {
        return Ok(parse_library_unit(text));
    }

    let mut companies = collect_companies(text, dbx).await.c(h!())?;
    let mut battalions = collect_battalions(text, dbx).await.c(h!())?;
    let mut divisions = collect_divisions(text, dbx).await.c(h!())?;
    let mut armies = collect_armies(text, dbx).await.c(h!())?;

    let mut size = [
        companies.len(),
        battalions.len(),
        regiments.len(),
        armies.len(),
        divisions.len(),
    ]
    .iter()
    .max()
    .cloned()
    .unwrap_or(0);

    let mut units_info = BTreeMap::new();
    while size > 0 {
        size -= 1;
        let mut collector = BTreeMap::new();
        if let Some(value) = companies.pop() {
            collector.insert(value, UnitType::COMPANY);
        }
        if let Some(value) = battalions.pop() {
            collector.insert(value, UnitType::BATTALION);
        }
        if let Some(value) = regiments.pop() {
            collector.insert(value, UnitType::REGIMENT);
        }
        if let Some(value) = divisions.pop() {
            collector.insert(value, UnitType::DIVISION);
        }
        if let Some(value) = armies.pop() {
            collector.insert(value, UnitType::ARMY);
        }
        if !collector.is_empty() {
            let key = collector
                .clone()
                .into_iter()
                .map(|x| x.0)
                .collect_vec()
                .join(" ");
            units_info.insert(key, collector);
        }
    }
    Ok(join_results(units_info))
}

fn join_results(
    units_info: BTreeMap<String, BTreeMap<String, UnitType>>,
) -> Vec<String> {
    let mut result = vec![];
    for (unit, unit_meta) in units_info.clone() {
        let mut skip = false;
        for (other_unit, other_unit_meta) in units_info.clone() {
            if other_unit.contains(&unit) && !unit.contains(&other_unit) {
                skip = skip
                    || other_unit_meta.clone().into_iter().any(
                        |(value0, unit_type0)| {
                            unit_meta
                                .get(&value0)
                                .cloned()
                                .filter(|t| (*t as i32) == unit_type0 as i32)
                                .is_some()
                        },
                    );
            }
        }
        if !skip {
            result.push(unit)
        }
    }
    result
}

async fn collect_companies<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let data = match COMPANIES_RE.get() {
        None => load_unit_companies(dbx).await.c(h!())?,
        _some => vec![],
    };
    let companies_re =
        COMPANIES_RE.get_or_init(|| regex_from_data(data)).clone();
    let mut companies = vec![];
    for cap in companies_re.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            companies.push(name.as_str().to_string());
        }
    }
    Ok(companies)
}

async fn collect_battalions<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let data = match BATTALIONS_RE.get() {
        None => load_unit_battalions(dbx).await.c(h!())?,
        _some => vec![],
    };
    let battalions_re =
        BATTALIONS_RE.get_or_init(|| regex_from_data(data)).clone();
    let mut battalions = vec![];
    for cap in battalions_re.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            battalions.push(name.as_str().to_string());
        }
    }
    Ok(battalions)
}

async fn collect_armies<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let data = match ARMIES_RE.get() {
        None => load_unit_armies(dbx).await.c(h!())?,
        _some => vec![],
    };
    let armies_re = ARMIES_RE.get_or_init(|| regex_from_data(data)).clone();
    let mut armies = vec![];
    for cap in armies_re.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            armies.push(name.as_str().to_string());
        }
    }
    Ok(armies)
}

async fn collect_divisions<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let data = match DIVISIONS_RE.get() {
        None => load_unit_divisions(dbx).await.c(h!())?,
        _some => vec![],
    };
    let divisions_re =
        DIVISIONS_RE.get_or_init(|| regex_from_data(data)).clone();
    let mut divisions = vec![];
    for cap in divisions_re.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            divisions.push(name.as_str().to_string());
        }
    }
    Ok(divisions)
}

async fn collect_regiments<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let data = match REGIMENTS_RE.get() {
        None => load_unit_regiments(dbx).await.c(h!())?,
        _some => vec![],
    };
    let regiments_re =
        REGIMENTS_RE.get_or_init(|| regex_from_data(data)).clone();
    let mut regiments = vec![];
    for cap in regiments_re.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            regiments.push(name.as_str().to_string());
        }
    }
    Ok(regiments)
}

async fn parse_existing_units<'a, 'async_trait, C>(
    text: &String,
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    let unit_names = match NAMES_RE.get() {
        None => load_unit_names(dbx).await.c(h!())?,
        _some => vec![],
    };
    let names_re = NAMES_RE.get_or_init(|| regex_from_data(unit_names)).clone();

    let mut units_info = vec![];
    for cap in names_re.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            units_info.push(name.as_str().to_string());
        }
    }
    Ok(units_info)
}

pub fn has_unit(text: &String) -> bool {
    let units_info = capture_library_unit(text);
    units_info.len() > 1
}

pub fn parse_library_unit(text: &String) -> Vec<String> {
    let text = preprocess_unit_text(text);
    println!("parsing unit {text}");
    let mut units_info = capture_library_unit(&text);
    units_info.sort_by_key(|x| x.idx);

    // current_group collects segments like company number, batallion number etc. until it sees that unit type isn't increasing or not present, it then "splits" and pushes new accumulator
    let mut current_group: Vec<String> = vec![];
    let mut result = vec![];
    let mut last_unit_type: Option<UnitType> = None;
    for info in units_info {
        let init_new = if let Some(unit_type) = info.unit_type {
            match last_unit_type {
                Some(last) => unit_type <= last,
                None => false,
            }
        } else {
            false
        };
        let segment = match info.number {
            Some(number) => format!("{} {}", number, info.name),
            None => info.name,
        };
        if init_new {
            if !current_group.is_empty() {
                result.push(current_group.join(" "));
            }
            current_group = vec![];
        }
        last_unit_type = info.unit_type;
        current_group.push(segment);
    }
    if !current_group.is_empty() {
        result.push(current_group.join(" "));
    }
    crate::utils::uniq_via_btreeset(&result)
}

fn capture_library_unit(text: &str) -> Vec<UnitInfo> {
    lazy_static! {
        static ref UNIT_RE: Regex = RegexBuilder::new(
            r#"\b(?<number>\d{1,7})(?:\s?)(?<name>[а-яєїіА-ЯЄЇІ]{1,10})\b"#
        )
        .case_insensitive(true)
        .build()
        .expect("Invalid Regex");
        static ref UNIT_STANDALONE_RE: Regex = RegexBuilder::new(
            &r#"\b(?<name>$s1)\b"#.replace("$s1", &list_standalone().join("|"))
        )
        .case_insensitive(true)
        .build()
        .expect("Invalid Regex");
        static ref PREFIX_RE: Regex =
            RegexBuilder::new("^(?<prefix>зв|з|гв|г|о)")
                .case_insensitive(true)
                .build()
                .expect("Invalid Regex");
    }

    let mut units_info = vec![];

    for cap in UNIT_STANDALONE_RE.captures_iter(text) {
        if let Some(name) = cap.name("name") {
            let idx = name.clone().start();
            let name = name.as_str().to_string();
            let number = None;
            let unit_type = None;
            units_info.push(UnitInfo {
                idx,
                unit_type,
                number,
                name,
            })
        }
    }

    for cap in UNIT_RE.captures_iter(text) {
        if let (Some(number), Some(name)) =
            (cap.name("number"), cap.name("name"))
        {
            let idx = name.clone().start();
            let number = Some(number.as_str().to_string());
            let name = name.as_str().to_string();
            let mut cropped_name = name.to_lowercase();
            loop {
                let mut unit_type = None;
                if list_companies().contains(&cropped_name) {
                    unit_type = Some(UnitType::COMPANY);
                }
                if list_regiments().contains(&cropped_name) {
                    unit_type = Some(UnitType::REGIMENT);
                }
                if list_armies().contains(&cropped_name) {
                    unit_type = Some(UnitType::ARMY);
                }
                if list_battalions().contains(&cropped_name) {
                    unit_type = Some(UnitType::BATTALION);
                }
                if list_divisions().contains(&cropped_name) {
                    unit_type = Some(UnitType::DIVISION);
                }
                if unit_type.is_some() {
                    units_info.push(UnitInfo {
                        idx,
                        unit_type,
                        number,
                        name,
                    });
                    break;
                } else {
                    let old_cropped_name = cropped_name.clone();
                    cropped_name = crop_prefix(&cropped_name, &PREFIX_RE);
                    if old_cropped_name.eq(&cropped_name) {
                        break;
                    }
                }
            }
        }
    }
    units_info
}

fn crop_prefix(name: &String, regex: &Regex) -> String {
    let name = name.clone();
    if let Some(prefix_cap) = regex.captures(&name) {
        if let Some(prefix) = prefix_cap
            .name("prefix")
            .map(|x| x.clone().as_str().to_string())
        {
            return name.replace(&prefix, "");
        }
    }
    name
}

fn regex_from_data(data: Vec<String>) -> Regex {
    let expression = "^(?<name>$s)".replace("$s", &data.join("|"));
    RegexBuilder::new(&expression)
        .case_insensitive(true)
        .build()
        .expect("Invalid Regex")
}

async fn load_unit_names<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Name.is_not_null())
        .filter(sigint_unit::Column::Name.eq("").not())
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|x| x.name)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec())
}

async fn load_unit_companies<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Company.is_not_null())
        .filter(sigint_unit::Column::Company.eq("").not())
        .all(dbx)
        .await
        .unwrap_or(vec![])
        .into_iter()
        .map(|x| x.company)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec())
}

async fn load_unit_divisions<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Division.is_not_null())
        .filter(sigint_unit::Column::Division.eq("").not())
        .all(dbx)
        .await
        .unwrap_or(vec![])
        .into_iter()
        .map(|x| x.division)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec())
}

async fn load_unit_regiments<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Regiment.is_not_null())
        .filter(sigint_unit::Column::Regiment.eq("").not())
        .all(dbx)
        .await
        .unwrap_or(vec![])
        .into_iter()
        .map(|x| x.regiment)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec())
}

async fn load_unit_battalions<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Battalion.is_not_null())
        .filter(sigint_unit::Column::Battalion.eq("").not())
        .all(dbx)
        .await
        .unwrap_or(vec![])
        .into_iter()
        .map(|x| x.battalion)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec())
}

async fn load_unit_armies<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Army.is_not_null())
        .filter(sigint_unit::Column::Army.eq("").not())
        .all(dbx)
        .await
        .unwrap_or(vec![])
        .into_iter()
        .map(|x| x.army)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec())
}

fn preprocess_unit_text(input: &String) -> String {
    input
        .replace(" зі складу ", " ")
        .replace(" ймовірно ", " ")
        .replace(" йм. ", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub fn test_simple() {
        let input = String::from("1 мбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_case_insensitive() {
        let input = String::from("1 МбР");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_okrema() {
        let input = String::from("12 омбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_gvard() {
        let input = String::from("123 гвмбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_gvard2() {
        let input = String::from("1234 гмбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_okrema_gvard() {
        let input = String::from("12345 гомбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_okrema_gvard2() {
        let input = String::from("123456 гвомбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_okrema_gvard3() {
        let input = String::from("123456 гвзвзгомбр");
        let result = parse_library_unit(&input);
        assert_eq!(vec![input], result);
    }

    #[test]
    pub fn test_no_space() {
        let result =
            parse_library_unit(&String::from("14:39:30 П64 УКХ р-м 35П РХБЗ"));
        assert_eq!(vec![String::from("35 П РХБЗ")], result);
    }

    #[test]
    pub fn test_bars() {
        let result = parse_library_unit(&String::from(
            "УКХ р/м управління БАРС-3\"Родина",
        ));
        assert_eq!(vec![String::from("БАРС-3")], result);
    }

    #[test]
    pub fn test_bars2() {
        let result =
            parse_library_unit(&String::from("УКХ р/м імовірно БАРС-08"));
        assert_eq!(vec![String::from("БАРС-08")], result);
    }

    #[test]
    pub fn test_bars3() {
        let result = parse_library_unit(&String::from("УКХ р/м загін БАРС"));
        assert_eq!(vec![String::from("БАРС")], result);
    }

    #[test]
    pub fn test_join_result() {
        let mut info = BTreeMap::new();

        let mut map1 = BTreeMap::new();
        map1.insert(String::from("429 мсп"), UnitType::REGIMENT);
        map1.insert(String::from("19 мсд"), UnitType::DIVISION);
        map1.insert(String::from("58 А"), UnitType::ARMY);

        let mut map2 = BTreeMap::new();
        map2.insert(String::from("429 мсп"), UnitType::REGIMENT);

        info.insert(String::from("429 мсп 19 мсд 58 А"), map1);
        info.insert(String::from("429 мсп"), map2);
        let result = join_results(info);
        assert_eq!(vec![String::from("429 мсп 19 мсд 58 А")], result)
    }

    #[test]
    fn extract_unit_20_library_unit() {
        let body = r#"23:13
30.10.2024
159.250
1 мсб 123 омсбр
р-н Берестове-Спірне
1. 100-й (йм. вузол зв'язку 1 мсб 123 омсбр), 100-й Борзому (йм. бойовик зі складу 1 мсб 123 омсбр)
2. Давай быстренько, в норку
1. Да, да, плюс"#;
        assert_eq!(
            vec!["1 мсб 123 омсбр"],
            parse_library_unit(&String::from(body))
        );
    }
}

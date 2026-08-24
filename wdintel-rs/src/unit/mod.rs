use crate::config::{
    SIGINT_UNIT_DYNAMIC_REGEX_CHUNK_SIZE,
    SIGINT_UNIT_DYNAMIC_REGEX_SIZE_LIMIT_BYTES,
};
use crate::entities::*;
use crate::types::*;
use crate::unit::const_units::*;
use lazy_static::lazy_static;
use regex::{Regex, RegexBuilder};
use sea_orm::*;
use std::sync::OnceLock;

mod const_units;
pub mod parser;

type UnitRegexCache = OnceLock<Result<Vec<Regex>, String>>;

static NAMES_RE: UnitRegexCache = OnceLock::new();
static DIVISIONS_RE: UnitRegexCache = OnceLock::new();
static BATTALIONS_RE: UnitRegexCache = OnceLock::new();
static COMPANIES_RE: UnitRegexCache = OnceLock::new();
static ARMIES_RE: UnitRegexCache = OnceLock::new();
static REGIMENTS_RE: UnitRegexCache = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitInfo {
    pub unit_type: Option<UnitType>,
    pub number: Option<String>,
    pub name: String,
    pub idx: usize,
}

pub fn are_units_related(
    unit1: &sigint_unit::Model,
    unit2: &sigint_unit::Model,
) -> bool {
    if unit1.id == unit2.id {
        return true;
    }
    if !unit1.name.is_empty() && unit1.name == unit2.name {
        return true;
    }
    deepest_shared_hierarchy_level(unit1, unit2).is_some()
}

fn deepest_shared_hierarchy_level(
    unit1: &sigint_unit::Model,
    unit2: &sigint_unit::Model,
) -> Option<usize> {
    let hierarchy1 = unit_hierarchy(unit1);
    let hierarchy2 = unit_hierarchy(unit2);
    let shared_level = hierarchy1
        .into_iter()
        .zip(hierarchy2)
        .enumerate()
        .filter(|(_, (level1, level2))| !level1.is_empty() && level1 == level2)
        .map(|(idx, _)| idx)
        .next_back()?;

    if has_known_parent_conflict(&hierarchy1, &hierarchy2, shared_level) {
        return None;
    }

    Some(shared_level)
}

fn has_known_parent_conflict(
    hierarchy1: &[&str; 14],
    hierarchy2: &[&str; 14],
    shared_level: usize,
) -> bool {
    hierarchy1
        .iter()
        .zip(hierarchy2.iter())
        .take(shared_level)
        .any(|(level1, level2)| {
            !level1.is_empty() && !level2.is_empty() && level1 != level2
        })
}

fn unit_hierarchy(unit: &sigint_unit::Model) -> [&str; 14] {
    [
        unit.army_region.trim(),
        unit.military_district.trim(),
        unit.army.trim(),
        unit.corps.trim(),
        unit.division.trim(),
        unit.brigade.trim(),
        unit.regiment.trim(),
        unit.battalion.trim(),
        unit.company.trim(),
        unit.platoon.trim(),
        unit.squad.trim(),
        unit.section.trim(),
        unit.team_or_crew.trim(),
        unit.other.trim(),
    ]
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
    let companies_re = cached_unit_regexes(&COMPANIES_RE, data).c(h!())?;
    Ok(capture_unit_name(text, companies_re).into_iter().collect())
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
    let battalions_re = cached_unit_regexes(&BATTALIONS_RE, data).c(h!())?;
    Ok(capture_unit_name(text, battalions_re).into_iter().collect())
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
    let armies_re = cached_unit_regexes(&ARMIES_RE, data).c(h!())?;
    Ok(capture_unit_name(text, armies_re).into_iter().collect())
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
    let divisions_re = cached_unit_regexes(&DIVISIONS_RE, data).c(h!())?;
    Ok(capture_unit_name(text, divisions_re).into_iter().collect())
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
    let regiments_re = cached_unit_regexes(&REGIMENTS_RE, data).c(h!())?;
    Ok(capture_unit_name(text, regiments_re).into_iter().collect())
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
    let names_re = cached_unit_regexes(&NAMES_RE, unit_names).c(h!())?;
    Ok(capture_unit_name(text, names_re).into_iter().collect())
}

pub fn has_unit(text: &String) -> bool {
    let units_info = capture_library_unit(text);
    units_info.len() > 1
}

pub fn parse_library_unit(text: &String) -> Vec<String> {
    let text = preprocess_unit_text(text);
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

pub(crate) fn parse_library_unit_segments(text: &str) -> Vec<String> {
    let text = preprocess_unit_text(&text.to_string());
    let mut units_info = capture_library_unit(&text);
    units_info.sort_by_key(|unit| unit.idx);
    crate::utils::uniq_via_btreeset(
        &units_info
            .into_iter()
            .map(|unit| match unit.number {
                Some(number) => format!("{} {}", number, unit.name),
                None => unit.name,
            })
            .collect_vec(),
    )
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

    let text = apply_unit_name_fixes(text.to_string());
    let (text, names_units) = extract_named_units(text);
    let mut counter = 0;
    for nm in names_units {
        counter += 1;
        units_info.push(UnitInfo {
            idx: 1000 * counter,
            unit_type: None,
            number: None,
            name: nm.to_string(),
        });
    }

    for cap in UNIT_STANDALONE_RE.captures_iter(&text.to_lowercase()) {
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

    for cap in UNIT_RE.captures_iter(&text) {
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
                    if old_cropped_name == cropped_name {
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

fn regexes_from_data(data: Vec<String>) -> Result<Vec<Regex>, regex::Error> {
    let data = data
        .into_iter()
        .map(|value| regex::escape(&value))
        .collect_vec();
    data.chunks(SIGINT_UNIT_DYNAMIC_REGEX_CHUNK_SIZE)
        .map(|data| {
            let expression = "^(?<name>$s)".replace("$s", &data.join("|"));
            RegexBuilder::new(&expression)
                .case_insensitive(true)
                .size_limit(SIGINT_UNIT_DYNAMIC_REGEX_SIZE_LIMIT_BYTES)
                .build()
        })
        .collect()
}

fn cached_unit_regexes(
    cache: &UnitRegexCache,
    data: Vec<String>,
) -> anyhow::Result<&[Regex]> {
    let regexes = cache
        .get_or_init(|| {
            regexes_from_data(data).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| anyhow::anyhow!(error.clone()))
        .c(h!())?;
    Ok(regexes)
}

fn capture_unit_name(text: &str, regexes: &[Regex]) -> Option<String> {
    regexes.iter().find_map(|regex| {
        regex
            .captures(text)
            .and_then(|captures| captures.name("name"))
            .map(|name| name.as_str().to_string())
    })
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
    lazy_static! {
        static ref THIRD_SYMBOLIC_ARMY_TYPO_RE: Regex =
            Regex::new(r#"\b(?P<number>\d+)\s+3(?i:а)\b"#).unwrap();
    }

    let input = THIRD_SYMBOLIC_ARMY_TYPO_RE.replace_all(input, "$number ЗА");
    input
        .replace(" зі складу ", " ")
        .replace(" ймовірно ", " ")
        .replace(" йм. ", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_unit(
        id: i64,
        name: &str,
        army: &str,
        division: &str,
        regiment: &str,
        battalion: &str,
        company: &str,
    ) -> sigint_unit::Model {
        sigint_unit::Model {
            id,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: company.to_string(),
            regiment: regiment.to_string(),
            brigade: String::new(),
            division: division.to_string(),
            corps: String::new(),
            army: army.to_string(),
            army_region: String::new(),
            military_district: String::new(),
            active: true,
            deleted: false,
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            created_by_login_id: uuid::Uuid::nil(),
            name: name.to_string(),
            comment: String::new(),
            battalion: battalion.to_string(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            is_inconsistent: false,
            updated_at: Default::default(),
        }
    }

    fn assert_units_related(
        unit1: sigint_unit::Model,
        unit2: sigint_unit::Model,
    ) {
        assert!(are_units_related(&unit1, &unit2));
        assert!(are_units_related(&unit2, &unit1));
    }

    fn assert_units_unrelated(
        unit1: sigint_unit::Model,
        unit2: sigint_unit::Model,
    ) {
        assert!(!are_units_related(&unit1, &unit2));
        assert!(!are_units_related(&unit2, &unit1));
    }

    #[test]
    fn unit_relation_matches_same_id() {
        assert_units_related(
            mk_unit(1, "unit-a", "", "", "", "", ""),
            mk_unit(1, "unit-b", "", "", "", "", ""),
        );
    }

    #[test]
    fn unit_relation_matches_same_name_without_hierarchy() {
        assert_units_related(
            mk_unit(1, "unit-a", "", "", "", "", ""),
            mk_unit(2, "unit-a", "", "", "", "", ""),
        );
    }

    #[test]
    fn unit_relation_rejects_empty_unmatched_units() {
        assert_units_unrelated(
            mk_unit(1, "unit-a", "", "", "", "", ""),
            mk_unit(2, "unit-b", "", "", "", "", ""),
        );
    }

    #[test]
    fn unit_relation_matches_army_parent_to_division_child() {
        assert_units_related(
            mk_unit(1, "army", "1 army", "", "", "", ""),
            mk_unit(2, "division", "1 army", "2 div", "", "", ""),
        );
    }

    #[test]
    fn unit_relation_matches_regiment_parent_to_battalion_child() {
        assert_units_related(
            mk_unit(1, "regiment", "1 army", "2 div", "3 reg", "", ""),
            mk_unit(2, "battalion", "1 army", "2 div", "3 reg", "4 bat", ""),
        );
    }

    #[test]
    fn unit_relation_matches_battalion_parent_to_company_child() {
        assert_units_related(
            mk_unit(1, "battalion", "1 army", "2 div", "3 reg", "4 bat", ""),
            mk_unit(2, "company", "1 army", "2 div", "3 reg", "4 bat", "5 coy"),
        );
    }

    #[test]
    fn unit_relation_matches_battalion_siblings_by_common_regiment() {
        assert_units_related(
            mk_unit(1, "bat-1", "1 army", "2 div", "3 reg", "1 bat", ""),
            mk_unit(2, "bat-2", "1 army", "2 div", "3 reg", "2 bat", ""),
        );
    }

    #[test]
    fn unit_relation_matches_company_siblings_by_common_battalion() {
        assert_units_related(
            mk_unit(1, "coy-1", "1 army", "2 div", "3 reg", "4 bat", "1 coy"),
            mk_unit(2, "coy-2", "1 army", "2 div", "3 reg", "4 bat", "2 coy"),
        );
    }

    #[test]
    fn unit_relation_matches_regiment_siblings_by_common_division() {
        assert_units_related(
            mk_unit(1, "reg-1", "1 army", "2 div", "1 reg", "", ""),
            mk_unit(2, "reg-2", "1 army", "2 div", "2 reg", "", ""),
        );
    }

    #[test]
    fn unit_relation_matches_division_siblings_by_common_army() {
        assert_units_related(
            mk_unit(1, "div-1", "1 army", "1 div", "", "", ""),
            mk_unit(2, "div-2", "1 army", "2 div", "", "", ""),
        );
    }

    #[test]
    fn unit_relation_matches_when_only_lower_level_is_known() {
        assert_units_related(
            mk_unit(1, "reg-1", "", "", "3 reg", "", ""),
            mk_unit(2, "bat-1", "", "", "3 reg", "4 bat", ""),
        );
    }

    #[test]
    fn unit_relation_rejects_shared_lower_level_with_different_parent() {
        assert_units_unrelated(
            mk_unit(1, "parsed", "", "3 div", "11 reg", "", ""),
            mk_unit(2, "network", "", "5 div", "11 reg", "", ""),
        );
    }

    #[test]
    fn unit_relation_trims_hierarchy_values() {
        assert_units_related(
            mk_unit(1, "reg-1", " 1 army ", "", " 3 reg ", "", ""),
            mk_unit(2, "bat-1", "1 army", "", "3 reg", "4 bat", ""),
        );
    }

    #[test]
    fn unit_relation_rejects_units_without_common_hierarchy() {
        assert_units_unrelated(
            mk_unit(1, "reg-1", "1 army", "1 div", "1 reg", "", ""),
            mk_unit(2, "reg-2", "2 army", "2 div", "2 reg", "", ""),
        );
    }

    #[test]
    fn regex_from_data_treats_unit_names_as_literals() {
        let unit_name = "1436 мсп (на МТ-ЛБ)";
        let regexes =
            regexes_from_data(vec![unit_name.to_string(), ")".to_string()])
                .unwrap();

        assert_eq!(
            Some(unit_name.to_string()),
            capture_unit_name(unit_name, &regexes)
        );
        assert_eq!(Some(")".to_string()), capture_unit_name(")", &regexes));
    }

    #[test]
    fn regex_from_data_accepts_production_sized_unit_list() {
        let unit_names = (0..50_000)
            .map(|idx| {
                format!("{idx:05} підрозділ {idx:05} бригада {idx:05} армія")
            })
            .collect_vec();
        let expected = unit_names.last().unwrap().clone();
        let regexes = regexes_from_data(unit_names).unwrap();

        assert!(regexes.len() > 1);
        assert_eq!(
            Some(expected.clone()),
            capture_unit_name(&expected, &regexes)
        );
    }

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
        assert_eq!(vec![input.to_lowercase()], result);
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
        assert_eq!(vec![String::from("35 п рхбз")], result);
    }

    #[test]
    pub fn test_bars_bad() {
        let result = parse_library_unit(&String::from(
            "УКХ р/м управління БАРС-3\"Родина",
        ));
        assert_eq!(vec![String::from("барс")], result);
    }

    #[test]
    pub fn test_bars() {
        let result = parse_library_unit(&String::from(
            "УКХ р/м управління БАРС-3 \"Родина",
        ));
        assert_eq!(vec![String::from("барс-3")], result);
    }

    #[test]
    pub fn test_bars2() {
        let result =
            parse_library_unit(&String::from("УКХ р/м імовірно БАРС-08"));
        assert_eq!(vec![String::from("барс-08")], result);
    }

    #[test]
    pub fn test_bars3() {
        let result = parse_library_unit(&String::from("УКХ р/м загін БАРС"));
        assert_eq!(vec![String::from("барс")], result);
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

    #[test]
    fn parse_library_unit_soliton_paliy_unit_v2() {
        let body = r#"Отримано з поста "Soliton_Paliy2"
--------------------------------------
15.07.2026, 10:40:32
153.6250
153.625 МГц УКХ р/м 1 мсб 121 мсп 68 мсд 6 3А (ЗАПАДНЕ, МАСЮТІВКА, ЛИМАН ПЕРШИЙ)
НВ
ЗАРЯ

1 — Заря, Заря, прием."#;

        assert_eq!(
            Some("1 мсб 121 мсп 68 мсд 6 за".to_string()),
            to_unit_txt(parse_library_unit(&String::from(body)))
        );
    }

    #[test]
    fn parse_library_unit_treats_3a_after_number_as_za_typo() {
        assert_eq!(
            Some("7 за".to_string()),
            to_unit_txt(parse_library_unit(&String::from("7 3А")))
        );
        assert_eq!(
            Some("12 за".to_string()),
            to_unit_txt(parse_library_unit(&String::from("12 3а")))
        );
    }

    #[test]
    fn parse_library_unit_keeps_spaced_third_army() {
        assert_eq!(
            Some("3 а".to_string()),
            to_unit_txt(parse_library_unit(&String::from("334 ошп 3 А")))
        );
    }

    #[test]
    fn parse_library_unit_parses_all_unit_names_files() {
        let unit_names_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("data/unit_names");
        let mut unit_name_files = std::fs::read_dir(&unit_names_dir)
            .expect("failed to read unit names data dir")
            .map(|entry| entry.expect("failed to read unit names file").path())
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        unit_name_files.sort();
        assert!(
            !unit_name_files.is_empty(),
            "no files found in {}",
            unit_names_dir.display()
        );

        let mut empty_parse_cases = Vec::new();
        for file_path in unit_name_files {
            let mut reader =
                csv::Reader::from_path(&file_path).unwrap_or_else(|_| {
                    panic!("failed to read csv {}", file_path.display())
                });
            for (idx, record_result) in reader.records().enumerate() {
                let record = record_result.unwrap_or_else(|_| {
                    panic!(
                        "failed to read record {} in {}",
                        idx + 2,
                        file_path.display()
                    )
                });
                let unit_name = record
                    .get(0)
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                if unit_name.is_empty() {
                    continue;
                }
                if parse_library_unit(&unit_name).is_empty() {
                    empty_parse_cases.push(format!(
                        "{}:{}: {}",
                        file_path.display(),
                        idx + 2,
                        unit_name
                    ));
                }
            }
        }

        for case in &empty_parse_cases {
            println!("{case}");
        }
        assert!(
            empty_parse_cases.len() <= 46,
            "parse_library_unit returned unparsed records for {} case(s)",
            empty_parse_cases.len()
        );
    }
}

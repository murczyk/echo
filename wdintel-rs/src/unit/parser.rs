use crate::location::SettlementDetails;
use crate::rer_importer::types::UnitAndLoc;
use crate::types::*;
use crate::unit::has_unit;
use crate::utils::m_cap_s;
use crate::utils::string::byte_substr;
use itertools::Itertools;
use lazy_static::lazy_static;
use regex::{Regex, RegexBuilder};
use std::slice::Iter;

pub fn extract_unit(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    inp: &str,
    callsigns: Vec<String>,
) -> Result<UnitAndLoc, AppError> {
    extract_unit_with_aor(settlements, inp, callsigns, None)
}

pub fn extract_unit_with_aor(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    inp: &str,
    callsigns: Vec<String>,
    m_aor_id: Option<i64>,
) -> Result<UnitAndLoc, AppError> {
    // trace!("> extract_unit: inp={inp}");
    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_extended_format::parse(inp)
    {
        return Ok(UnitAndLoc {
            unit: Some(format!(
                "{} {}",
                zp_peleng.signal_type, zp_peleng.unit_name
            )),
            locality: Some(zp_peleng.location),
            locality_v2: None,
        });
    }

    if let Some(unit) = try_extract_report_125_unit(inp) {
        return Ok(UnitAndLoc {
            unit: Some(unit),
            locality: None,
            locality_v2: None,
        });
    }

    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_vorony_odina_format::parse(inp)
    {
        return Ok(UnitAndLoc {
            unit: None,
            locality: Some(zp_peleng.location),
            locality_v2: None,
        });
    }

    if let Some(value) = try_extract_pu_fsb_rf_unit_and_location(
        settlements.clone(),
        inp,
        m_aor_id,
    )
    .c(h!())?
    {
        return Ok(value);
    }

    if let Some(value) = try_extract_standard_unit_and_location(
        settlements.clone(),
        inp,
        m_aor_id,
    )
    .c(h!())?
    {
        return Ok(value);
    }
    if let Some(value) =
        try_extract_jf_unit_and_location(settlements.clone(), inp, m_aor_id)
            .c(h!())?
    {
        return Ok(value);
    }
    let mut locality = None;
    let mut locality_v2 = None;
    let lines: Vec<String> = inp
        .lines()
        .map(|x| x.to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();
    let mut lines = try_remove_commintify_header(lines);
    lines.truncate(5);
    let lines = try_process_kharkiv_style_unit_and_locality(lines);
    let mut remaining_lines = lines.iter();
    while let Some(line) = remaining_lines.next() {
        let l = line.to_lowercase();
        let ltrim = line.trim();
        let line = cleanup_line(ltrim);

        if let Some(loc) =
            maybe_single_locality(line.clone(), false, &callsigns)
        {
            (locality, locality_v2) = extract_locality(
                settlements.clone(),
                line.clone(),
                Some(loc),
                m_aor_id,
            )
            .c(h!())?;
            continue;
        }

        let is_unit_and_loc_line =
            is_unit_and_loc_line(&line, l, &ltrim.to_lowercase()).c(h!())?;
        if is_unit_and_loc_line {
            let (unit, locality) =
                capture_unit_and_locality(line.clone(), locality).c(h!())?;

            let locality = locality
                .map(|x| x.trim_matches(['-', ' ']).trim().to_string())
                .and_then(|x| if !x.is_empty() { Some(x) } else { None });

            let (mut locality, mut locality_v2) =
                extract_locality(settlements.clone(), line, locality, m_aor_id)
                    .c(h!())?;

            if locality_v2.clone().unwrap_or(vec![]).is_empty() {
                (locality, locality_v2) = try_lookup_next_line_loc_with_prefix(
                    settlements.clone(),
                    &mut remaining_lines,
                    locality,
                    locality_v2,
                    &callsigns,
                    m_aor_id,
                )
                .c(h!())?
            }

            let bad_symbol = |c| c == '\"' || c == ' ' || c == ']';
            let unit = unit.trim_start_matches(bad_symbol);
            let unit = unit.trim_end_matches(bad_symbol);
            let unit = unit.trim().to_string();

            return Ok(UnitAndLoc {
                unit: Some(unit),
                locality,
                locality_v2,
            });
        }
    }
    let unit_and_loc = UnitAndLoc {
        unit: None,
        locality,
        locality_v2,
    };
    Ok(unit_and_loc)
}

fn try_lookup_next_line_loc_with_prefix(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    remaining_lines: &mut Iter<String>,
    locality: Option<String>,
    locality_v2: Option<Vec<SettlementDetails>>,
    callsigns: &Vec<String>,
    m_aor_id: Option<i64>,
) -> Result<(Option<String>, Option<Vec<SettlementDetails>>), AppError> {
    let location_line = remaining_lines.next().cloned();
    if let Some(location_line) = location_line {
        if let Some(loc) =
            maybe_single_locality(location_line.clone(), true, callsigns)
        {
            return extract_locality(
                settlements.clone(),
                location_line,
                Some(loc),
                m_aor_id,
            );
        }
    }
    Ok((locality, locality_v2))
}

fn cleanup_line(ltrim: &str) -> String {
    if ltrim.starts_with("(") && ltrim.ends_with(")") {
        let result = remove_first_occurrence(ltrim, '(');
        remove_first_occurrence(&result, ')')
    } else {
        ltrim.to_string()
    }
}

fn extract_locality(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    line: String,
    locality: Option<String>,
    m_aor_id: Option<i64>,
) -> Result<(Option<String>, Option<Vec<SettlementDetails>>), AppError> {
    let mut locality = locality;
    let mut locality_v2 = None;
    if let Some(local) = locality.clone() {
        let data = crate::location::parse_location_with_aor(
            settlements.clone(),
            local,
            m_aor_id,
        )
        .c(h!())?;
        locality_v2 = Some(data);
    }
    if locality_v2.clone().filter(|x| !x.is_empty()).is_none() {
        locality_v2 = Some(
            crate::location::parse_location_with_aor(
                settlements.clone(),
                line.clone(),
                m_aor_id,
            )
            .c(h!())?,
        );
        if locality_v2.clone().filter(|x| !x.is_empty()).is_some() {
            locality = Some(line.clone());
        }
    }
    Ok((locality, locality_v2))
}

fn capture_unit_and_locality(
    line: String,
    locality: Option<String>,
) -> Result<(String, Option<String>), AppError> {
    let mut line = line;
    let mut locality = locality;
    // trace!("> line: {line}");
    '_if: {
        // cutoff 54191: 09:11    F= 455.4875
        let ms: Vec<_> = line.match_indices("УКХ").collect();
        if !ms.is_empty() {
            let match_index = ms[0].0;
            line = byte_substr(&line, match_index, line.len())?;
        }
    }
    // trace!("> line before '_capts: {line}");
    '_capt: {
        '_if: {
            // extract "[Мережа: УКХ р/м управління 1 мсб 4 ВБ ВАСИЛІВКА]"
            lazy_static! {
                static ref RE_UNIT_BRACES: Regex = Regex::new(
                    r#"^.*\[Мережа: (?P<unit>.*)(?<locality>[А-ЯІЇ]*)\]"#
                )
                .unwrap();
            }
            let Some(capts) = RE_UNIT_BRACES.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            if !line.is_empty() {
                line = unit;
            }
            break '_capt;
        }
        '_if: {
            // extract "УКХ <some text> 123 AK (ВАСИЛІВКА)"
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* [0-9]+\s*АК?)\s*\((?P<locality>[А-ЯІЇ\'\.\,\-\s]+)\)\s*\(\([А-ЯІЇ\'\.\,\-\s]+\)\).*"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            // trace!("> if2");
            break '_capt;
        }
        '_if: {
            // Extract "УКХ Example Text (12345 Some Data) More Text (Location ВАСИЛІВКА–НОВА) Extra"
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    // – is not a dash
                    r#"(?P<unit>УКХ .*\(\d+.*\)[^)]+)\([^А-ЯЄІЇ]+(?P<locality>[А-ЯЄІЇа-яєії'-,\.\s–]+)\)?.*"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* )\([^А-ЯЄІЇ]+(?P<locality>[А-ЯЄІЇа-яєії'-,\.\s]*)\)"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* )\((?P<locality>[А-ЯЄІЇа-яєії'-,\.\s]+)\)"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* [0-9]+\s*АК?)\s*\((?P<locality>[А-ЯЄІЇ\'\.\,\-\s]+)\).*"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            // trace!("> if2");
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* [0-9]+\s*АК?)\s*\((?P<locality>[а-яєіїА-ЯЄІЇ\'\.\,\-\s]+)\).*"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            // trace!("> if5");
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* [0-9]+\s*АК?)\s*\((?P<locality>[а-яєіїА-ЯЄІЇ\'\.\,\-\s]+)\).*"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            // trace!("> if5");
            break '_capt;
        }
        '_if: {
            lazy_static! {
                // УКХ р/м 5 сб 112 мсп МР 1 АК КЕРМЕНЧИК
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .* [0-9]+\s*АК?)\s*(?P<locality>[А-ЯЄІЇ\'\.\,\-\s]*).*"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            // trace!("> if4");
            break '_capt;
        }
        '_if: {
            // trace!("> line6: {line}");
            lazy_static! {
                static ref RE: Regex =
                    Regex::new(r#"(?P<unit>УКХ .* [0-9]+\s*АК?\s*)"#).unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            line = unit;
            // trace!("> if6");
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .*)\(район (?P<locality>[А-ЯЄІЇ'\s]+(-[А-ЯЄІЇ'\s]+)*)\)"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>УКХ .*), між (?P<locality>[А-ЯЄІЇ',\.\-\s]+)"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>.*)\((?P<locality>[А-ЯЄІЇ',\.\-\s]+)\)"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex = Regex::new(
                    r#"(?P<unit>.*)(?P<locality> [А-ЯЄІЇ'\s]+-[А-ЯЄІЇ'\s]+)"#
                )
                .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex =
                    Regex::new(r#"\d{2}\.\d{2}\.\d{2,4}\s+(?P<unit>[^(]+)\((район\w*\s*)?(?P<locality>[А-ЯЄІЇ'\s]+).*\)"#)
                        .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        '_if: {
            lazy_static! {
                static ref RE: Regex =
                    Regex::new(r#"(?P<unit>.*)(?P<locality>\s[А-ЯЄІЇ]{4}[А-ЯЄІЇ',\.\-\s]+)"#)
                        .unwrap();
            }
            let Some(capts) = RE.captures(&line) else {
                break '_if;
            };
            let Some(unit) = m_cap_s(&capts, "unit") else {
                break '_if;
            };
            locality = m_cap_s(&capts, "locality");
            line = unit;
            break '_capt;
        }
        // trace!("> line2: {line}");
        '_if: {
            // cut off suffix "УКХ радіомережа н\в підрозділу НОВОДОНЕЦЬКЕ-НОВОМАЙОРСЬКЕ	01:47			415.2500	"- Перо-1, Перо-2 по нулям"
            lazy_static! {
                static ref RE_TIMESTAMP: Regex =
                    Regex::new(r#"(?P<timestamp>\d\d:\d\d)"#).unwrap();
            }
            let Some(capts) = RE_TIMESTAMP.captures(&line) else {
                break '_if;
            };
            let Some(timestamp) = m_cap_s(&capts, "timestamp") else {
                break '_if;
            };
            let ms: Vec<_> = line.match_indices(&timestamp).collect();
            if !ms.is_empty() {
                let match_index = ms[0].0;
                line = byte_substr(&line, 0, match_index)?;
            }
        }
        '_if: {
            // cut off "18:38	463.3000	УКХ радіомережа управління підрозділу 2 мсб 37 омсбр 36 армії	КЕРМЕНЧИК	- на приеме"
            lazy_static! {
                static ref RE_TIMESTAMP: Regex =
                    Regex::new(r#"...............................*(?P<locality>[А-ЯЄІЇ]+)(?P<junk>\s+.*)"#).unwrap();
                static ref RE_THREE_CAPS: Regex =
                    Regex::new(r#"[А-Я][А-Я][А-Я]"#).unwrap();
            }
            let Some(capts) = RE_TIMESTAMP.captures(&line) else {
                break '_if;
            };
            let Some(junk) = m_cap_s(&capts, "junk") else {
                break '_if;
            };
            let ms: Vec<_> = line.match_indices(&junk).collect();
            // see extract_unit_08
            if RE_THREE_CAPS.captures(&junk).is_some() {
                break '_if;
            };
            if !ms.is_empty() {
                let match_index = ms[0].0;
                line = byte_substr(&line, 0, match_index)?;
            }
        }
    };
    Ok((line, locality))
}

fn maybe_single_locality(
    line: String,
    prefix_required: bool,
    callsigns: &Vec<String>,
) -> Option<String> {
    lazy_static! {
        static ref RE_LOC_SINGLE: Regex =
            Regex::new(r#"^[А-ЯІЇ'\.\-,]{4,}$"#).unwrap();
        static ref PREFIX_RE: Regex = RegexBuilder::new(
            r#"(район|р-н|рай\.|р-н\.|біля|ймов\.|ймовірно|Напрямок:)"#
        )
        .case_insensitive(true)
        .build()
        .expect("Invalid Regex");
    }
    let line_trimmed = line.trim();
    if line.is_empty() {
        return None;
    }
    if line.contains(" ") {
        if let Some(first_word) =
            line_trimmed.split(" ").collect_vec().into_iter().next()
        {
            if PREFIX_RE.is_match(first_word) {
                return Some(line); // zaporizhzhya style of location string
            }
        }
    }
    let line = if PREFIX_RE.is_match(&line) {
        PREFIX_RE.replace(&line, " ").to_uppercase()
    } else {
        if prefix_required {
            return None;
        }
        line
    };
    let line = line.trim();
    if RE_LOC_SINGLE.is_match(line) {
        for rec in callsigns {
            if line.to_uppercase().contains(&rec.to_uppercase()) {
                return None;
            }
        }
        Some(String::from(line))
    } else {
        None
    }
}

fn is_unit_and_loc_line(
    line: &String,
    l: String,
    ltrim: &str,
) -> Result<bool, AppError> {
    Ok(l.contains("управління")
        || ltrim.starts_with("укх")
        || (l.contains("укх") && !has_date(line)?)
        || l.contains("мсб")
        || l.contains("омсбр")
        || l.contains("загін")
        || ltrim.starts_with("dmr")
        || (l.contains("dmr") && !has_date(line)?)
        || l.contains("укх радіомережа")
        || l.contains("укх р/м")
        || has_unit(line))
}

fn try_process_kharkiv_style_unit_and_locality(
    mut lines: Vec<String>,
) -> Vec<String> {
    // Kharkiv style unit and locality
    if lines.len() >= 2
        && lines[1].trim().starts_with("(")
        && lines[0].trim().starts_with("УКХ")
    {
        let mut new_slice =
            vec![[lines[0].clone(), lines[1].clone()].join(" ")];
        new_slice.extend(lines);
        lines = new_slice;
    }
    lines
}

//commintify style - goes with useless first 2 lines
fn try_remove_commintify_header(lines: Vec<String>) -> Vec<String> {
    let mut lines = lines;
    let mut trim = None;
    if !lines.is_empty() && lines[0].trim().starts_with("Отримано з поста")
    {
        trim = Some(0)
    }
    if lines.len() > 1 && lines[1].trim().starts_with("Отримано з поста")
    {
        trim = Some(1)
    }
    if let Some(mut idx) = trim {
        if let Some(line) = lines.get(idx + 1) {
            if line.trim().starts_with("--------------------------------") {
                idx += 1;
            }
        }
        lines.remove(idx);
        while idx > 0 {
            idx -= 1;
            lines.remove(idx);
        }
    }
    lines
}

fn try_extract_jf_unit_and_location(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    inp: &str,
    m_aor_id: Option<i64>,
) -> Result<Option<UnitAndLoc>, AppError> {
    lazy_static! {
        static ref RE_JF_HEADER: Regex = RegexBuilder::new(
            r#"(?iu)\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}.*?\b(?:противник\p{L}*|підрозділ\p{L}*|груп\p{L}*)\b\s+(?P<unit>.+?)\s+(?P<location>(?-i:[А-ЯІЇЄҐ][А-ЯІЇЄҐ.\s\-]*[А-ЯІЇЄҐ.]))\s*(?:$|\(.*$)"#
        )
        .build()
        .unwrap();
        static ref RE_UNIT_CHAIN: Regex =
            Regex::new(r#"(?iu)\d+\s*\p{L}{1,10}(?:\s+\d+\s*\p{L}{1,12})*"#)
                .unwrap();
        static ref RE_JF_UNIT_PREFIX: Regex = RegexBuilder::new(
            r#"^(?:зі|із)\s+складу\s+"#
        )
        .case_insensitive(true)
        .build()
        .unwrap();
    }
    let Some(first_line) = inp.lines().find(|line| !line.trim().is_empty())
    else {
        return Ok(None);
    };
    let Some(capts) = RE_JF_HEADER.captures(first_line) else {
        return Ok(None);
    };
    let Some(unit_raw) = m_cap_s(&capts, "unit") else {
        return Ok(None);
    };
    let unit_raw = RE_JF_UNIT_PREFIX
        .replace(unit_raw.trim(), "")
        .trim()
        .to_string();
    let units = crate::unit::parse_library_unit(&unit_raw);
    let parsed_unit = units
        .iter()
        .filter(|value| value.chars().any(|ch| ch.is_ascii_digit()))
        .max_by_key(|value| value.len())
        .cloned();
    let jf_chain_unit = extract_jf_unit_chain(&unit_raw, &RE_UNIT_CHAIN);
    let unit = [parsed_unit, jf_chain_unit]
        .into_iter()
        .flatten()
        .max_by_key(|value| value.len())
        .unwrap_or(unit_raw);
    let locality = m_cap_s(&capts, "location")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (locality, locality_v2) = extract_locality(
        settlements.clone(),
        inp.to_string(),
        locality,
        m_aor_id,
    )?;
    Ok(Some(UnitAndLoc {
        unit: Some(unit),
        locality,
        locality_v2,
    }))
}

fn extract_jf_unit_chain(
    unit_raw: &str,
    re_unit_chain: &Regex,
) -> Option<String> {
    let unit_chain_match = re_unit_chain
        .find_iter(unit_raw)
        .max_by_key(|value| value.as_str().len())?;
    let unit_chain = unit_chain_match.as_str().trim().to_string();
    let m_prefix_unit = unit_raw[..unit_chain_match.start()]
        .split_whitespace()
        .last()
        .map(|value| {
            value
                .trim_matches(|ch: char| !ch.is_alphanumeric())
                .to_string()
        })
        .filter(|value| !value.is_empty())
        .filter(|value| is_known_unit_token(&value.to_lowercase()));
    Some(match m_prefix_unit {
        Some(prefix_unit) => format!("{prefix_unit} {unit_chain}"),
        None => unit_chain,
    })
}

fn is_known_unit_token(unit_name: &str) -> bool {
    crate::unit::const_units::list_companies().contains(unit_name)
        || crate::unit::const_units::list_battalions().contains(unit_name)
        || crate::unit::const_units::list_regiments().contains(unit_name)
        || crate::unit::const_units::list_divisions().contains(unit_name)
        || crate::unit::const_units::list_armies().contains(unit_name)
        || crate::unit::const_units::list_named_unit_names().contains(unit_name)
        || crate::unit::const_units::list_standalone()
            .iter()
            .any(|value| value == unit_name)
}

fn try_extract_pu_fsb_rf_unit_and_location(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    inp: &str,
    m_aor_id: Option<i64>,
) -> Result<Option<UnitAndLoc>, AppError> {
    lazy_static! {
        static ref RE: Regex = RegexBuilder::new(
            r#"^(?P<unit>.*?\bПУ\s+ФСБ\s+РФ\b)\s*/\s*(?P<locality>район\s+.+?)(?:\s+\([0-9]{2}\.[0-9]{2}\))?\s*$"#
        )
        .case_insensitive(true)
        .build()
        .unwrap();
    }
    let Some(line) = inp.lines().find(|line| !line.trim().is_empty()) else {
        return Ok(None);
    };
    let Some(capts) = RE.captures(line.trim()) else {
        return Ok(None);
    };
    let Some(unit) = m_cap_s(&capts, "unit") else {
        return Ok(None);
    };
    let Some(locality) = m_cap_s(&capts, "locality") else {
        return Ok(None);
    };
    let unit = unit.trim().to_string();
    let locality = locality.trim().to_string();
    let (locality, locality_v2) = extract_locality(
        settlements,
        line.to_string(),
        Some(locality),
        m_aor_id,
    )?;
    Ok(Some(UnitAndLoc {
        unit: Some(unit),
        locality,
        locality_v2,
    }))
}

pub(crate) fn try_extract_report_125_unit(inp: &str) -> Option<String> {
    if !looks_like_report_125_unit_body(inp) {
        return None;
    }

    lazy_static! {
        static ref RE: Regex =
            Regex::new(r#"(?m)^\s*Назва:\s*(?P<unit>.*?)\s*;?\s*$"#).unwrap();
    }
    RE.captures(inp)
        .and_then(|capts| m_cap_s(&capts, "unit"))
        .map(|unit| unit.trim().trim_start_matches('!').trim().to_string())
        .filter(|unit| !unit.is_empty())
}

fn looks_like_report_125_unit_body(inp: &str) -> bool {
    let inp_lower = inp.to_lowercase();
    if inp_lower.contains("умовні координати для бота") {
        return true;
    }

    lazy_static! {
        static ref COORDS_RE: Regex = RegexBuilder::new(
            r#"(?m)^\s*(?:Координати|Умовні\s+координати|Условні\s+координати)(?:\s*\(MGRS\))?:\s*(?:(?:MGRS\s*)?\d{1,2}\p{L}\s+\p{L}{2}\s+\d{1,5}\s+\d{1,5}|кут\s*\d+(?:[\.,]\d+)?)\s*;?\s*$"#
        )
        .case_insensitive(true)
        .build()
        .unwrap();
        static ref FREQ_RE: Regex =
            RegexBuilder::new(r#"(?m)^\s*Частота\s*:"#)
                .case_insensitive(true)
                .build()
                .unwrap();
        static ref TECH_FIELD_RE: Regex = RegexBuilder::new(
            r#"(?m)^\s*(Кут|Період\s+слідування|Тривалість\s+імпульсу)\s*(\(|:)"#
        )
        .case_insensitive(true)
        .build()
        .unwrap();
    }

    COORDS_RE.is_match(inp)
        && FREQ_RE.is_match(inp)
        && TECH_FIELD_RE.is_match(inp)
}

fn try_extract_standard_unit_and_location(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    inp: &str,
    m_aor_id: Option<i64>,
) -> Result<Option<UnitAndLoc>, AppError> {
    '_if: {
        // parses format like: Підрозділ: УКХ р/м невизначеного підрозділу;
        lazy_static! {
            static ref REU: Regex =
                Regex::new(r#"(Підрозділ|Приналежність підрозділу): (?P<unit>[^;\n]*);?\s+"#).unwrap();
        }
        lazy_static! {
            static ref REL: Regex = Regex::new(
                r#"(Район|Локація|Напрямок|Місце розташування): (?P<location>[^;\n]*);?"#
            )
            .unwrap();
        }

        let Some(capts) = REU.captures(inp) else {
            break '_if;
        };
        let Some(unit) = m_cap_s(&capts, "unit") else {
            break '_if;
        };
        let locality = REL.captures(inp).map(|capts| {
            m_cap_s(&capts, "location").unwrap().trim().to_string()
        });
        let (locality, locality_v2) = extract_locality(
            settlements.clone(),
            inp.to_string(),
            locality,
            m_aor_id,
        )?;
        return Ok(Some(UnitAndLoc {
            unit: Some(unit.trim().to_string()),
            locality,
            locality_v2,
        }));
    };
    Ok(None)
}

/// check if line has date in format dd.mm.yyyy
fn has_date(s: &str) -> Result<bool, AppError> {
    lazy_static! {
        static ref RE: Regex = Regex::new(r#"\d{2}\.\d{2}\.\d{4}"#).unwrap();
    }
    Ok(RE.is_match(s))
}

fn remove_first_occurrence(text: &str, char_to_remove: char) -> String {
    let mut result = String::new();
    let mut found = false;

    for char in text.chars() {
        if char == char_to_remove && !found {
            found = true;
            continue; // Skip adding this character to the result
        }
        result.push(char);
    }
    result
}

pub fn try_extract_comm_operator(body: &str) -> Option<String> {
    let lines = body
        .lines()
        .filter(|l| l.trim() != "")
        .map(|s| s.trim())
        .map(|x| x.to_string())
        .collect::<Vec<String>>();

    let range = 0..lines.len() as i32;

    for (index, line) in lines.iter().enumerate() {
        if line.starts_with("--------------------------------------")
            && range.contains(&(index as i32 - 1))
        {
            if let Some(minus_one) = lines.get(index - 1) {
                if minus_one.starts_with("Отримано з поста")
                    && range.contains(&(index as i32 - 2))
                {
                    if let Some(minus_two) = lines.get(index - 2) {
                        return Some(minus_two.to_string());
                    }
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::location::types::Language;
    use crate::location::SettlementDetails;
    use crate::unit::parse_library_unit;
    use std::collections::BTreeMap;

    fn test_settlements() -> Arc<RwLock<crate::location::SettlementsDataConfig>>
    {
        let config = crate::config::read_config(Mode::Test).unwrap();
        Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ))
    }

    #[test]
    fn extract_unit_report_125_sample_name() {
        let body = r#"16.07.2026 11:34:32
Назва: А-50 (А-50У) РЛС з РТК «Шмєль-М»;
Умовні координати для бота: MGRS 37U DR 32515 05505;
Кут: 79.6;
Частота: 3330;"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(
            res.unit.as_deref(),
            Some("А-50 (А-50У) РЛС з РТК «Шмєль-М»")
        );
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_report_125_plain_coords_sample_name() {
        let body = r#"15.07.2026 11:33:26
Назва: Су-35;
Координати: MGRS 37U DR 37120 30872;
Частота: 9052-9060;
Період слідування (Ti,мкс): 5; 7; 16; 11;
Тривалість імпульсу (τi,мкс): 1.8; 0.3; 1.9; 1.5;
---------- ☿ Oscar_VR ☿ ----------"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(res.unit.as_deref(), Some("Су-35"));
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_report_125_name_keeps_internal_semicolon() {
        let body = r#"15.07.2026 11:33:26
Назва: КІ РЛС ЛЧМ (17; 9 Тп);
Координати: MGRS 37U DR 37120 30872;
Частота: 9052-9060;
Період слідування (Ti,мкс): 5; 7; 16; 11;"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(res.unit.as_deref(), Some("КІ РЛС ЛЧМ (17; 9 Тп)"));
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_report_125_buk_radar_sample_name() {
        let body = r#"10.07.2026 11:36:17
Назва: РЛС СВУ 9А317М ЗРК “Бук-М2”;
Координати: MGRS 37U DR 14916 32628;
Частота: 5622;
Період слідування (Ti,мкс): 437; 443;
Тривалість імпульсу (τi,мкс): 1.2; 1.4;
---------- ☿ Oscar_VR ☿ ----------"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(res.unit.as_deref(), Some("РЛС СВУ 9А317М ЗРК “Бук-М2”"));
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_report_125_gps_jamming_sample_name() {
        let body = r#"09.07.2026 13:14:25
Назва: РНС GPS (подавлення супутникової навігації);
Координати: MGRS 37U DR 10539 22836;
Частота: 1201-1208;
Період слідування (Ti,мкс): 12; 14; 11; 10; 17;
Тривалість імпульсу (τi,мкс): 0.5; 0.3;
---------- ☿ Oscar_VR ☿ ----------"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(
            res.unit.as_deref(),
            Some("РНС GPS (подавлення супутникової навігації)")
        );
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_report_125_conditional_coords_sample_name() {
        let body = r#"09.07.2026 12:03:21
Назва: РЛС 9С35М ЗРК “Бук-М1”;
Кут 90.9;
Условні координати: MGRS 37U DR 57187 13149;
Частота: 6779;
Період слідування (Ti,мкс): 966; 14; 2027; 941; 1059;
Тривалість імпульсу (τi,мкс): 27; 9; 95; 5; 6;
---------- ☿ Oscar_VR ☿ ----------"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(res.unit.as_deref(), Some("РЛС 9С35М ЗРК “Бук-М1”"));
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_report_125_strips_name_exclamation_marks() {
        let body = r#"08.07.2026 12:26:40
Назва: !!!!!48Я6-К1 «Подлет-К1»;
Координати: кут 107.3;
Частота: 2850;
Період слідування (Ti,мкс): 564; 493; 229; 215;
Тривалість імпульсу (τi,мкс): 1.1; 0.7;
---------- ☿ Oscar_VR ☿ ----------"#;
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(res.unit.as_deref(), Some("48Я6-К1 «Подлет-К1»"));
        assert_eq!(res.locality, None);
    }

    #[test]
    fn extract_unit_does_not_treat_antenna_name_as_report_125_unit() {
        let body = "Тип: Антена\nНазва: 141.715 МГц\n24.06.2026 17:32\nКоординати: 36U XB 66512 50880";
        let res = extract_unit(test_settlements(), body, vec![]).unwrap();
        assert_eq!(res.unit, None);
    }

    #[test]
    fn extract_unit_01() {
        let body = r#"
30.03.2023_20:50 F=420,4250(МГц)
управління мсб 60 омсбр РХБЗ 5 ЗА (МАКАРІВКА, НЕСКУЧНЕ)
МУЗЫКАНТ
НВ (НВ)
"- На 22-й скажите, что крестики-нолики - работают
- (НВ) Я на 420-й разговариваю, так что не переживай"
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "управління мсб 60 омсбр РХБЗ 5 ЗА".to_string()
        );
        assert_eq!(res.locality.unwrap(), "МАКАРІВКА, НЕСКУЧНЕ".to_string());
        assert_eq!(
            vec!["60 омсбр рхбз 5 за"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_02() {
        let body = r#"
54191: 09:11    F= 455.4875     УКХ р/м управління 177 опмп бв КаФл  (ДОРОЖНЯНКА. КОСТЯНТИНІВКА. РЕШЕТИЛІВСЬКЕ)

        -Кольцо 22 воздух СИНИЙ
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління 177 опмп бв КаФл".to_string()
        );
        assert_eq!(
            res.locality.unwrap(),
            "ДОРОЖНЯНКА. КОСТЯНТИНІВКА. РЕШЕТИЛІВСЬКЕ".to_string()
        );
        assert_eq!(
            vec!["177 опмп кафл"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_03() {
        let body = r#"
11.04.23 08:25:42> 11.04.23 07:38:02 460,3500 Остановись где нибудь я сейчас подеду к тебе и обясню как принял ? [Мережа: УКХ р/м управління 1 мсб 4 ВБ ВАСИЛІВКА]
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м управління 1 мсб 4 ВБ");
        assert_eq!(res.locality.unwrap(), "ВАСИЛІВКА".to_string());
        assert_eq!(vec!["1 мсб 4 вб"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_04() {
        let body = r#"
14.04.2023_15:01 F=148,4000(МГц)
УКХ р/м управління 4 ВБ 58 А (КАМ'ЯНСЬКЕ) ((КАМ'ЯНСЬКЕ))
КЛЁН (НВ)
ОСТРОВ (НВ)
"-Осторв я Клён приём
-Клён: 4-4. прикратилось по этогу 5-ть. деревяв...
-Остров:прийнял"
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м управління 4 ВБ 58 А");
        assert_eq!(res.locality.unwrap(), "КАМ'ЯНСЬКЕ".to_string());
        assert_eq!(vec!["4 вб 58 а"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_05() {
        let body = r#"141.115
14:39:30 П64 . УКХ р/м мсб на АТ 503 мсп 19 мсд 58 ЗА (МИРНЕ)
НВ
МИХАЛЫЧ
- 73 - 73 - МИХАЛЫЧ спрашивает дальшие его действия - куда и че
2.- .................так я откуда знаю .....
1.- михалыч михалыч - вышел на 71й  вот и он сказал - я не знаю вы все делали ? или нет вы "#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м мсб на АТ 503 мсп 19 мсд 58 ЗА");
        assert_eq!(res.locality.unwrap(), "МИРНЕ".to_string());
        assert_eq!(
            vec!["503 мсп 19 мсд 58 за"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_06() {
        let body = r#""30.05.2023	УКХ радіомережа н\в підрозділу НОВОДОНЕЦЬКЕ-НОВОМАЙОРСЬКЕ	01:47			415.2500	"- Перо-1, Перо-2 по нулям
- ...
- Рубеж-1, Рубеж-2 по нулям"	(перевірка обстановки)"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"УКХ радіомережа н\в підрозділу"#);
        assert_eq!(
            res.locality.unwrap(),
            "НОВОДОНЕЦЬКЕ-НОВОМАЙОРСЬКЕ".to_string()
        );
        assert_eq!(
            Vec::<String>::new(),
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_07() {
        let body = r#""18:38	463.3000	УКХ радіомережа управління підрозділу 2 мсб 37 омсбр 36 армії	КЕРМЕНЧИК	- на приеме
- Искра Байкалу прием"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ радіомережа управління підрозділу 2 мсб 37 омсбр 36 армії"#
        );
        assert_eq!(res.locality.unwrap(), "КЕРМЕНЧИК".to_string());
        assert_eq!(
            vec!["2 мсб 37 омсбр 36 армії"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_08() {
        let body =
            r#"УКХ р/м гсабатр гсадн 70 мсп 42 мсд 58 А (ТАРАСІВКА - ПОЛОГИ)"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м гсабатр гсадн 70 мсп 42 мсд 58 А"#
        );
        assert_eq!(res.locality.unwrap(), "ТАРАСІВКА - ПОЛОГИ".to_string());
        assert_eq!(
            vec!["70 мсп 42 мсд 58 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_10() {
        let body = r#"УКХ радіомережа невизначеного підрозділу в районі населених пунктів       БЛАГОДАТНЕ - УРОЖАЙНЕ   -если человека одного ос"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ радіомережа невизначеного підрозділу в районі населених пунктів"#
        );
        assert_eq!(res.locality.unwrap(), "БЛАГОДАТНЕ - УРОЖАЙНЕ".to_string());
        assert_eq!(
            Vec::<String>::new(),
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_11() {
        let body =
            r#"УКХ р/м підрозділу із складу 64 омсбр 35 А (н.п. Дорожнянка)"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м підрозділу із складу 64 омсбр 35 А"#
        );
        assert_eq!(res.locality.unwrap(), "Дорожнянка".to_string());
        assert_eq!(
            vec!["64 омсбр 35 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_12() {
        let body = r#"УКХ р/м управління мсб зі складу 5сб 123сп МР 1 АК"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м управління мсб зі складу 5сб 123сп МР 1 АК"#
        );
        assert_eq!(res.locality, None);
        assert_eq!(
            vec!["5 сб 123 сп 1 ак"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_13() {
        let body = r#"УКХ р/м 5 сб 112 мсп МР 1 АК КЕРМЕНЧИК"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"УКХ р/м 5 сб 112 мсп МР 1 АК"#);
        assert_eq!(res.locality.unwrap(), "КЕРМЕНЧИК".to_string());
        assert_eq!(
            vec!["5 сб 112 мсп 1 ак"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_14() {
        let body = r#"УКХ р/м управління стрілецькими підрозділами припустимо зі складу 1113 сп МР 1 АК (північніше ПОЛОГИ)"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м управління стрілецькими підрозділами припустимо зі складу 1113 сп МР 1 АК"#
        );
        assert_eq!(res.locality.unwrap(), "ПОЛОГИ".to_string());
        assert_eq!(
            vec!["1113 сп 1 ак"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_15() {
        let body = r#"162.355П64.
18:33:53 УКХ р/м реадн 70 мсп 42 мсд 58 А
НВ
НВ
— 818. 82. 5. 37. Как приняли прием?
— Да, плюс!
— 5. Собщи.
— Борный 34. Просто скажи."#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"УКХ р/м реадн 70 мсп 42 мсд 58 А"#);
        assert_eq!(res.locality, None);
        assert_eq!(
            vec!["70 мсп 42 мсд 58 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_16() {
        let body =
            r#"УКХ р/м 1 мсб 70 мсп 42 мсд 58 А (ПАВЛІВСЬКЕ, НОВОФЕДОРІВКА)"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"УКХ р/м 1 мсб 70 мсп 42 мсд 58 А"#);
        assert_eq!(
            res.locality.unwrap(),
            "ПАВЛІВСЬКЕ, НОВОФЕДОРІВКА".to_string()
        );
        assert_eq!(
            vec!["1 мсб 70 мсп 42 мсд 58 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_17() {
        let body = r#"УКХ р/м управління 1 мсб 38 омсбр 35 А (півд. МИРНЕ);"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м управління 1 мсб 38 омсбр 35 А"#
        );
        assert_eq!(res.locality.unwrap(), "МИРНЕ".to_string());
        assert_eq!(
            vec!["1 мсб 38 омсбр 35 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_18() {
        let body = r#"30.05.23 13:11 \\ 438.500 УКХ р/м управління 5 сб 112 осп (131 сп) МР, 4 осб ТрО 110 омсбр (район н.п. Новодонецьке – Новомайорське		"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м управління 5 сб 112 осп (131 сп) МР, 4 осб ТрО 110 омсбр"#
        );
        assert_eq!(
            res.locality.unwrap(),
            "Новодонецьке – Новомайорське".to_string()
        );
        assert_eq!(
            vec!["5 сб 112 осп", "131 сп", "4 осб 110 омсбр"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_19() {
        let body = r#"2024.02.23
17:40:12
442.6250
ВІЛЬНЕ-КРЕМЕНЧИК
УКХ р/м управління йм. 116 осп

Перевал,Титан

- Перевал я Титан прием
- На связи
- Перевал я Титан по Лире возможность есть?
- Да принял сейчас наберу

(виклик на звязок)
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"УКХ р/м управління йм. 116 осп"#);
        assert_eq!(res.locality.unwrap(), "ВІЛЬНЕ-КРЕМЕНЧИК".to_string());
        assert_eq!(vec!["116 осп"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_20() {
        let body = r#"23:13
30.10.2024
159.250
1 мсб 123 омсбр
р-н Берестове-Спірне
1. 100-й (йм. вузол зв'язку 1 мсб 123 омсбр), 100-й Борзому (йм. бойовик зі складу 1 мсб 123 омсбр)
2. Давай быстренько, в норку
1. Да, да, плюс"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"1 мсб 123 омсбр"#);
        assert_eq!(res.locality.unwrap(), "р-н Берестове-Спірне".to_string());
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["БЕРЕСТОВЕ", "СПІРНЕ"]);
    }

    #[test]
    fn extract_unit_21() {
        let body = r#"Отримано з поста " П3 "Вікінг""
--------------------------------------
30.10, 23:03:53
411.7500
(йм. підрозділ БпЛА 114 мсп 127 мсд 5 А)(р-н Любимівка - Орлинське)
ФУГАС
АНТЕЙ, ПТИЦА

— Антей, Антей, я Фугас, прием.
--На приеме.
--Зеленая села. Короче, жестко Моросило видео, но скорее всего попадание.
— Антей, я Фугас, прием.
--На приеме.
--И короче, я там круги делал, там вышка есть высокая, прям такая, ее прям в темноте, прям четко видно было.  "#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"йм. підрозділ БпЛА 114 мсп 127 мсд 5 А(р-н Любимівка - Орлинське)"#
        );
        assert_eq!(
            res.locality.unwrap(),
            "йм. підрозділ БпЛА 114 мсп 127 мсд 5 А(р-н Любимівка - Орлинське)"
                .to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ЛЮБИМІВКА", "ОРЛИНСЬКЕ"]);
        assert_eq!(
            vec!["114 мсп 127 мсд 5 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_22() {
        let body = r#"Отримано з поста " П3 "Вікінг""
--------------------------------------
30.10, 22:42:52
420.7500
(р-н Пн. Захід від ПРИЮТНЕ)
НВ
НВ

— По полю, откуда, с севера? Если что, светлячки запускай Андрюха сразу."#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit, None);
        assert_eq!(
            res.locality.unwrap(),
            "р-н Пн. Захід від ПРИЮТНЕ".to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ПРИЮТНЕ"]);
    }

    #[test]
    fn extract_unit_23() {
        let body = r#"30.10, 23:58:52
413.4150
13 зсб 252 мсп (урочище Новоєгорівка - Долгоє)
СПУТНИК
МАГАДАН

— Магадан, спутнику на прием.


Коментар: том
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "13 зсб 252 мсп (урочище Новоєгорівка - Долгоє)"
        );
        assert_eq!(
            res.locality.unwrap(),
            "13 зсб 252 мсп (урочище Новоєгорівка - Долгоє)".to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ДОЛГОЄ", "НОВОЄГОРІВКА"]);
        assert_eq!(
            vec!["13 зсб 252 мсп"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_24() {
        let body = r#"Отримано з поста "Rabbit_1"
--------------------------------------
30.10, 23:58:36
155.7375
УКХ р/м НВ підрозділу (DMR) (р-н н.п. Володимирівка - Попів ліс) (28.10.2024)
КОРОБКА
75Й

— 75й, я Коробка, у нас 0 3."#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м НВ підрозділу (DMR) (р-н н.п. Володимирівка - Попів ліс)"
        );
        assert_eq!(res.locality.unwrap(), "УКХ р/м НВ підрозділу (DMR) (р-н н.п. Володимирівка - Попів ліс) (28.10.2024)".to_string());
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ВОЛОДИМИРІВКА"]);
        assert_eq!(
            Vec::<String>::new(),
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_25() {
        let body = r#"Отримано з поста "Tarik"
--------------------------------------
30.10, 23:56:37
444.5500
УКХ р/м пн. сх. н.п. Веріговка 8 мсб 27 омсбр ймовірно арт. батарєя 444.550 МГц 06.09.24 50,2090 37,6695 \ 50,2061 37,6612
НВ
НВ

— Слышу и разбираю на 5. Только учти, что говорить надо первый второму
— Принял.
— Если вызываю я тебя, то я говорю Второй Первому."#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м пн. сх. н.п. Веріговка 8 мсб 27 омсбр ймовірно\u{a0}арт.\u{a0}батарєя 444.550 МГц 06.09.24 50,2090 37,6695 \\ 50,2061 37,6612");
        assert_eq!(res.locality.unwrap(), "УКХ р/м пн. сх. н.п. Веріговка 8 мсб 27 омсбр ймовірно\u{a0}арт.\u{a0}батарєя 444.550 МГц 06.09.24 50,2090 37,6695 \\ 50,2061 37,6612".to_string());
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ВЄРІГОВКА"]);
        assert_eq!(
            vec!["8 мсб 27 омсбр"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_26() {
        let body = r#"30-10 23:38:43
162.975
УКХ Варяг (р/м НВ підрозділу (р-н н.п. Цаповка, Бєлгородська обл.))
НВ
НВ

– Взрыв на 2 часа, похоже сброс.

Коментар: T4"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"УКХ Варяг (р/м НВ підрозділу"#);
        assert_eq!(
            res.locality.unwrap(),
            "Цаповка, Бєлгородська обл.)".to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["БЄЛГОРОДКА", "ХАПОВКА"]);
        assert_eq!(
            Vec::<String>::new(),
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_27() {
        let body = r#"AxelFox511_РЧ
31.10, 00:01:01
441.6500
УКХ р/м управління сб 103 осп район пд.-сх. окол. Торецьк
НВ
НВ
"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м управління сб 103 осп район пд.-сх. окол. Торецьк"#
        );
        assert_eq!(
            res.locality.unwrap(),
            "УКХ р/м управління сб 103 осп район пд.-сх. окол. Торецьк"
                .to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ТОРЕЦЬК"]);
        assert_eq!(vec!["103 осп"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_28() {
        let body = r#"23:59
30.10.2024
416.550
йм. 1 мсб 85 омсбр
р-н Краснополівка-Федорівка
1. Кольцо, Кольцо, я Шахта 70 (доложить обстановку)
2. Орех 3 8 (обстановка нормальная)
3. Гипноз 38
1. Орех, Гипноз да. Колодец, 119-й, я Шахта 70
4. Колодец 38
5. 119-й 38
1. Колодец, Барвиха да, 119-й да"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"йм. 1 мсб 85 омсбр"#);
        assert_eq!(
            res.locality.unwrap(),
            "р-н Краснополівка-Федорівка".to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["КРАСНОПОЛІВКА", "ФЕДОРІВКА"]);
        assert_eq!(
            vec!["1 мсб 85 омсбр"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_29() {
        let body = r#"23:53
30.10.2024
145.355
123 омсбр
р-н Білогорівка-Берестове
1. 80, 80, я 24. 05, 43, 2, 238 (баба-яга). Я 24, прием."#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), r#"123 омсбр"#);
        assert_eq!(
            res.locality.unwrap(),
            "р-н Білогорівка-Берестове".to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["БІЛОГОРІВКА", "БЕРЕСТОВЕ"]);
        assert_eq!(vec!["123 омсбр"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_30() {
        let body = r#"
30.10, 23:59:35
408.8500
УКХ р/м НВ підрозділу йм. зі складу 7 омсбр (н-к БІЛОГОРІВКА(В)-ЗОЛОТАРІВКА)
НВ
НВ

— Сейчас увидишь. Присмотришься прям старый, твой дом, где вы раньше жили, будет прям в ту сторону, там, в тех посадках, там она отработала.\\\\Да, она прям над нами прошла. Скорее всего, может быть, сейчас еще прилетит.
— Ну нахуй, прям над нами, я бы не слышал.\\\\ Высоко, не высоко, слышишь.
— Она груженной была.
— Сколько там метров?"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            r#"УКХ р/м НВ підрозділу йм. зі складу 7 омсбр"#
        );
        assert_eq!(res.locality.unwrap(), "БІЛОГОРІВКА(В".to_string());
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["БІЛОГОРІВКА"]);
        assert_eq!(vec!["7 омсбр"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_31() {
        let body = r#"Отримано з поста "Л"
-------------------------------
УКХ р/м управління 901/902 полку особливого призначення фсвнг рф (район ОГІРЦЕВЕ-ГАТИЩЕ-ВОВЧАНСЬК)
08:21
МЕТРО
ОЛИМП 2
406.975
1. п\"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління 901/902 полку особливого призначення фсвнг рф"
                .to_string()
        );
        assert_eq!(res.locality, Some("ОГІРЦЕВЕ-ГАТИЩЕ-ВОВЧАНСЬК".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ВОВЧАНСЬК", "ГАТИЩЕ", "ОГІРЦЕВЕ"]);
    }

    #[test]
    fn extract_unit_32() {
        let body = r#"Ціль:0901/18
Час:17:44
Ідентифікація: Цифрова Радіостанція
Місце розташування: Новопрокопівка-Пшеничне
Координати: 36T YT 16058 52456
Частота: 445.439 МГц
Приналежність підрозділу: ймовірно 2 мсб 70 мсп 42 мсд 58 А
Радіус похибки: 1000 м"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "ймовірно 2 мсб 70 мсп 42 мсд 58 А".to_string()
        );
        assert_eq!(res.locality, Some("Новопрокопівка-Пшеничне".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["НОВОПРОКОПІВКА", "ПШЕНИЧНЕ"]);
    }

    #[test]
    fn extract_unit_33() {
        let body = r#"26.12, 23:48:55
421.0810
УКХ р/м НВ підрозділу(DMR), між ОЧЕРЕТИНЕ, КЕРАМІК
АЛТАЙ
АЛМАЗ"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м НВ підрозділу(DMR)".to_string());
        assert_eq!(res.locality, Some("ОЧЕРЕТИНЕ, КЕРАМІК".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["КЕРАМІК", "ОЧЕРЕТИНЕ"]);
    }

    #[test]
    fn extract_unit_34() {
        let body = r#"Отримано з поста "Л"
-------------------------------
УКХ р/м управління 901/902 полку особливого призначення фсвнг рф (район ОГІРЦЕВЕ-ГАТИЩЕ-ВОВЧАНСЬК)
08:21
МЕТРО
ОЛИМП 2
406.975
1. п\с"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління 901/902 полку особливого призначення фсвнг рф"
                .to_string()
        );
        assert_eq!(res.locality, Some("ОГІРЦЕВЕ-ГАТИЩЕ-ВОВЧАНСЬК".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ВОВЧАНСЬК", "ГАТИЩЕ", "ОГІРЦЕВЕ"]);
    }

    #[test]
    fn extract_unit_35() {
        let body = r#"Ціль:0901/18
Час:17:44
Ідентифікація: Цифрова Радіостанція
Місце розташування: Новопрокопівка-Пшеничне
Координати: 36T YT 16058 52456
Частота: 445.439 МГц
Приналежність підрозділу: ймовірно 2 мсб 70 мсп 42 мсд 58 А
Радіус похибки: 1000 м"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "ймовірно 2 мсб 70 мсп 42 мсд 58 А".to_string()
        );
        assert_eq!(res.locality, Some("Новопрокопівка-Пшеничне".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["НОВОПРОКОПІВКА", "ПШЕНИЧНЕ"]);
    }

    #[test]
    fn extract_unit_36() {
        let body = r#"31.12, 11:12:30
446.0134
УКХ р/м йм. гсабатр гсадн 30 мсп 72 мсд 44 АК (р-н Шебекіно) (наносять ВУ по м. Вовчанськ)
НВ
КЕНГУРУ

— Кенгуру 1 огонь
— Один огонь, да, принял."#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м йм. гсабатр гсадн 30 мсп\u{a0}72\u{a0}мсд\u{a0}44\u{a0}АК (р-н Шебекіно)".to_string());
        assert_eq!(res.locality, Some("ВУ по м. Вовчанськ".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ВОВЧАНСЬК"]);
    }

    #[test]
    fn extract_unit_37() {
        let body = r#"26.12, 23:48:55
421.0810
УКХ р/м НВ підрозділу(DMR), між ОЧЕРЕТИНЕ, КЕРАМІК
АЛТАЙ
АЛМАЗ"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "УКХ р/м НВ підрозділу(DMR)".to_string());
        assert_eq!(res.locality, Some("ОЧЕРЕТИНЕ, КЕРАМІК".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["КЕРАМІК", "ОЧЕРЕТИНЕ"]);
    }

    #[test]
    fn extract_unit_38() {
        let body = r#"Отримано з поста "П152"
--------------------------------------
28.11, 19:12:29
436.2550
(йм. 20 загін БАРС)(р-н Зх. від Красноселівка)
ЯМАЛ
БУТИК , ЛИМОН

— Лимон, Ямалу, Лимон, Ямалу, 6 6 6.
— Бутик, Ямалу, Бутик, Ямалу, 6 6."#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "йм. 20 загін БАРС(р-н Зх. від Красноселівка)".to_string()
        );
        assert_eq!(
            res.locality,
            Some("йм. 20 загін БАРС(р-н Зх. від Красноселівка)".to_string())
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["КРАСНОСЕЛІВКА"]);
    }

    #[ignore]
    #[test]
    fn extract_unit_39() {
        let body = r#"150.025
J
16:26
Az-155
УКХ радіомережа невизначеного підрозділу
околиці Новооєлизаветівки (уточнюється)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ радіомережа невизначеного підрозділу".to_string()
        );
        assert_eq!(
            res.locality,
            Some("околиці Новооєлизаветівки (уточнюється)".to_string())
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["Новооєлизаветівки"]);
    }

    #[ignore]
    #[test]
    fn extract_unit_40() {
        let body = r#"06.05, 17:57:54
446.0188
УКХ р/м управління артилерійською розвідкою ТАГр (ГАБатр ГАДн) 227 абр 49 ЗВА (КОЖУМ'ЯКИ - МАЛА ЛЕПЕТИХА)
НВ
НВ

— Юла 0 1. Шторм 333, Шторм 333."#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.locality, Some("УКХ р/м управління артилерійською розвідкою ТАГр (ГАБатр ГАДн) 227 абр 49 ЗВА (КОЖУМ'ЯКИ - МАЛА ЛЕПЕТИХА)".to_string()));
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["КОЖУМ’ЯКИ", "МАЛА ЛЕПЕТИХА"]);
        assert_eq!(res.unit.unwrap(), "УКХ р/м управління артилерійською розвідкою ТАГр (ГАБатр ГАДн) 227 абр 49 ЗВА".to_string());
    }

    #[test]
    fn extract_unit_buran_1() {
        let body = r#"Дата: 2024-02-21;
Частота: 408.500;
Локація: Авдіївка (йм. в напрямку Ласточкине);
Підрозділ: УКХ р/м невизначеного підрозділу;
Час: 17:28;
Хто: Змей;
Кому: Чёрный;
Текст:
- Чёрный я Змей ответь по керосину
- ..
- 3 мсб? правильно?;
.
Коментар: ( запит на зв'язок );"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м невизначеного підрозділу".to_string()
        );
        assert_eq!(
            res.locality.unwrap(),
            "Авдіївка (йм. в напрямку Ласточкине)".to_string()
        );
        assert_eq!(vec!["3 мсб"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_buran_2() {
        let body = r#"Час: 16:47
Дата: 23.02.2024
Частота: 412.300
Район: Піски Первомайське Водяне;
Підрозділ: УКХ р/м невизначеного підрозділу
Абоненти:
Позивні:

- выйди на мотор

( Запит на звязок)"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м невизначеного підрозділу".to_string()
        );
        assert_eq!(
            res.locality.unwrap(),
            "Піски Первомайське Водяне".to_string()
        );
        assert_eq!(0, parse_library_unit(&String::from(body)).len());
    }

    #[test]
    fn extract_unit_bug_26mar24() {
        let body = r#"26.03.2024_22:21 F=143.5000(МГц) DMRe П51
DMR управління вогнем гадн 70 мсп 42 мсд 58 А
НВ
НВ
- ГНЕЗДО, пополнения пришло, запиши.... остатки
- всего 37 14 маленьких 23 большых из них 14 корейцев
- да принял
- из них 11 импорт 14 нашых , все полные
- ...спасибо"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "DMR управління вогнем гадн 70 мсп 42 мсд 58 А".to_string()
        );
        assert_eq!(res.locality, None);
        assert_eq!(
            vec!["70 мсп 42 мсд 58 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_zlatopil() {
        let body = r#"Sudama
            Отримано з поста "П106 (Novozlatopil)"
            --------------------------------------
            21.10, 21:12:08
            481.7300
            УКХ р/м 1 мсб 114 мсп 127 мсд (захід ЧКАЛОВА)
            ЗАЯЦ
            БАЙКАЛ"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м 1 мсб 114 мсп 127 мсд".to_string()
        );
        assert_eq!(res.locality.unwrap(), "ЧКАЛОВА".to_string());
        assert_eq!(
            vec!["1 мсб 114 мсп 127 мсд"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_kharkiv() {
        let body = r#"УКХ р/м управління мінометної батареї зі складу 155 обр МП
( в районі СТРІЛЕЧА)
23:52	МАКИМАК	ЧЕРНЫЙ	444.363
1. Там как СОЧИ до тебя дотянуться, узнай у них обстановку, как, че, кто там остался, и выйдешь на меня.
2. да принял.
(Л)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління мінометної батареї зі складу 155 обр МП"
                .to_string()
        );
        assert_eq!(res.locality.unwrap(), "СТРІЛЕЧА".to_string());
        assert_eq!(vec!["155 обр"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_kharkiv_2() {
        let body = r#"УКХ р/м управління Шторм 155 обр МП
 (в районі північна частина дачного масиву ГЛИБОКЕ)
12:45 ПАТРИОТ ГЮРЗА 452.366 1. Ты из какого хазяйства
2. С 9го полка. Оказал ДОБРОМУ помощь… перебинтовал
1. А нгде находитесь сориентируй
2. Сейчас открою карту и скажу
1. Спроси у ДОБРОГО он должен знать где находится
2. Рядом с МЕДУЗОЙ по правой стороне, вся дорога в лепестках. Как принял?"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління Шторм 155 обр МП".to_string()
        );
        assert_eq!(res.locality.unwrap(), "ГЛИБОКЕ".to_string());
        assert_eq!("155 обр", parse_library_unit(&String::from(body))[0]);
    }

    #[test]
    fn extract_unit_kharkiv_3() {
        let body = r#"УКХ р/м управління мінометної батареї зі складу 155 обр МП
( в районі СТРІЛЕЧА)
23:40 ТУШКАН СКУПОЙ 444.363
1. ТУШКАН СКУПОМУ
1. ТУШКАН и БАБАЙ можете .. собираться вы сегодня днем пойдете вытаскивать 200-ых КРЕСТА
(Л)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління мінометної батареї зі складу 155 обр МП"
                .to_string()
        );
        assert_eq!(res.locality.unwrap(), "СТРІЛЕЧА".to_string());
        assert_eq!(vec!["155 обр"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_kharkiv_4() {
        let body = r#"25.08.2024 управління підрозділу зі складу 83 одшбу (район ТИХЕ) 17:28 БАТЯ СУББОТА ГАЛ 410.325
1. БАТЯ как слишиш, принимаеш...СУББОТА ГАЛУ, 105. БАТЯ я ГАЛ, проверка связи...СУББОТА я слишу...
(нов)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "управління підрозділу зі складу 83 одшбу".to_string()
        );
        assert_eq!(res.locality.unwrap(), "ТИХЕ".to_string());
        assert_eq!(vec!["83 одшбу"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_kharkiv_5() {
        let body = r#"УКХ р/м управління підрозділу противника
        (напрямок уточнюється)
        10:11 7-Й УРАЛ 446.875 1. Выстрел
        2. Выстрел да
        (3)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління підрозділу противника".to_string()
        );
        assert_eq!(res.locality, None);
        assert_eq!(0, parse_library_unit(&String::from(body)).len());
    }

    #[test]
    fn extract_unit_decorated_ukh_header_with_lowercase_location() {
        let body = "│🛑🌲УКХ р/м управління підрозділу йм. зі складу 3 мсб 82 мсп 69 мсд 6 ЗА (лісовий масив на захід від Вовчанська, Цегельне, Лиман, Симинівка) 🌲🛑";

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        let unit = res.unit.unwrap();
        assert!(unit.contains("3 мсб 82 мсп 69 мсд 6 ЗА"));
        let locality = res.locality.unwrap();
        assert!(locality.contains("Вовчанська"));
        assert!(locality.contains("Цегельне"));
        assert!(locality.contains("Лиман"));
        assert!(locality.contains("Симинівка"));
    }

    #[test]
    fn extract_unit_decorated_ukh_header_with_dash_location() {
        let body = "🌻🐺УКХ р/м підрозділу йм. зі складу 1 мсб 128 омсбр 44 АК  (ВОВЧАНСЬК - ВОВЧАНСЬКІ ХУТОРИ)🐺🌻";

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м підрозділу йм. зі складу 1 мсб 128 омсбр 44 АК"
                .to_string()
        );
        assert_eq!(
            res.locality.unwrap(),
            "ВОВЧАНСЬК - ВОВЧАНСЬКІ ХУТОРИ".to_string()
        );
    }

    #[test]
    fn extract_unit_zp_1() {
        let body = r#"21.10, 19:37:06
        403.1250
        УКХ р/м йм. управління гсадн 60 омсбр 5 А р-н ЛЮБИМІВКА 403.125 МГц
        НВ
        НВ

        — Люблю. Встреть на приеме. Минут 40. Сказали, надо будет подождать, может там с Поляной едет. Да, принял, ждем.
        — На внимании ли там? Да.
        "#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м йм. управління гсадн 60 омсбр 5 А".to_string()
        );
        assert_eq!(res.locality.unwrap(), "УКХ р/м йм. управління гсадн 60 омсбр 5 А р-н ЛЮБИМІВКА 403.125 МГц".to_string());
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ЛЮБИМІВКА"]);
        assert_eq!(
            vec!["60 омсбр 5 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_zp_2() {
        let body = r#"21.10.2024 19:00:43
            (УКХ р/м управління арт. Підрозділу ймовірно зі складу 36А
            (ймовірно, район: СОЛОДКОВОДНЕ))
            2-Й(НВ)
            22-Й(НВ)
            1. Слышим гул со стороны фронта, идет по стороне КПП.
            2. Да принял.
            (Спостереження за особовим складом/ОВТ СОУ)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління арт. Підрозділу ймовірно зі складу 36А"
                .to_string()
        );
        assert_eq!(
            res.locality.unwrap(),
            "            (ймовірно, район: СОЛОДКОВОДНЕ))".to_string()
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["СОЛОДКОВОДНЕ".to_string()]);
        assert_eq!(vec!["36 а"], parse_library_unit(&String::from(body)));
    }

    #[test]
    fn extract_unit_zp_3() {
        let body = r#"21.10.2024 20:47:04
            (УКХ р/м йм. управління гсадн зі складу 60 омсбр 5 А (район: ЛЮБИМІВКА-СТАРОМЛИНІВКА))
            СЕРЕБРО(НВ)
            НВ(НВ)
            1. Приветствую ты в работе?
            1. Там скоро в твоем районе будет мотоцикл пролетать, это наш так, посмотрите чтоб, возьмите его на под охрану, пока он будет ехать.
            1. Я знаю знаю, главное чтоб никакой истерички ебаной не было там за этим мотоциклом.
            2. Да.
            (Обмін службовою інформацією)"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м йм. управління гсадн зі складу 60 омсбр 5 А".to_string()
        );
        assert_eq!(
            res.locality.unwrap(),
            "УКХ р/м йм. управління гсадн зі складу 60 омсбр 5 А (район: ЛЮБИМІВКА-СТАРОМЛИНІВКА)".to_string()
        );

        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ЛЮБИМІВКА", "СТАРОМЛИНІВКА"]);
        assert_eq!(
            vec!["60 омсбр 5 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_zp_4() {
        let body = r#"21.10, 20:03
            Не встановлений підрозділ з числа 336 обмп 3 А (Красноселівка) (ЦфП_103)
            НВ
            3-Й, ЧЕРКЕС

            - Черкес я 3-й , 437 , Кузя убыл"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "Не встановлений підрозділ з числа 336 обмп 3 А".to_string()
        );
        assert_eq!(res.locality.unwrap(), "Не встановлений підрозділ з числа 336 обмп 3 А (Красноселівка) (ЦфП_103)".to_string());
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["КРАСНОСЕЛІВКА".to_string()]);
        assert_eq!(
            vec!["336 обмп 3 а"],
            parse_library_unit(&String::from(body))
        );
    }

    #[test]
    fn extract_unit_zp_5() {
        let body = "
             Отримано з поста П3 'Вікінг'
             --------------------------------------
             11.11, 03:12:56
             411.7500
             DMRe (йм. 114 мсп 127 мсд 5 А) (йм. р-н Новоселівка-Сміле-Гоголівка)
             НВ
             НВ

             — Барабаш, Барабаш, я Антай, прием.
             -- Антай, я Барабаш, на приеме.
             -- Этот, бутильник на 7 ставь и сюда, и тут синий прочитаешь.
             -- принял, принял.
            ";

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "DMRe (йм. 114 мсп 127 мсд 5 А) (йм. р-н Новоселівка-Сміле-Гоголівка)".to_string().to_string());
        assert_eq!(
            vec!["114 мсп 127 мсд 5 а"],
            parse_library_unit(&String::from(body))
        );
        assert_eq!(res.locality.unwrap(), "DMRe (йм. 114 мсп 127 мсд 5 А) (йм. р-н Новоселівка-Сміле-Гоголівка)");
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ГОГОЛІВКА", "НОВОСЕЛІВКА", "СМІЛЕ"]);
    }

    #[test]
    fn extract_unit_zp_6() {
        let body = r#"Отримано з поста " П3 "Вікінг""
--------------------------------------
30.10, 16:55:08
415.8300
(р-н Стипове)
НВ
НВ

— З Юго Запада на Восток идет ФПВ."#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert!(res.unit.is_none());
        assert_eq!(res.locality.unwrap(), "р-н Стипове");
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["СТЕПОВЕ"]);
    }

    #[test]
    fn extract_unit_zp_7() {
        let body = r#"Отримано з поста "П1 "Норд""
--------------------------------------
30.10, 18:06:58
425.3000
(йм. 64 осмбр 25 п 35 А)(р-н Пд. від Дорожнянка)
НВ
НВ

— Сейчас, 5 малых. Принял, хорошо. Ты мне что нибудь везешь? Так, а эти, блядь, как заступающие, они не с тобой?"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "йм. 64 осмбр 25 п 35 А(р-н Пд. від Дорожнянка)".to_string()
        );
        assert_eq!(
            vec!["64 осмбр", "25 п 35 а"],
            parse_library_unit(&String::from(body))
        );
        assert_eq!(
            res.locality.unwrap(),
            "йм. 64 осмбр 25 п 35 А(р-н Пд. від Дорожнянка)"
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ДОРОЖНЯНКА"]);
    }

    #[test]
    fn extract_unit_zp_8() {
        let body = r#"Отримано з поста "П153"
    --------------------------------------
14.11, 14:45:18
400.2000
    (на Пд від Новодарівка)
    НВ
    ВЕСЕЛЫЙ

    --Да говорят прилёт был по Марсу по пацанам.
    --Весёлый выпускай по одному Белый Быкова група куда им двигатся?
    — Давай, запускайте людей быстрее! Бегом, бегом, бегом, бегом, блядь! Белый, Веселый, запускай людей бегом, бегом, бегом. Остальные с группой по одному. Веселый, как принял?

    ВЕСЕЛЫЙ"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res =
            extract_unit(settlements, body, vec![String::from("ВЕСЕЛЫЙ")])
                .unwrap();
        assert!(res.unit.is_none());
        assert!(res.locality.is_none());
        assert!(res.locality_v2.is_none());
    }

    #[test]
    fn extract_unit_soledarnist_1() {
        let body = r#"04.11, 16:28:22
410.6200
УКХ р/м управління 1 мсб 132 омсбр (р-н ПІВНІЧНЕ)
НВ
НВ"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(
            res.unit.unwrap(),
            "УКХ р/м управління 1 мсб 132 омсбр".to_string().to_string()
        );
        assert_eq!(
            vec!["1 мсб 132 омсбр"],
            parse_library_unit(&String::from(body))
        );
        assert_eq!(res.locality.unwrap(), "ПІВНІЧНЕ");
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ПІВНІЧНЕ"]);
    }

    #[test]
    fn extract_unit_sumy_1() {
        let body = r#"2025_01_13 17-02-34
Частота: 274,750 MHz
Канал: Unknown
Напрямок: Суджа, Снагість, Обухівка

— второй 076 Спасибо за прикрытие счастья здоровья"#;

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit, None);

        assert_eq!(
            res.locality.unwrap(),
            "Напрямок: Суджа, Снагість, Обухівка"
        );
        let locality_v2_txt = validate_locality_v2(res.locality_v2);
        assert_eq!(locality_v2_txt, vec!["ОБУХІВКА", "СНАГОСТЬ", "СУДЖА"]);
    }

    #[test]
    fn extract_unit_pu_fsb_rf_with_popovo_lezhachi_tetkino_location() {
        let body =
            "ймовірно ПУ ФСБ РФ / район ПОПОВО-ЛЕЖАЧИ (РФ) - ТЕТКИНО (РФ) (19.06)";

        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert!(res
            .unit
            .as_deref()
            .is_some_and(|unit| unit.contains("ПУ ФСБ РФ")));
        let locality = res.locality.unwrap();
        assert!(locality.contains("ПОПОВО-ЛЕЖАЧИ"));
        assert!(locality.contains("ТЕТКИНО"));
    }

    #[test]
    fn extract_unit_pu_fsb_rf_resolves_location_with_aor() {
        let aor_id = 7;
        let locality = "КВАДРОЗЕБРААЛЬФА";
        let mut trie = crate::location::trie::Trie::new();
        let details = SettlementDetails {
            id: Some(9_000_001),
            name: locality.to_string(),
            region: "ТЕСТОВА ОБЛАСТЬ".to_string(),
            language: Language::Ua,
            coords: Some((48.0, 33.0)),
        };
        trie.insert(locality, details.clone());
        let mut details_by_id = BTreeMap::new();
        details_by_id.insert(details.id.unwrap(), details);
        let settlements_data = Arc::new((
            vec!["ТЕСТОВА ОБЛАСТЬ".to_string()],
            vec![],
            trie,
            details_by_id,
            BTreeMap::new(),
        ));
        let mut settlements_config =
            crate::location::SettlementsDataConfig::default();
        settlements_config
            .aor_id_to_settlements_data
            .insert(aor_id, settlements_data);
        let settlements = Arc::new(RwLock::new(settlements_config));
        let body = format!("ймовірно ПУ ФСБ РФ / район {locality}");

        let res =
            extract_unit_with_aor(settlements, &body, vec![], Some(aor_id))
                .unwrap();

        assert_eq!(validate_locality_v2(res.locality_v2), vec![locality]);
    }

    #[test]
    fn extract_unit_jf_header_01() {
        let body = r#" 19.02.2026 09:08 противник зі складу 6 шр 2 мсб 283 мсп 144 мсд здійснє переміщення групи в районі південніше СЕРЕДНЄ (за маршрутом: 37U DQ 05770 40609, 37U DQ 05730 40657)

 19.02.2026, 09:08:31
 155.0250
 МИНСК
 БОБ, СЕНЯ
 — Боб, Боб, Боб, им скажи, что им сейчас, скоро нужно будет повернуть направо, направо. Так, Сеня, Сеня, Сеня, смотри, им нужно в район 8 26, чтоб они повернули, и двигались в район 160-й, фиолетовой.
 -Да, принял, принял,
 — Минск, Минск, я Сеня. Назад, назад, возвращается 1.
 - Я тебя принял, принял. 1, 1, продолжает движение?
 - Нет, нет, первый который зашел до 8 1 6, развернулся, пошел назад. Обратно на 8 1 5.
 - Боб, Боб, слышишь информацию? Пихай их дальше, блядь, пускай пиздуют."#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "6 шр 2 мсб 283 мсп 144 мсд".to_string());
        assert_eq!(res.locality.unwrap(), "СЕРЕДНЄ".to_string());
    }

    #[test]
    fn extract_unit_jf_header_02() {
        let body = r#" 22.02.2026 13:00 противник зі складу гсадн 27 омсбр 1 ТА планує нанесення вогневого ураження по позиції СОУ в районі ТИЩЕНКІВКА (37U CR 95898 13939)
 22.02.2026, 13:00:54
 150.7500
 ГОЛЬФ
 НЕВА
 1 — Нева я Гольф диктуй, диктуй.
 2 — цель 18 75 желтая, 18 75 желтая, 55 16 245, 55 16 245, 73 95 966, 73 95 966, 152, 152.
 1 — 18 75 желтая, 55 16 245, 73 95 966, 152"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res = extract_unit(settlements, body, vec![]).unwrap();
        assert_eq!(res.unit.unwrap(), "гсадн 27 омсбр 1 ТА".to_string());
        assert_eq!(res.locality.unwrap(), "ТИЩЕНКІВКА".to_string());
    }

    #[test]
    fn extract_unit_jf_header_03_rejects_non_coords_suffix() {
        let body = r#" 22.02.2026 13:00 противник зі складу гсадн 27 омсбр 1 ТА планує нанесення вогневого ураження по позиції СОУ в районі ТИЩЕНКІВКА за маршрутом 37U CR 95898 13939"#;
        let config = crate::config::read_config(Mode::Test).unwrap();
        let settlements = Arc::new(RwLock::new(
            crate::location::load_settlements_data_config(
                config.settlement_paths().unwrap(),
                Mode::Test,
            )
            .unwrap(),
        ));
        let res =
            try_extract_jf_unit_and_location(settlements, body, None).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn parse_comm_operator_0() {
        let body = r#"Zenit
Отримано з поста "Solist_76"
--------------------------------------
14.11, 10:53:29
138.1255
УКХ р/м НВ мсб 4 ВБ 58 ЗвА (КАМ'ЯНСЬКЕ-ЛУГОВЕ-ВЕЛИКА КРИНИЦЯ) 138.1255 МГц
НВ
НВ

— 505 Дед, 505 Дед, 505 Сын и 505 с Отца на грядке.
        "#;
        assert_eq!(try_extract_comm_operator(body).as_deref(), Some("Zenit"));
    }

    #[test]
    fn parse_comm_operator_1() {
        let inputs = vec![
            (
                r#"pur99
Отримано з поста "ПУР 99"
--------------------------------------
14.11, 04:14:21
434.3687
1 мсб 38 омсбр ймовір. н.п. Мирне
НВ
НВ

— птичка наша на север пошла.
        "#,
                "pur99",
            ),
            (
                r#"pur99
Отримано з поста "ПУР 99"
--------------------------------------
14.11, 04:14:21"#,
                "pur99",
            ),
            (
                r#"pur99
Отримано з поста "ПУР 99"
--------------------------------------"#,
                "pur99",
            ),
        ];

        for (input, expected) in inputs {
            assert_eq!(
                try_extract_comm_operator(input).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn parse_comm_operator_to_none() {
        let inputs = vec![
            r#"
--------------------------------------
        "#,
            r#"pur99
Отримано з поста "ПУР 99"#,
            r#"pur99"#,
        ];

        for input in inputs {
            assert_eq!(
                try_extract_comm_operator(input).as_deref(),
                None::<String>.as_deref()
            );
        }
    }

    #[test]
    fn parse_comm_operator_2() {
        let inputs = vec![
            "",
            "one row",
            r#"first row
        second row"#,
            r#"first row
        second row
        third row"#,
            r#"first row
        second row
        third row
        forth row"#,
        ];
        for input in inputs {
            assert_eq!(
                try_extract_comm_operator(input).as_deref(),
                None::<String>.as_deref()
            );
        }
    }

    fn validate_locality_v2(
        m_locality: Option<Vec<SettlementDetails>>,
    ) -> Vec<String> {
        assert!(m_locality.is_some());
        let mut localities = vec![];
        for row in m_locality.unwrap() {
            let name = row.name.clone();
            assert!(row.coords.is_some());
            let (lat, lng) = row.coords.unwrap();
            assert!(lat > 1.0);
            assert!(lng > 1.0);
            localities.push(name);
        }
        localities
    }
}

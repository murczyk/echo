use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;
use chrono_tz::Europe::Kyiv;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tokio::io::AsyncBufReadExt;

pub mod grafana;
pub mod http;
pub mod json;
pub mod multipart;
pub mod orm;
pub mod string;

pub fn backup_tmp_dir(tmp_dir: &Path) -> Result<(), AppError> {
    let dt = chrono::offset::Utc::now();
    // if /fast/kon/tmp exists -- use that, otherwise use /tmp
    let path = if Path::new("/fast/kon/tmp").exists() {
        format!("/fast/kon/tmp/wdintel-{}", dt.format("%Y%m%d-%H%M%S-%f"))
    } else {
        format!("/tmp/wdintel-{}", dt.format("%Y%m%d-%H%M%S-%f"))
    };
    println!("> backing up tmp_dir {} into {}", tmp_dir.display(), path);
    std::fs::create_dir(&path)?;
    fs_extra::dir::copy(tmp_dir, path, &fs_extra::dir::CopyOptions::new())?;
    Ok(())
}

pub fn trim_lines(x: &str) -> String {
    let lines: Vec<&str> = x.lines().map(|x| x.trim()).collect();
    lines.join("\n").to_string()
}

pub fn new_btmap<K, V>(k: K, v: V) -> BTreeMap<K, V>
where
    K: Ord,
{
    let mut x = BTreeMap::new();
    x.insert(k, v);
    x
}

pub fn dt_from_millis(millis: i64) -> Result<NaiveDateTime, AppError> {
    let res = DateTime::from_timestamp_millis(millis)
        .map(|x| x.naive_utc())
        .ok_or(format!("Error parsing millis timestamp: {millis}"));
    Ok(res?)
}

pub fn dt_zoned_from_millis(
    ms: i64,
) -> Result<chrono::DateTime<chrono_tz::Tz>, AppError> {
    let dt: chrono::DateTime<Utc> =
        chrono::DateTime::from_naive_utc_and_offset(dt_from_millis(ms)?, Utc);
    let dt: chrono::DateTime<chrono_tz::Tz> = dt.with_timezone(&Kyiv);
    Ok(dt)
}

pub fn cond_json_contains_oneof(col: &str, vs: &[String]) -> String {
    let mut conds = vec![];
    for x in vs.iter() {
        conds.push(format!("{col}::jsonb ? '{x}'"));
    }
    let final_cond: String = format!("({})", conds.join(" or "));
    final_cond
}

pub fn cond_json_contains_oneof_i64(col: &str, vs: &[i64]) -> String {
    let mut conds = vec![];
    for x in vs.iter() {
        conds.push(format!("{col}::jsonb @> '{x}'"));
    }
    let final_cond: String = format!("({})", conds.join(" or "));
    final_cond
}

pub fn cond_json_contains_all_i64(col: &str, vs: &[i64]) -> String {
    let mut conds = vec![];
    for x in vs.iter() {
        conds.push(format!("{col}::jsonb @> '{x}'"));
    }
    let final_cond: String = format!("({})", conds.join(" and "));
    final_cond
}

/// Preserves order of elements in the input vector
pub fn uniq_via_btreeset<A>(input: &[A]) -> Vec<A>
where
    A: Ord + Clone,
{
    let mut res: Vec<A> = vec![];
    let mut seen = BTreeSet::new();
    for item in input.iter() {
        if !seen.contains(item) {
            res.push(item.clone());
            seen.insert(item.clone());
        }
    }
    res
}

pub fn get_pb_style() -> Result<indicatif::ProgressStyle, AppError> {
    Ok(indicatif::ProgressStyle::with_template("{spinner:.green} [{prefix}] [{wide_bar:.cyan/blue}] {human_pos}/{human_len} ({eta})")?
        .with_key(
            "eta",
            |state: &indicatif::ProgressState, w: &mut dyn core::fmt::Write|
            write!(w, "{:.1}s", state.eta().as_secs_f64()).unwrap())
        .progress_chars("#>-"))
}

pub fn check_status(
    rsp: reqwest::Response,
) -> Result<reqwest::Response, AppError> {
    if rsp.status().is_success() {
        Ok(rsp)
    } else {
        Err(AppError::BL {
            msg: format!("Bad status: {}, url: {}", rsp.status(), rsp.url()),
        })
    }
}

pub fn m_cap_s(capts: &regex::Captures, name: &str) -> Option<String> {
    capts.name(name).map(|cap| cap.as_str().to_string())
}

pub fn parse_mongo_dt(inp: &str) -> Result<NaiveDateTime, AppError> {
    Ok(NaiveDateTime::parse_from_str(
        inp,
        "%Y-%m-%dT%H:%M:%S.%3fZ",
    )?)
}

pub fn from_m_val_vec<A>(
    inp: Option<serde_json::Value>,
) -> Result<Vec<A>, AppError>
where
    A: for<'de> serde::Deserialize<'de>,
{
    match inp {
        None => Ok(vec![]),
        Some(jv) => Ok(serde_json::from_value(jv).context(h!())?),
    }
}

pub fn pop_vector<T>(data: &mut Vec<T>) -> Option<T> {
    if data.is_empty() {
        None
    } else {
        Some(data.remove(0))
    }
}

pub async fn read_lines_from_file<P: AsRef<Path>>(
    path: P,
) -> anyhow::Result<Vec<String>> {
    let file = tokio::fs::File::open(path).await?;
    let reader = tokio::io::BufReader::new(file);
    let mut lines = Vec::new();
    let mut stream = reader.lines();
    loop {
        let Some(line) = stream.next_line().await? else {
            break;
        };
        lines.push(line);
    }
    Ok(lines)
}

#[macro_export]
macro_rules! here {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::header::DispositionParam;
    use actix_web::http::header::ExtendedValue;

    #[test]
    fn parse_content_disposition_test01() {
        let res = actix_web::http::header::ContentDisposition::from_raw(&actix_web::http::header::HeaderValue::from_str(r###"form-data; name="attachment"; filename="attachment.png"; filename*=UTF-8''attachment.png"###).unwrap()).unwrap();
        println!("> res: {res:?}");

        let bs = "attachment.png".as_bytes();
        assert_eq!(
            res.parameters[1],
            DispositionParam::Filename("attachment.png".to_string()),
        );
        assert_eq!(
            res.parameters[2],
            DispositionParam::FilenameExt(ExtendedValue {
                charset: actix_web::http::header::Charset::Ext(
                    "UTF-8".to_string()
                ),
                language_tag: None,
                value: bs.to_vec(),
            }),
        );
    }

    #[test]
    fn test_date_parse() {
        let inp = "2023-06-16T00:17:11.530Z";
        let res = parse_mongo_dt(inp).unwrap();
        assert_eq!(res.minute(), 17);
    }

    #[test]
    fn test_dt_zoned_from_millis() {
        let r = 1689335742000;
        let res: DateTime<chrono_tz::Tz> = dt_zoned_from_millis(r).unwrap();
        assert_eq!(res.year(), 2023);
        assert_eq!(res.hour(), 14);
        assert_eq!(res.minute(), 55);
    }

    #[test]
    fn test_naive_to_utc_to_kyiv_format() {
        let dt_s = "2024-06-29-19:00:00";
        let dt =
            NaiveDateTime::parse_from_str(dt_s, "%Y-%m-%d-%H:%M:%S").unwrap();
        let tz = chrono_tz::Europe::Kyiv;
        let res = Utc.from_utc_datetime(&dt).with_timezone(&tz);
        let res_s = res.format("%Y-%m-%d %H:%M:%S").to_string();
        assert_eq!(res_s, "2024-06-29 22:00:00");
    }
}

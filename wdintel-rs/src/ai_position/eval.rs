//! The position evaluation set: exports reviewer feedback as cases and
//! replays them through the real extraction and grounding.
//!
//! See `ai-eval/2026-10-03-position-feedback/README.md`.

use super::extract::{all_coords, extract};
use super::normalize::position_key;
use crate::config::AI_POSITION_COORDINATE_MATCH_METERS;
use crate::entities::{ai_engine, ai_position_feedback, signal_group};
use crate::h;
use crate::types::{info, Mode, ShortContext};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;

/// One reviewed case, as stored in the evaluation set's `raw/` directory.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackCase {
    pub id: i64,
    pub target_kind: String,
    pub verdict: String,
    pub expected: String,
    pub comment: String,
    pub name: String,
    pub name_key: String,
    /// `position`, `crew` or `callsign`, as reviewed.
    #[serde(default)]
    pub kind: Option<String>,
    /// `message`, `document` or `knowledge`.
    pub source_kind: String,
    pub text: Option<String>,
    pub begin_char: Option<i32>,
    pub end_char: Option<i32>,
    pub coordinates: serde_json::Value,
    pub known_location: Option<serde_json::Value>,
    pub scope_kind: Option<String>,
    pub scope_key: Option<String>,
    pub group_is_secret: bool,
    pub model_name: Option<String>,
    pub created_at: String,
}

/// `wdintel-rs --mode=live ai-position-feedback-export --output <file>`
pub async fn export_feedback(
    mode: Mode,
    ps: &crate::AiPositionFeedbackExportPs,
) -> anyhow::Result<()> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut query = ai_position_feedback::Entity::find();
    if let Some(since) = &ps.since {
        let since = chrono::NaiveDate::parse_from_str(since, "%Y-%m-%d")
            .c(h!())?
            .and_hms_opt(0, 0, 0)
            .c(h!())?;
        query =
            query.filter(ai_position_feedback::Column::CreatedAt.gte(since));
    }
    let rows = query
        .order_by_asc(ai_position_feedback::Column::Id)
        .all(&dbx)
        .await
        .c(h!())?;
    let secret: HashSet<String> = signal_group::Entity::find()
        .filter(signal_group::Column::IsSecret.eq(true))
        .all(&dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| group.master_key)
        .collect();
    if let Some(parent) = std::path::Path::new(&ps.output).parent() {
        std::fs::create_dir_all(parent).c(h!())?;
    }
    let mut output = std::fs::File::create(&ps.output).c(h!())?;
    for row in &rows {
        let case = FeedbackCase {
            id: row.id,
            target_kind: row.target_kind.clone(),
            verdict: row.verdict.clone(),
            expected: row.expected.clone(),
            comment: row.comment.clone(),
            name: row.name.clone(),
            name_key: row.name_key.clone(),
            kind: row.kind.clone(),
            source_kind: match (&row.target_kind[..], row.sigint_inbox_item_id)
            {
                ("knowledge", _) => "knowledge",
                (_, Some(_)) => "message",
                _ => "document",
            }
            .to_string(),
            text: row.source_text.clone(),
            begin_char: row.begin_char,
            end_char: row.end_char,
            coordinates: row.coordinates.clone(),
            known_location: row.known_location.clone(),
            scope_kind: row.scope_kind.clone(),
            scope_key: row.scope_key.clone(),
            group_is_secret: row
                .group_master_key
                .as_ref()
                .is_some_and(|key| secret.contains(key)),
            model_name: row.model_name.clone(),
            created_at: row.created_at.and_utc().to_rfc3339(),
        };
        writeln!(output, "{}", serde_json::to_string(&case).c(h!())?)
            .c(h!())?;
    }
    info!(
        "exported {} position feedback cases to {}",
        rows.len(),
        ps.output
    );
    Ok(())
}

/// Private engine file: the `ai_engine` fields needed to call it.
#[derive(Deserialize)]
struct EngineFile {
    url: String,
    model_name: String,
    token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    id: i64,
    verdict: String,
    /// `None`: the case cannot be replayed (location feedback, no text,
    /// `other`).
    passed: Option<bool>,
    found: Vec<String>,
    note: String,
}

/// `wdintel-rs --mode=debug ai-position-eval --cases <jsonl> --engine <json>`
pub async fn evaluate(
    _mode: Mode,
    ps: &crate::AiPositionEvalPs,
) -> anyhow::Result<()> {
    let engine: EngineFile =
        serde_json::from_str(&std::fs::read_to_string(&ps.engine).c(h!())?)
            .c(h!())?;
    let now = chrono::Utc::now().naive_utc();
    let engine = ai_engine::Model {
        id: uuid::Uuid::nil(),
        name: "evaluation".to_string(),
        url: engine.url,
        token: engine.token,
        model_name: engine.model_name,
        created_at: now,
        updated_at: now,
        enabled: true,
        callsign_enabled: true,
        ocr_enabled: false,
        ocr_request_profile: String::new(),
    };
    let prompt = match &ps.prompt {
        Some(path) => std::fs::read_to_string(path).c(h!())?,
        None => super::effective_prompt("").to_string(),
    };
    let cases = std::fs::read_to_string(&ps.cases).c(h!())?;
    let mut results = Vec::new();
    for line in cases.lines().filter(|line| !line.trim().is_empty()) {
        let case: FeedbackCase = serde_json::from_str(line).c(h!())?;
        results.push(evaluate_case(&engine, &prompt, case).await);
    }
    let mut summary: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
    for result in &results {
        let entry = summary.entry(result.verdict.clone()).or_default();
        match result.passed {
            Some(true) => entry.0 += 1,
            Some(false) => entry.1 += 1,
            None => entry.2 += 1,
        }
    }
    for (verdict, (passed, failed, skipped)) in &summary {
        println!("{verdict:18} passed {passed:4}  failed {failed:4}  skipped {skipped:4}");
    }
    for result in results.iter().filter(|result| result.passed == Some(false)) {
        println!("FAIL #{} {}: {}", result.id, result.verdict, result.note);
    }
    if let Some(output) = &ps.output {
        std::fs::write(output, serde_json::to_string_pretty(&results).c(h!())?)
            .c(h!())?;
    }
    Ok(())
}

async fn evaluate_case(
    engine: &ai_engine::Model,
    prompt: &str,
    case: FeedbackCase,
) -> CaseResult {
    let skipped = |note: &str| CaseResult {
        id: case.id,
        verdict: case.verdict.clone(),
        passed: None,
        found: vec![],
        note: note.to_string(),
    };
    if case.target_kind != "mention" {
        return skipped("location feedback: review consolidation by hand");
    }
    let Some(text) = case.text.as_deref() else {
        return skipped("source text missing");
    };
    if case.verdict == "other" {
        return skipped("free-form feedback");
    }
    let extraction = match extract(engine, prompt, text, &[]).await {
        Ok(extraction) => extraction,
        Err(error) => {
            return CaseResult {
                passed: Some(false),
                note: format!("extraction failed: {error:#}"),
                ..skipped("")
            }
        }
    };
    let found: Vec<String> = extraction
        .positions
        .iter()
        .map(|position| position.name_key.clone())
        .collect();
    let coordinates_of = |key: &str| -> Vec<(String, f64, f64)> {
        extraction
            .positions
            .iter()
            .filter(|position| position.name_key == key)
            .flat_map(|position| &position.coordinates)
            .map(|coordinate| {
                (coordinate.mgrs.clone(), coordinate.lat, coordinate.lng)
            })
            .collect()
    };
    let snapshot_mgrs: Vec<String> = case
        .coordinates
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|coordinate| {
            coordinate.get("mgrs")?.as_str().map(str::to_string)
        })
        .collect();
    let has = |key: &str| found.iter().any(|found| found == key);
    let (passed, note) = match case.verdict.as_str() {
        "correct" => {
            let kept = snapshot_mgrs.iter().all(|mgrs| {
                coordinates_of(&case.name_key)
                    .iter()
                    .any(|found| &found.0 == mgrs)
            });
            let kind = extraction
                .positions
                .iter()
                .find(|position| position.name_key == case.name_key)
                .map(|position| position.kind.as_str());
            let kind_ok = case.kind.is_none() || kind == case.kind.as_deref();
            (
                has(&case.name_key) && kept && kind_ok,
                format!(
                    "expected «{}» ({:?}) with its coordinates, found kind {kind:?}",
                    case.name, case.kind
                ),
            )
        }
        "not_position" => (
            !has(&case.name_key),
            format!("«{}» is not a position", case.name),
        ),
        "wrong_name" => {
            let expected = position_key(&case.expected);
            (
                !has(&case.name_key) && (expected.is_empty() || has(&expected)),
                format!(
                    "expected «{}» instead of «{}»",
                    case.expected, case.name
                ),
            )
        }
        "wrong_coordinates" => {
            let found_coordinates = coordinates_of(&case.name_key);
            let wrong_kept = found_coordinates
                .iter()
                .any(|found| snapshot_mgrs.contains(&found.0));
            let expected_found = if case.expected.trim().is_empty() {
                true
            } else {
                let expected = all_coords(&case.expected).await;
                expected.iter().any(|(expected, _)| {
                    found_coordinates.iter().any(|found| {
                        distance_m(
                            (expected.lat, expected.lng),
                            (found.1, found.2),
                        ) <= AI_POSITION_COORDINATE_MATCH_METERS
                    })
                })
            };
            (
                !wrong_kept && expected_found,
                format!(
                    "wrong coordinates {snapshot_mgrs:?}, expected «{}»",
                    case.expected
                ),
            )
        }
        "wrong_kind" => {
            let kind = extraction
                .positions
                .iter()
                .find(|position| position.name_key == case.name_key)
                .map(|position| position.kind.clone());
            (
                kind.as_deref() == Some(case.expected.trim()),
                format!("expected kind {}, found {kind:?}", case.expected),
            )
        }
        "missed" => {
            let missing: Vec<String> = case
                .expected
                .split(['\n', ',', ';'])
                .map(position_key)
                .filter(|key| !key.is_empty() && !has(key))
                .collect();
            (missing.is_empty(), format!("missed {missing:?}"))
        }
        _ => return skipped("unknown verdict"),
    };
    CaseResult {
        id: case.id,
        verdict: case.verdict,
        passed: Some(passed),
        found,
        note,
    }
}

fn distance_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;
    let (lat1, lat2) = (a.0.to_radians(), b.0.to_radians());
    let dlat = lat2 - lat1;
    let dlng = (b.1 - a.1).to_radians();
    let h = (dlat / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * (dlng / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

//! One model call over a text, then deterministic grounding: names must
//! occur in the text and coordinates must be coordinates the text contains.

use super::normalize::{ground, position_key};
use super::types::{AiPositionCoordinateItem, AiPositionFound, AiPositionSpan};
use crate::ai_engine::{request_structured_ai_response, AiEngineMessage};
use crate::config::{
    AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER,
    AI_POSITION_COORDINATE_MATCH_METERS, AI_POSITION_COORDINATE_MAX_CHARS,
    AI_POSITION_COORDINATE_NEAR_CHARS, AI_POSITION_EVIDENCE_MAX_CHARS,
    AI_POSITION_MAX_COORDINATES, AI_POSITION_MAX_POSITIONS,
    AI_POSITION_NAME_MAX_CHARS, AI_POSITION_OUTPUT_TOKENS,
    AI_POSITION_SOURCE_MAX_CHARS, AI_POSITION_TEMPERATURE,
};
use crate::entities::ai_engine;
use crate::h;
use crate::types::ShortContext;
use milgeo_rs::coordinates::{parser_v1, parser_v2, Coords};
use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) const CERTAINTIES: [&str; 3] = ["high", "medium", "low"];
const SYSTEMS: [&str; 4] = ["mgrs", "sk42", "usk2000", "wgs84"];

#[derive(Debug, Deserialize)]
struct ModelResponse {
    positions: Vec<ModelPosition>,
}

#[derive(Debug, Deserialize)]
struct ModelPosition {
    name: String,
    #[serde(default)]
    coordinates: Vec<ModelCoordinate>,
}

#[derive(Debug, Deserialize)]
struct ModelCoordinate {
    value: String,
    system: String,
    certainty: String,
    #[serde(default)]
    evidence: String,
}

pub(crate) struct Extraction {
    pub positions: Vec<AiPositionFound>,
    pub response_text: String,
    pub model_name: String,
}

pub(crate) async fn extract(
    engine: &ai_engine::Model,
    prompt: &str,
    text: &str,
) -> anyhow::Result<Extraction> {
    let text: String =
        text.chars().take(AI_POSITION_SOURCE_MAX_CHARS).collect();
    let response = request_structured_ai_response(
        engine,
        vec![
            AiEngineMessage {
                role: AI_CHAT_ROLE_SYSTEM.to_string(),
                content: prompt.to_string(),
            },
            AiEngineMessage {
                role: AI_CHAT_ROLE_USER.to_string(),
                content: text.clone(),
            },
        ],
        AI_POSITION_TEMPERATURE,
        AI_POSITION_OUTPUT_TOKENS,
        response_format(),
    )
    .await
    .c(h!())?;
    let parsed: ModelResponse =
        serde_json::from_str(strip_code_fence(&response.content))
            .c(h!())
            .with_context(|| format!("відповідь ШІ: {}", response.content))?;
    let positions = ground_positions(&text, parsed).await;
    Ok(Extraction {
        positions,
        response_text: response.content,
        model_name: response
            .model_name
            .unwrap_or_else(|| engine.model_name.clone()),
    })
}

use anyhow::Context as _;

fn strip_code_fence(text: &str) -> &str {
    let text = text.trim();
    let Some(inner) = text.strip_prefix("```") else {
        return text;
    };
    let inner = inner.strip_prefix("json").unwrap_or(inner);
    inner.strip_suffix("```").unwrap_or(inner).trim()
}

fn response_format() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "positions",
            "strict": true,
            "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["positions"],
                "properties": {
                    "positions": {
                        "type": "array",
                        "maxItems": AI_POSITION_MAX_POSITIONS,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["name", "coordinates"],
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": AI_POSITION_NAME_MAX_CHARS
                                },
                                "coordinates": {
                                    "type": "array",
                                    "maxItems": AI_POSITION_MAX_COORDINATES,
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": false,
                                        "required": ["value", "system", "certainty", "evidence"],
                                        "properties": {
                                            "value": {
                                                "type": "string",
                                                "minLength": 1,
                                                "maxLength": AI_POSITION_COORDINATE_MAX_CHARS
                                            },
                                            "system": { "type": "string", "enum": SYSTEMS },
                                            "certainty": { "type": "string", "enum": CERTAINTIES },
                                            "evidence": {
                                                "type": "string",
                                                "maxLength": AI_POSITION_EVIDENCE_MAX_CHARS
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

async fn ground_positions(
    text: &str,
    response: ModelResponse,
) -> Vec<AiPositionFound> {
    let source_coords = all_coords(text).await;
    let mut found: Vec<AiPositionFound> = Vec::new();
    for position in response
        .positions
        .into_iter()
        .take(AI_POSITION_MAX_POSITIONS)
    {
        let name = position.name.trim().trim_matches(['"', '«', '»']).trim();
        let name_key = position_key(name);
        if name_key.is_empty()
            || found.iter().any(|item| item.name_key == name_key)
        {
            continue;
        }
        let spans = ground(text, name);
        if spans.is_empty() {
            continue;
        }
        let mut coordinates = Vec::new();
        for coordinate in position.coordinates {
            if let Some(item) =
                ground_coordinate(text, &source_coords, &spans, coordinate)
                    .await
            {
                if !coordinates.iter().any(
                    |known: &AiPositionCoordinateItem| known.mgrs == item.mgrs,
                ) {
                    coordinates.push(item);
                }
            }
        }
        found.push(AiPositionFound {
            name: name.to_string(),
            name_key,
            spans: spans
                .into_iter()
                .map(|(begin, end)| AiPositionSpan {
                    begin: begin as i32,
                    end: end as i32,
                })
                .collect(),
            coordinates,
        });
    }
    found
}

/// The source coordinate the model's value refers to; values that are not
/// in the text are dropped.
async fn ground_coordinate(
    text: &str,
    source_coords: &[Coords],
    spans: &[(usize, usize)],
    coordinate: ModelCoordinate,
) -> Option<AiPositionCoordinateItem> {
    if !SYSTEMS.contains(&coordinate.system.as_str())
        || !CERTAINTIES.contains(&coordinate.certainty.as_str())
    {
        return None;
    }
    let parsed = all_coords(&coordinate.value).await;
    let parsed = parsed.first()?;
    let source = source_coords.iter().min_by(|a, b| {
        distance_m(a, parsed).total_cmp(&distance_m(b, parsed))
    })?;
    if distance_m(source, parsed) > AI_POSITION_COORDINATE_MATCH_METERS {
        return None;
    }
    // `capture` is the text as written; `text` is milgeo's lat/lng.
    let written = source
        .capture
        .trim()
        .trim_matches(|c: char| {
            matches!(c, '(' | ')' | '[' | ']' | ',' | ';' | ':')
        })
        .trim();
    let span = char_span(text, written);
    let certainty = capped_certainty(text, spans, span, &coordinate.certainty);
    Some(AiPositionCoordinateItem {
        text: written.to_string(),
        system: coordinate_system(written).to_string(),
        mgrs: source.mgrs.clone(),
        lat: source.lat,
        lng: source.lng,
        certainty: certainty.to_string(),
        evidence: coordinate
            .evidence
            .chars()
            .take(AI_POSITION_EVIDENCE_MAX_CHARS)
            .collect(),
        span: span.map(|(begin, end)| AiPositionSpan {
            begin: begin as i32,
            end: end as i32,
        }),
    })
}

/// The system of coordinates as written; small models mislabel it.
fn coordinate_system(written: &str) -> &'static str {
    let compact: String = written
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    let mgrs = regex::Regex::new(r"^\d{1,2}[C-X][A-Z]{2}\d{2,10}$").c(h!());
    if mgrs.is_ok_and(|mgrs| mgrs.is_match(&compact)) {
        return "mgrs";
    }
    let digits = compact.chars().filter(char::is_ascii_digit).count();
    // Grid pairs are two 7-digit numbers, possibly split as «53-24567».
    if !compact.contains('.') && digits >= 12 {
        "sk42"
    } else {
        "wgs84"
    }
}

/// Coordinates of every system in the text. milgeo's `rer_extract_coords`
/// keeps only the preferred system present, which would drop a WGS84 point
/// written next to an MGRS one.
async fn all_coords(text: &str) -> Vec<Coords> {
    let v2 = parser_v2::collect_coords(text).unwrap_or_default();
    let v1 = parser_v1::collect_coords(text).await.unwrap_or_default();
    [
        v2.mgrs_coords,
        v1.mgrs_coords,
        v2.usk2000_coords,
        v1.usk2000_coords,
        v2.decimal_coords,
        v1.decimal_coords,
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn char_span(text: &str, needle: &str) -> Option<(usize, usize)> {
    let needle = needle.trim();
    if needle.is_empty() {
        return None;
    }
    let byte = text.find(needle)?;
    let begin = text[..byte].chars().count();
    Some((begin, begin + needle.chars().count()))
}

/// The model's certainty, lowered to `low` when the coordinate is far from
/// every occurrence of the name or separated from it by a blank line, and to
/// at most `medium` when it cannot be located.
pub(crate) fn capped_certainty<'a>(
    text: &str,
    spans: &[(usize, usize)],
    coordinate: Option<(usize, usize)>,
    certainty: &'a str,
) -> &'a str {
    let Some((coord_begin, coord_end)) = coordinate else {
        return if certainty == "high" {
            "medium"
        } else {
            certainty
        };
    };
    let chars: Vec<char> = text.chars().collect();
    let near = spans.iter().any(|&(begin, end)| {
        let (gap_begin, gap_end) = if coord_begin >= end {
            (end, coord_begin)
        } else if begin >= coord_end {
            (coord_end, begin)
        } else {
            (begin, begin)
        };
        let gap: String = chars[gap_begin..gap_end].iter().collect();
        gap_end - gap_begin <= AI_POSITION_COORDINATE_NEAR_CHARS
            && !gap.contains("\n\n")
    });
    if near {
        certainty
    } else {
        "low"
    }
}

fn distance_m(a: &Coords, b: &Coords) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;
    let (lat1, lat2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlat = lat2 - lat1;
    let dlng = (b.lng - a.lng).to_radians();
    let h = (dlat / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * (dlng / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::{capped_certainty, ground_positions, ModelResponse};

    const EXAMPLE: &str =
        "Переміщення всл \"Гудок\" до \"Циркон 9\" (36T XT 75734 68963)";

    fn response(json: &str) -> ModelResponse {
        serde_json::from_str(json).unwrap()
    }

    #[tokio::test]
    async fn grounds_names_and_coordinates() {
        let found = ground_positions(
            EXAMPLE,
            response(r#"{"positions":[
                {"name":"Циркон 9","coordinates":[{"value":"36T XT 75734 68963","system":"mgrs","certainty":"high","evidence":"до Циркон 9"}]},
                {"name":"Вигаданий 5","coordinates":[]}
            ]}"#),
        )
        .await;
        assert_eq!(found.len(), 1);
        let position = &found[0];
        assert_eq!(position.name_key, "циркон 9");
        assert_eq!(position.spans[0].begin, 28);
        assert_eq!(position.spans[0].end, 36);
        let coordinate = &position.coordinates[0];
        assert_eq!(coordinate.certainty, "high");
        assert!((coordinate.lat - 47.9).abs() < 1.0, "{coordinate:?}");
        assert!((coordinate.lng - 35.6).abs() < 2.0, "{coordinate:?}");
        assert!(coordinate.span.is_some());
    }

    #[tokio::test]
    async fn keeps_coordinates_of_every_system() {
        let text =
            "Циркон 9 (36T XT 75734 68963), Береза 3 (48.12345, 37.54321)";
        let found = ground_positions(
            text,
            response(r#"{"positions":[
                {"name":"Циркон 9","coordinates":[{"value":"36T XT 75734 68963","system":"mgrs","certainty":"high","evidence":""}]},
                {"name":"Береза 3","coordinates":[{"value":"48.12345, 37.54321","system":"wgs84","certainty":"high","evidence":""}]}
            ]}"#),
        )
        .await;
        assert_eq!(found[1].coordinates.len(), 1, "{found:?}");
        assert!((found[1].coordinates[0].lat - 48.12345).abs() < 1e-4);
        assert_eq!(found[1].coordinates[0].system, "wgs84");
    }

    #[tokio::test]
    async fn drops_coordinates_missing_from_the_text() {
        let found = ground_positions(
            EXAMPLE,
            response(r#"{"positions":[{"name":"ЦИРКОН-9","coordinates":[{"value":"37U CQ 11111 22222","system":"mgrs","certainty":"high","evidence":""}]}]}"#),
        )
        .await;
        assert_eq!(found[0].name_key, "циркон 9");
        assert!(found[0].coordinates.is_empty());
    }

    #[test]
    fn classifies_written_coordinates() {
        use super::coordinate_system;
        assert_eq!(coordinate_system("36T XT 75734 68963"), "mgrs");
        assert_eq!(coordinate_system("X=5324567 Y=7412345"), "sk42");
        assert_eq!(coordinate_system("53-24567 74-12345"), "sk42");
        assert_eq!(coordinate_system("5324567, 7412345"), "sk42");
        assert_eq!(coordinate_system("48.12345, 37.54321"), "wgs84");
    }

    #[test]
    fn far_coordinates_are_low_certainty() {
        let text = format!("Циркон 9{}36T XT 75734 68963", " ".repeat(300));
        assert_eq!(
            capped_certainty(&text, &[(0, 8)], Some((308, 326)), "high"),
            "low"
        );
        assert_eq!(
            capped_certainty(
                "Циркон 9\n\n36T",
                &[(0, 8)],
                Some((10, 13)),
                "high"
            ),
            "low"
        );
        assert_eq!(
            capped_certainty(
                "Циркон 9 (36T)",
                &[(0, 8)],
                Some((10, 13)),
                "high"
            ),
            "high"
        );
        assert_eq!(capped_certainty("x", &[(0, 1)], None, "high"), "medium");
    }
}

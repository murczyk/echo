use crate::ai_position::types::AiPositionLookupRsp;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct DevicePositionEvidenceGroup {
    pub scope_kind: String,
    pub scope_key: String,
    pub name_key: String,
    pub kind: String,
    pub known_indexes: Vec<usize>,
    pub file_indexes: Vec<usize>,
    pub certainty: String,
    pub conflicting: bool,
}

pub(crate) fn group(
    response: &AiPositionLookupRsp,
) -> Vec<DevicePositionEvidenceGroup> {
    let mut groups = BTreeMap::new();
    for (index, known) in response.known.iter().enumerate() {
        let key = (
            known.scope_kind.clone(),
            known.scope_key.clone(),
            crate::ai_position::normalize::position_key(&known.name),
            known.kind.clone(),
        );
        entry(&mut groups, key).known_indexes.push(index);
    }
    for (index, file) in response.file_mentions.iter().enumerate() {
        let scopes = if file.aor_ids.is_empty() {
            vec![("device".to_string(), file.source.device_id.clone())]
        } else {
            file.aor_ids
                .iter()
                .map(|id| ("aor".to_string(), id.to_string()))
                .collect()
        };
        for (scope_kind, scope_key) in scopes {
            entry(
                &mut groups,
                (
                    scope_kind,
                    scope_key,
                    file.position.name_key.clone(),
                    file.position.kind.clone(),
                ),
            )
            .file_indexes
            .push(index);
        }
    }
    groups
        .into_values()
        .map(|mut group| {
            let mut coordinates = Vec::new();
            for index in &group.known_indexes {
                let known = &response.known[*index];
                group.conflicting |= known.conflicting;
                coordinates.push((
                    known.lat,
                    known.lng,
                    known.certainty.as_str(),
                ));
            }
            for index in &group.file_indexes {
                coordinates.extend(
                    response.file_mentions[*index]
                        .position
                        .coordinates
                        .iter()
                        .map(|c| (c.lat, c.lng, c.certainty.as_str())),
                );
            }
            group.conflicting |=
                coordinates.iter().enumerate().any(|(i, a)| {
                    coordinates[i + 1..].iter().any(|b| distant(a, b))
                });
            group.certainty = if group.conflicting {
                "low"
            } else if coordinates.iter().any(|c| c.2 == "high") {
                "high"
            } else if coordinates.iter().any(|c| c.2 == "medium") {
                "medium"
            } else {
                "low"
            }
            .into();
            group
        })
        .collect()
}

type Key = (String, String, String, String);
fn entry(
    groups: &mut BTreeMap<Key, DevicePositionEvidenceGroup>,
    key: Key,
) -> &mut DevicePositionEvidenceGroup {
    groups
        .entry(key.clone())
        .or_insert_with(|| DevicePositionEvidenceGroup {
            scope_kind: key.0,
            scope_key: key.1,
            name_key: key.2,
            kind: key.3,
            known_indexes: vec![],
            file_indexes: vec![],
            certainty: "low".into(),
            conflicting: false,
        })
}

fn distant(a: &(f64, f64, &str), b: &(f64, f64, &str)) -> bool {
    crate::ai_position::knowledge::coordinate_distance_m(a.0, a.1, b.0, b.1)
        > crate::config::AI_POSITION_KNOWLEDGE_CLUSTER_METERS
}

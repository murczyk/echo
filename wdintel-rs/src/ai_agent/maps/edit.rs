use super::prepare::{
    self, normalize_comments, refresh_coordinates, MISSING_SIDC_WARNING,
};
use super::types::*;
use crate::config::{AI_AGENT_MAP_MAX_RECORDS, AI_AGENT_MAP_TEXT_MAX_CHARS};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug)]
pub(super) enum EditFailure {
    Clarify(String),
    Reject(String),
}

pub(super) struct PatchOutcome {
    pub document: AiAgentMapDocument,
    pub diff: AiAgentMapEditDiff,
    pub matched_ids: Vec<String>,
}

pub(super) fn legacy_record_id(map_id: &str, index: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"echo-map-record-v1");
    hasher.update(map_id.as_bytes());
    hasher.update([0]);
    hasher.update(index.to_string().as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

pub(super) fn assign_stable_ids(
    map_id: &str,
    document: &mut AiAgentMapDocument,
) {
    let mut seen = HashSet::new();
    let stride = document.records.len().max(1);
    for (index, record) in document.records.iter_mut().enumerate() {
        let parsed = Uuid::parse_str(&record.id).is_ok();
        if !parsed || !seen.insert(record.id.clone()) {
            let mut seed = index;
            loop {
                record.id = legacy_record_id(map_id, seed);
                if seen.insert(record.id.clone()) {
                    break;
                }
                seed = seed.saturating_add(stride);
            }
        }
    }
}

pub(super) fn recount(document: &mut AiAgentMapDocument) {
    document.total_count = document.records.len();
    document.valid_count = document
        .records
        .iter()
        .filter(|record| {
            record.latitude.is_some() && record.longitude.is_some()
        })
        .count();
    document.invalid_count = document.total_count - document.valid_count;
    document.warnings = document
        .records
        .iter()
        .enumerate()
        .flat_map(|(index, record)| {
            record
                .warnings
                .iter()
                .map(move |warning| format!("Рядок {}: {warning}", index + 1))
        })
        .collect();
}

pub(super) fn apply_patch(
    document: &AiAgentMapDocument,
    operations: &[AiAgentMapPatchOp],
) -> Result<PatchOutcome, EditFailure> {
    if operations.is_empty() {
        return Err(EditFailure::Reject(
            "Потрібна хоча б одна зміна".to_string(),
        ));
    }
    let mut next = document.clone();
    let mut matched_ids = Vec::new();
    for operation in operations {
        let ids = apply_operation(&mut next, operation)?;
        for id in ids {
            if !matched_ids.contains(&id) {
                matched_ids.push(id);
            }
        }
    }
    if next.records.len() > AI_AGENT_MAP_MAX_RECORDS {
        return Err(EditFailure::Reject(format!(
            "Мапа може містити щонайбільше {AI_AGENT_MAP_MAX_RECORDS} записів"
        )));
    }
    recount(&mut next);
    let diff = diff_documents(document, &next);
    Ok(PatchOutcome {
        document: next,
        diff,
        matched_ids,
    })
}

fn apply_operation(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    match operation.op.as_str() {
        "add" => add_record(document, operation),
        "update" => update_records(document, operation),
        "remove" => remove_records(document, operation),
        // A full SIDC sent as setComponents is what the caller meant by setSidc.
        "setComponents"
            if operation.components.is_none() && operation.sidc.is_some() =>
        {
            set_sidc(document, operation)
        }
        "setComponents" => set_components(document, operation),
        "setSidc" => set_sidc(document, operation),
        "setTitle" => set_title(document, operation),
        _ => Err(EditFailure::Reject(
            "Невідома операція редагування мапи".to_string(),
        )),
    }
}

fn add_record(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    let input = operation.record.clone().ok_or_else(|| {
        EditFailure::Reject("Нова точка потребує запису".to_string())
    })?;
    let missing_y =
        input.y.trim().is_empty() && !prepare::is_whole_position(&input.x);
    if input.x.trim().is_empty() || missing_y {
        return Err(EditFailure::Clarify(
            "Потрібні координати нової точки. Вкажіть їх або одне доступне джерело з координатами.".to_string(),
        ));
    }
    if document.records.len() >= AI_AGENT_MAP_MAX_RECORDS {
        return Err(EditFailure::Reject(format!(
            "Мапа може містити щонайбільше {AI_AGENT_MAP_MAX_RECORDS} записів"
        )));
    }
    let mut record = prepare::prepare_record(input)
        .map_err(|error| EditFailure::Reject(error.to_string()))?;
    record.id = new_record_id(document);
    let id = record.id.clone();
    document.records.push(record);
    Ok(vec![id])
}

fn new_record_id(document: &AiAgentMapDocument) -> String {
    loop {
        let id = Uuid::now_v7().to_string();
        if document.records.iter().all(|record| record.id != id) {
            return id;
        }
    }
}

fn update_records(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    let fields = operation.fields.clone().unwrap_or_default();
    let sidc = operation
        .sidc
        .as_deref()
        .map(str::trim)
        .filter(|sidc| !sidc.is_empty());
    if sidc.is_none() && !field_patch_present(&fields) {
        return Err(EditFailure::Reject(
            "Оновлення не містить змін. Для позначки передайте 20-значний SIDC."
                .to_string(),
        ));
    }
    let indexes = resolve_selector(document, operation.selector.as_ref())?;
    for index in &indexes {
        let mut record = document.records[*index].clone();
        apply_fields(&mut record, &fields)?;
        if let Some(sidc) = sidc {
            assign_sidc(&mut record, sidc)?;
        }
        document.records[*index] = record;
    }
    Ok(ids_at(document, &indexes))
}

fn field_patch_present(fields: &AiAgentMapFieldPatch) -> bool {
    fields.name.is_some()
        || fields.observation_datetime.is_some()
        || fields.clear_observation_datetime
        || fields.comments.is_some()
        || fields.coordinate_system.is_some()
        || fields.x.is_some()
        || fields.y.is_some()
}

fn remove_records(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    let indexes = resolve_selector(document, operation.selector.as_ref())?;
    let ids = ids_at(document, &indexes);
    let remove = ids.iter().cloned().collect::<HashSet<_>>();
    document
        .records
        .retain(|record| !remove.contains(&record.id));
    Ok(ids)
}

fn set_components(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    let components = operation.components.clone().ok_or_else(|| {
        EditFailure::Reject("Потрібні компоненти SIDC".to_string())
    })?;
    if component_count(&components) == 0 {
        return Err(EditFailure::Reject(
            "Потрібен хоча б один компонент SIDC".to_string(),
        ));
    }
    let indexes = resolve_selector(document, operation.selector.as_ref())?;
    for index in &indexes {
        let sidc =
            splice_components(&document.records[*index].sidc, &components)?;
        assign_sidc(&mut document.records[*index], &sidc)?;
    }
    Ok(ids_at(document, &indexes))
}

fn set_sidc(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    let sidc = operation
        .sidc
        .clone()
        .ok_or_else(|| EditFailure::Reject("Потрібен SIDC".to_string()))?;
    let indexes = resolve_selector(document, operation.selector.as_ref())?;
    for index in &indexes {
        assign_sidc(&mut document.records[*index], &sidc)?;
    }
    Ok(ids_at(document, &indexes))
}

fn set_title(
    document: &mut AiAgentMapDocument,
    operation: &AiAgentMapPatchOp,
) -> Result<Vec<String>, EditFailure> {
    let title = operation.title.as_deref().map(str::trim).unwrap_or("");
    if title.is_empty() || title.chars().count() > AI_AGENT_MAP_TEXT_MAX_CHARS {
        return Err(EditFailure::Reject(
            "Назва мапи порожня або задовга".to_string(),
        ));
    }
    document.title = title.to_string();
    Ok(Vec::new())
}

fn ids_at(document: &AiAgentMapDocument, indexes: &[usize]) -> Vec<String> {
    indexes
        .iter()
        .map(|index| document.records[*index].id.clone())
        .collect()
}

fn apply_fields(
    record: &mut AiAgentMapRecord,
    fields: &AiAgentMapFieldPatch,
) -> Result<(), EditFailure> {
    if let Some(name) = &fields.name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > AI_AGENT_MAP_TEXT_MAX_CHARS
        {
            return Err(EditFailure::Reject(
                "Назва точки порожня або задовга".to_string(),
            ));
        }
        record.name = name.to_string();
    }
    if fields.clear_observation_datetime {
        record.observation_datetime = None;
        record
            .warnings
            .retain(|warning| !warning.starts_with("Некоректна дата"));
    } else if let Some(value) = &fields.observation_datetime {
        let mut warnings = Vec::new();
        record.observation_datetime =
            prepare_datetime(Some(value), &mut warnings);
        record
            .warnings
            .retain(|warning| !warning.starts_with("Некоректна дата"));
        record.warnings.extend(warnings);
    }
    if let Some(comments) = fields.comments.clone() {
        record.comments = normalize_comments(comments)
            .map_err(|error| EditFailure::Reject(error.to_string()))?;
    }
    if fields.coordinate_system.is_some()
        || fields.x.is_some()
        || fields.y.is_some()
    {
        let system = fields
            .coordinate_system
            .clone()
            .unwrap_or_else(|| record.coordinate_system.clone());
        let x = fields
            .x
            .clone()
            .unwrap_or_else(|| record.original_x.clone());
        // A whole position in X replaces the old pair, so the old Y must go.
        let y = fields.y.clone().unwrap_or_else(|| {
            if fields
                .x
                .as_deref()
                .is_some_and(|x| prepare::replaces_y(x, record))
            {
                String::new()
            } else {
                record.original_y.clone()
            }
        });
        refresh_coordinates(record, &system, &x, &y)
            .map_err(|error| EditFailure::Reject(error.to_string()))?;
    }
    Ok(())
}

fn prepare_datetime(
    value: Option<&str>,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty())?;
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(format!("{date}T00:00:00"));
    }
    if let Ok(datetime) =
        chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
    {
        return Some(datetime.format("%Y-%m-%dT%H:%M:%S").to_string());
    }
    if let Ok(datetime) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(
            datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        );
    }
    warnings.push(
        "Некоректна дата спостереження або час без дати; дату не вигадано"
            .to_string(),
    );
    None
}

fn assign_sidc(
    record: &mut AiAgentMapRecord,
    sidc: &str,
) -> Result<(), EditFailure> {
    if sidc.len() != 20 || !sidc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EditFailure::Reject(
            "SIDC має містити 20 цифр".to_string(),
        ));
    }
    record.sidc = sidc.to_string();
    record
        .warnings
        .retain(|warning| warning != MISSING_SIDC_WARNING);
    Ok(())
}

fn component_count(components: &AiAgentMapSidcComponents) -> usize {
    [
        components.group1.as_ref(),
        components.context.as_ref(),
        components.identity.as_ref(),
        components.symbol_set.as_ref(),
        components.status.as_ref(),
        components.headquarters_or_task_force.as_ref(),
        components.echelon.as_ref(),
        components.main_icon.as_ref(),
        components.modifier1.as_ref(),
        components.modifier2.as_ref(),
    ]
    .into_iter()
    .filter(|value| value.is_some())
    .count()
}

fn splice_components(
    sidc: &str,
    components: &AiAgentMapSidcComponents,
) -> Result<String, EditFailure> {
    let parsed = crate::icons::parse_app6d(sidc).map_err(|_| {
        EditFailure::Reject("SIDC має містити 20 цифр".to_string())
    })?;
    let parts = [
        replace_part(&parsed.group1, &components.group1, 2)?,
        replace_part(&parsed.context, &components.context, 1)?,
        replace_part(&parsed.identity, &components.identity, 1)?,
        replace_part(&parsed.symbol_set, &components.symbol_set, 2)?,
        replace_part(&parsed.status, &components.status, 1)?,
        replace_part(
            &parsed.headquaters_or_task_force,
            &components.headquarters_or_task_force,
            1,
        )?,
        replace_part(
            &parsed.echelon_or_mobility_or_towed_array,
            &components.echelon,
            2,
        )?,
        replace_part(&parsed.main_icon, &components.main_icon, 6)?,
        replace_part(&parsed.modifier1, &components.modifier1, 2)?,
        replace_part(&parsed.modifier2, &components.modifier2, 2)?,
    ];
    Ok(parts.concat())
}

fn replace_part(
    current: &str,
    next: &Option<String>,
    width: usize,
) -> Result<String, EditFailure> {
    let Some(next) = next else {
        return Ok(current.to_string());
    };
    if next.len() != width || !next.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EditFailure::Reject(format!(
            "Компонент SIDC має містити {width} цифр"
        )));
    }
    Ok(next.clone())
}

fn resolve_selector(
    document: &AiAgentMapDocument,
    selector: Option<&AiAgentMapSelector>,
) -> Result<Vec<usize>, EditFailure> {
    let selector = selector.ok_or_else(|| {
        EditFailure::Reject("Потрібен вибір точки".to_string())
    })?;
    if !selector.all
        && selector.ids.is_empty()
        && selector.names.is_empty()
        && selector.sidc.is_none()
    {
        return Err(EditFailure::Reject("Потрібен вибір точки".to_string()));
    }
    let indexes = if selector.all {
        (0..document.records.len()).collect::<Vec<_>>()
    } else if !selector.ids.is_empty() {
        indexes_by_id(document, &selector.ids)?
    } else {
        document
            .records
            .iter()
            .enumerate()
            .filter(|(_, record)| {
                (selector.names.is_empty()
                    || selector
                        .names
                        .iter()
                        .any(|name| name.trim() == record.name))
                    && selector
                        .sidc
                        .as_ref()
                        .is_none_or(|sidc| sidc == &record.sidc)
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>()
    };
    if !selector.all && indexes.is_empty() {
        return Err(EditFailure::Clarify(
            "Точки за цим вибором не знайдено. Уточніть запис.".to_string(),
        ));
    }
    if expect_one(selector) && indexes.len() != 1 {
        return Err(EditFailure::Clarify(ambiguity(document, &indexes)));
    }
    Ok(indexes)
}

fn indexes_by_id(
    document: &AiAgentMapDocument,
    ids: &[String],
) -> Result<Vec<usize>, EditFailure> {
    let mut indexes = Vec::new();
    for id in ids {
        let index = document
            .records
            .iter()
            .position(|record| record.id == *id)
            .ok_or_else(|| {
                EditFailure::Clarify(format!(
                    "Точку {id} не знайдено. Уточніть запис."
                ))
            })?;
        if !indexes.contains(&index) {
            indexes.push(index);
        }
    }
    Ok(indexes)
}

fn expect_one(selector: &AiAgentMapSelector) -> bool {
    match selector.expect.as_deref() {
        Some("one") => true,
        Some("many") => false,
        _ => {
            !selector.all && selector.ids.is_empty() && selector.sidc.is_none()
        }
    }
}

fn ambiguity(document: &AiAgentMapDocument, indexes: &[usize]) -> String {
    let sample = indexes
        .iter()
        .take(8)
        .map(|index| {
            let record = &document.records[*index];
            format!("{} ({})", record.id, record.name)
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Уточніть точку: вибір відповідає {} записам: {sample}.",
        indexes.len()
    )
}

pub(super) fn diff_documents(
    before: &AiAgentMapDocument,
    after: &AiAgentMapDocument,
) -> AiAgentMapEditDiff {
    let before_by_id = before
        .records
        .iter()
        .map(|record| (record.id.clone(), record))
        .collect::<HashMap<_, _>>();
    let after_ids = after
        .records
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();
    let mut changes = Vec::new();
    for record in &after.records {
        match before_by_id.get(&record.id) {
            None => changes.push(change(record, "add", None, Some(record))),
            Some(previous) if *previous != record => changes.push(change(
                record,
                "update",
                Some(previous),
                Some(record),
            )),
            Some(_) => {}
        }
    }
    for record in &before.records {
        if !after_ids.contains(&record.id) {
            changes.push(change(record, "remove", Some(record), None));
        }
    }
    AiAgentMapEditDiff {
        added_count: changes.iter().filter(|item| item.kind == "add").count(),
        updated_count: changes
            .iter()
            .filter(|item| item.kind == "update")
            .count(),
        removed_count: changes
            .iter()
            .filter(|item| item.kind == "remove")
            .count(),
        changes,
    }
}

fn change(
    anchor: &AiAgentMapRecord,
    kind: &str,
    before: Option<&AiAgentMapRecord>,
    after: Option<&AiAgentMapRecord>,
) -> AiAgentMapEditChange {
    let point = after.or(before).unwrap_or(anchor);
    AiAgentMapEditChange {
        id: anchor.id.clone(),
        name: point.name.clone(),
        kind: kind.to_string(),
        latitude: point.latitude,
        longitude: point.longitude,
        fields: field_changes(kind, before, after),
    }
}

fn field_changes(
    kind: &str,
    before: Option<&AiAgentMapRecord>,
    after: Option<&AiAgentMapRecord>,
) -> Vec<AiAgentMapFieldChange> {
    match (kind, before, after) {
        ("update", Some(before), Some(after)) => compared_fields(before, after),
        ("add", _, Some(after)) => vec![
            field("name", "", &after.name),
            field("sidc", "", &after.sidc),
            field("x", "", &after.original_x),
            field("y", "", &after.original_y),
        ],
        ("remove", Some(before), _) => vec![
            field("name", &before.name, ""),
            field("sidc", &before.sidc, ""),
        ],
        _ => Vec::new(),
    }
}

fn compared_fields(
    before: &AiAgentMapRecord,
    after: &AiAgentMapRecord,
) -> Vec<AiAgentMapFieldChange> {
    let mut fields = Vec::new();
    compare(&mut fields, "sidc", &before.sidc, &after.sidc);
    compare(&mut fields, "name", &before.name, &after.name);
    compare(
        &mut fields,
        "observationDatetime",
        before.observation_datetime.as_deref().unwrap_or(""),
        after.observation_datetime.as_deref().unwrap_or(""),
    );
    compare(
        &mut fields,
        "coordinateSystem",
        &before.coordinate_system,
        &after.coordinate_system,
    );
    compare(&mut fields, "x", &before.original_x, &after.original_x);
    compare(&mut fields, "y", &before.original_y, &after.original_y);
    compare(
        &mut fields,
        "comments",
        &before.comments.join("\n"),
        &after.comments.join("\n"),
    );
    fields
}

fn compare(
    fields: &mut Vec<AiAgentMapFieldChange>,
    name: &str,
    before: &str,
    after: &str,
) {
    if before != after {
        fields.push(field(name, before, after));
    }
}

fn field(name: &str, before: &str, after: &str) -> AiAgentMapFieldChange {
    AiAgentMapFieldChange {
        field: name.to_string(),
        before: before.to_string(),
        after: after.to_string(),
    }
}

pub(super) fn valid_idempotency_key(key: &str) -> bool {
    (8..=128).contains(&key.len())
        && key.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
        })
}

pub(super) fn capped_changes(
    diff: &AiAgentMapEditDiff,
    limit: usize,
) -> (Vec<AiAgentMapEditChange>, bool) {
    let truncated = diff.changes.len() > limit;
    (
        diff.changes.iter().take(limit).cloned().collect(),
        truncated,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_agent::maps::prepare::prepare_record;

    fn input(name: &str, x: &str, y: &str) -> AiAgentMapRecordInput {
        AiAgentMapRecordInput {
            sidc: "10062000001209020000".to_string(),
            name: name.to_string(),
            observation_datetime: Some("2026-09-28".to_string()),
            coordinate_system: "msk2000".to_string(),
            x: x.to_string(),
            y: y.to_string(),
            comments: vec!["коментар".to_string()],
            sources: Vec::new(),
            file_sources: Vec::new(),
        }
    }

    fn sample(count: usize) -> AiAgentMapDocument {
        let alpha =
            prepare_record(input("Альфа", "5215227", "6548669")).unwrap();
        let beta = prepare_record(input("Бета", "5214301", "6549102")).unwrap();
        let invalid =
            prepare_record(input("Збій", "521522", "6548669")).unwrap();
        let mut records = Vec::with_capacity(count);
        for index in 0..count {
            let mut record = if index + 1 == count {
                invalid.clone()
            } else if index % 2 == 0 {
                alpha.clone()
            } else {
                beta.clone()
            };
            record.name = format!("Точка {index}");
            records.push(record);
        }
        if count > 1 {
            records[1] = records[0].clone();
            records[1].name = records[0].name.clone();
        }
        // Simulate records published before ids were assigned at preparation.
        for record in &mut records {
            record.id.clear();
        }
        let mut document = AiAgentMapDocument {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            title: "Мапа".to_string(),
            is_main: true,
            records,
            warnings: Vec::new(),
            total_count: 0,
            valid_count: 0,
            invalid_count: 0,
        };
        let map_id = document.id.clone();
        assign_stable_ids(&map_id, &mut document);
        recount(&mut document);
        document
    }

    fn sidc_op(expect: &str) -> AiAgentMapPatchOp {
        AiAgentMapPatchOp {
            op: "setComponents".to_string(),
            selector: Some(AiAgentMapSelector {
                all: true,
                expect: Some(expect.to_string()),
                ..AiAgentMapSelector::default()
            }),
            record: None,
            fields: None,
            components: Some(AiAgentMapSidcComponents {
                identity: Some("3".to_string()),
                ..AiAgentMapSidcComponents::default()
            }),
            sidc: None,
            title: None,
        }
    }

    #[test]
    fn legacy_ids_are_stable_and_independent_of_later_coordinates() {
        let mut document = sample(2);
        let first = document.records[0].id.clone();
        let second = document.records[1].id.clone();
        assert_ne!(first, second);
        document.records[0].original_x = "0000000".to_string();
        document.records.swap(0, 1);
        let mut again = sample(2);
        let map_id = again.id.clone();
        assign_stable_ids(&map_id, &mut again);
        assert_eq!(again.records[0].id, first);
        assert_eq!(again.records[1].id, second);
    }

    #[test]
    fn combined_edits_leave_untouched_records_identical() {
        for count in [100, 512] {
            let document = sample(count);
            let remove_id = document.records[4].id.clone();
            let kept = document.records[7].clone();
            let coincident = document.records[1].clone();
            let invalid = document.records[count - 1].clone();
            let outcome = apply_patch(
                &document,
                &[
                    sidc_op("many"),
                    AiAgentMapPatchOp {
                        op: "remove".to_string(),
                        selector: Some(AiAgentMapSelector {
                            ids: vec![remove_id],
                            expect: Some("many".to_string()),
                            ..AiAgentMapSelector::default()
                        }),
                        record: None,
                        fields: None,
                        components: None,
                        sidc: None,
                        title: None,
                    },
                    AiAgentMapPatchOp {
                        op: "add".to_string(),
                        selector: None,
                        record: Some(input("Нова", "5215227", "6548669")),
                        fields: None,
                        components: None,
                        sidc: None,
                        title: None,
                    },
                ],
            )
            .unwrap();
            assert_eq!(outcome.document.records.len(), count);
            assert_eq!(outcome.diff.updated_count, count - 1);
            assert_eq!(outcome.diff.removed_count, 1);
            assert_eq!(outcome.diff.added_count, 1);
            let kept_after = outcome
                .document
                .records
                .iter()
                .find(|record| record.id == kept.id)
                .unwrap();
            assert_eq!(kept_after.original_x, kept.original_x);
            assert_eq!(kept_after.original_y, kept.original_y);
            assert_eq!(kept_after.comments, kept.comments);
            assert_eq!(kept_after.sources, kept.sources);
            assert_eq!(kept_after.latitude, kept.latitude);
            assert_eq!(kept_after.longitude, kept.longitude);
            assert_eq!(kept_after.sidc, "10032000001209020000");
            assert_ne!(kept.sidc, kept_after.sidc);
            let pair = outcome
                .document
                .records
                .iter()
                .find(|record| record.id == coincident.id)
                .unwrap();
            assert_eq!(
                (pair.original_x.as_str(), pair.original_y.as_str()),
                (
                    coincident.original_x.as_str(),
                    coincident.original_y.as_str()
                )
            );
            assert_ne!(pair.id, kept.id);
            let invalid_after = outcome
                .document
                .records
                .iter()
                .find(|record| record.id == invalid.id)
                .unwrap();
            assert_eq!(invalid_after.x, "INVALID");
            assert_eq!(invalid_after.original_x, invalid.original_x);
            assert!(invalid_after.latitude.is_none());
            assert_eq!(invalid_after.warnings, {
                let mut warnings = invalid.warnings.clone();
                warnings.retain(|warning| warning != MISSING_SIDC_WARNING);
                warnings
            });
        }
    }

    #[test]
    fn ambiguous_selection_and_missing_coordinates_do_not_change_the_document()
    {
        let document = sample(4);
        let ambiguous = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "remove".to_string(),
                selector: Some(AiAgentMapSelector {
                    names: vec!["Точка 0".to_string()],
                    ..AiAgentMapSelector::default()
                }),
                record: None,
                fields: None,
                components: None,
                sidc: None,
                title: None,
            }],
        );
        assert!(matches!(ambiguous, Err(EditFailure::Clarify(_))));
        let mut missing = input("Нова", "5215227", "6548669");
        missing.x.clear();
        let added = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "add".to_string(),
                selector: None,
                record: Some(missing),
                fields: None,
                components: None,
                sidc: None,
                title: None,
            }],
        );
        assert!(matches!(added, Err(EditFailure::Clarify(_))));
        assert_eq!(document.records.len(), 4);
    }

    fn add_op(record: AiAgentMapRecordInput) -> AiAgentMapPatchOp {
        AiAgentMapPatchOp {
            op: "add".to_string(),
            selector: None,
            record: Some(record),
            fields: None,
            components: None,
            sidc: None,
            title: None,
        }
    }

    #[test]
    fn issue_4038_a_new_point_can_be_one_whole_position() {
        let document = sample(2);
        for x in ["36T XT 79584 68848", "47.54821, 35.38674"] {
            let outcome =
                apply_patch(&document, &[add_op(input("Нова", x, ""))])
                    .unwrap();
            let added = outcome.document.records.last().unwrap();
            assert!(added.latitude.is_some(), "{x}");
        }
        let partial =
            apply_patch(&document, &[add_op(input("Нова", "5215227", ""))]);
        assert!(matches!(partial, Err(EditFailure::Clarify(_))));
    }

    #[test]
    fn issue_4038_editing_a_split_mgrs_easting_keeps_its_y() {
        let document = sample(2);
        let update = |fields| AiAgentMapPatchOp {
            op: "update".to_string(),
            selector: Some(AiAgentMapSelector {
                ids: vec![document.records[0].id.clone()],
                ..Default::default()
            }),
            record: None,
            fields: Some(fields),
            components: None,
            sidc: None,
            title: None,
        };
        let split = apply_patch(
            &document,
            &[update(AiAgentMapFieldPatch {
                x: Some("36T XT 79584".to_string()),
                y: Some("68848".to_string()),
                ..Default::default()
            })],
        )
        .unwrap();
        let moved = apply_patch(
            &split.document,
            &[update(AiAgentMapFieldPatch {
                x: Some("36T XT 79585".to_string()),
                ..Default::default()
            })],
        )
        .unwrap();
        let record = &moved.document.records[0];
        assert_eq!(record.coordinate_system, "mgrs");
        assert_eq!(record.original_y, "68848");
        assert!(record.latitude.is_some());
    }

    #[test]
    fn issue_4038_a_grid_y_never_joins_a_new_mgrs_reference() {
        let document = sample(2);
        let update = |fields| AiAgentMapPatchOp {
            op: "update".to_string(),
            selector: Some(AiAgentMapSelector {
                ids: vec![document.records[0].id.clone()],
                ..Default::default()
            }),
            record: None,
            fields: Some(fields),
            components: None,
            sidc: None,
            title: None,
        };
        let invalid = apply_patch(
            &document,
            &[update(AiAgentMapFieldPatch {
                x: Some("5215227".to_string()),
                y: Some("6884".to_string()),
                ..Default::default()
            })],
        )
        .unwrap();
        let moved = apply_patch(
            &invalid.document,
            &[update(AiAgentMapFieldPatch {
                x: Some("36TXT7968".to_string()),
                ..Default::default()
            })],
        )
        .unwrap();
        assert_eq!(moved.document.records[0].original_y, "");
    }

    #[test]
    fn issue_4038_moving_a_point_to_mgrs_drops_the_old_y() {
        let document = sample(2);
        let outcome = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "update".to_string(),
                selector: Some(AiAgentMapSelector {
                    ids: vec![document.records[0].id.clone()],
                    ..Default::default()
                }),
                record: None,
                fields: Some(AiAgentMapFieldPatch {
                    x: Some("36TXT7958468848".to_string()),
                    ..Default::default()
                }),
                components: None,
                sidc: None,
                title: None,
            }],
        )
        .unwrap();
        let moved = &outcome.document.records[0];
        assert_eq!(moved.coordinate_system, "mgrs");
        assert_eq!(moved.original_y, "");
        assert!(moved.latitude.is_some());
    }

    #[test]
    fn a_failed_later_operation_keeps_the_input_document() {
        let document = sample(3);
        let error = apply_patch(
            &document,
            &[
                sidc_op("many"),
                AiAgentMapPatchOp {
                    op: "setSidc".to_string(),
                    selector: Some(AiAgentMapSelector {
                        ids: vec!["missing-id".to_string()],
                        expect: Some("many".to_string()),
                        ..AiAgentMapSelector::default()
                    }),
                    record: None,
                    fields: None,
                    components: None,
                    sidc: Some("10061000001211020000".to_string()),
                    title: None,
                },
            ],
        );
        assert!(error.is_err());
        assert_eq!(document.records[0].sidc, "10062000001209020000");
    }

    // Regression: https://github.com/echoua/echo/issues/3064
    #[test]
    fn set_components_with_only_a_sidc_sets_the_sidc() {
        let document = sample(3);
        let outcome = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "setComponents".to_string(),
                selector: Some(AiAgentMapSelector {
                    all: true,
                    ..AiAgentMapSelector::default()
                }),
                record: None,
                fields: None,
                components: None,
                sidc: Some("10031500001202000000".to_string()),
                title: None,
            }],
        )
        .unwrap();
        assert!(outcome
            .document
            .records
            .iter()
            .all(|record| record.sidc == "10031500001202000000"));
    }

    #[test]
    fn update_with_sidc_replaces_the_symbol_only() {
        let mut document = sample(2);
        for record in &mut document.records {
            record.sidc = crate::config::AI_AGENT_MAP_FALLBACK_SIDC.to_string();
            record.warnings = vec![MISSING_SIDC_WARNING.to_string()];
        }
        let before = document.clone();
        let outcome = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "update".to_string(),
                selector: Some(AiAgentMapSelector {
                    all: true,
                    expect: Some("many".to_string()),
                    ..AiAgentMapSelector::default()
                }),
                record: None,
                fields: None,
                components: None,
                sidc: Some("10062000001209020000".to_string()),
                title: None,
            }],
        )
        .unwrap();
        assert_eq!(outcome.diff.updated_count, 2);
        for (record, previous) in
            outcome.document.records.iter().zip(&before.records)
        {
            assert_eq!(record.sidc, "10062000001209020000");
            assert_eq!(record.name, previous.name);
            assert_eq!(record.original_x, previous.original_x);
            assert_eq!(record.original_y, previous.original_y);
            assert!(record
                .warnings
                .iter()
                .all(|warning| warning != MISSING_SIDC_WARNING));
        }
    }

    #[test]
    fn update_without_fields_or_sidc_is_rejected() {
        let document = sample(1);
        let error = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "update".to_string(),
                selector: Some(AiAgentMapSelector {
                    all: true,
                    expect: Some("many".to_string()),
                    ..AiAgentMapSelector::default()
                }),
                record: None,
                fields: None,
                components: None,
                sidc: None,
                title: None,
            }],
        );
        assert!(matches!(error, Err(EditFailure::Reject(_))));
    }

    #[test]
    fn coordinate_edits_reproject_only_the_selected_record() {
        let document = sample(3);
        let sentinel = 12.25_f64;
        let mut document = document;
        document.records[2].latitude = Some(sentinel);
        let outcome = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "update".to_string(),
                selector: Some(AiAgentMapSelector {
                    ids: vec![document.records[0].id.clone()],
                    expect: Some("one".to_string()),
                    ..AiAgentMapSelector::default()
                }),
                record: None,
                fields: Some(AiAgentMapFieldPatch {
                    x: Some("5214301".to_string()),
                    ..AiAgentMapFieldPatch::default()
                }),
                components: None,
                sidc: None,
                title: None,
            }],
        )
        .unwrap();
        assert_ne!(
            outcome.document.records[0].original_x,
            document.records[0].original_x
        );
        assert_eq!(outcome.document.records[1], document.records[1]);
        assert_eq!(outcome.document.records[2].latitude, Some(sentinel));
        assert_eq!(outcome.document.records[2].sidc, document.records[2].sidc);
    }

    #[test]
    fn empty_result_keeps_header_csv_and_disables_kmz() {
        let document = sample(1);
        let outcome = apply_patch(
            &document,
            &[AiAgentMapPatchOp {
                op: "remove".to_string(),
                selector: Some(AiAgentMapSelector {
                    all: true,
                    expect: Some("many".to_string()),
                    ..AiAgentMapSelector::default()
                }),
                record: None,
                fields: None,
                components: None,
                sidc: None,
                title: None,
            }],
        )
        .unwrap();
        assert!(outcome.document.records.is_empty());
        let csv = String::from_utf8(
            super::super::export::csv(&outcome.document).unwrap(),
        )
        .unwrap();
        assert!(csv.contains("sidc"));
        assert_eq!(csv.lines().count(), 1);
        assert!(super::super::export::kmz(
            &outcome.document,
            std::path::Path::new("."),
            &Default::default(),
        )
        .is_err());
    }
}

use crate::config::{
    read_config, ORBIT_IMPORT_COMBAT_UNIT_TYPE_FILE_NAME,
    ORBIT_IMPORT_GROUPING_OF_FORCES_FILE_NAME, ORBIT_IMPORT_STORAGE_PREFIX,
    ORBIT_IMPORT_UNITS_FILE_NAME, ORBIT_IMPORT_UNIT_ECHELON_FILE_NAME,
};
use crate::h;
use crate::orbit::dictionary::{
    collect_dictionary_values, normalize_dictionary, DictionaryEntries,
    DictionaryEntry, DictionaryKey, DictionaryKind,
};
use crate::orbit::types::{DictionaryValue, SourceUnit};
use crate::storage;
use crate::types::{Mode, ShortContext};
use anyhow::{Context, Result};
use arrow_array::{Array, ArrayRef, Int32Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use chrono::{NaiveDateTime, Utc};
use md5::{Digest, Md5};
use opendal::{EntryMode, Operator};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::arrow_writer::ArrowWriter;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::tempdir;
use tokio::fs;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug)]
pub struct OrbitSnapshot {
    pub units: Vec<SourceUnit>,
    pub dictionaries: DictionaryEntries,
    pub archive_md5: String,
}

#[derive(Debug)]
struct SnapshotStore {
    operator: Operator,
    location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NormalizedUnit {
    unit_id: Uuid,
    unit_name: Option<String>,
    unit_name_original: Option<String>,
    unit_name_short: Option<String>,
    operational_unit_name_full: Option<String>,
    generative_unit_name_full: Option<String>,
    unit_number: Option<String>,
    unit_alternate_names: Option<Vec<String>>,
    unit_alternate_numbers: Option<Vec<String>>,
    unit_echelon_id: Option<Uuid>,
    combat_unit_type_id: Option<Uuid>,
    grouping_of_forces_ids: Option<Vec<Uuid>>,
    operational_parent_units: Vec<NormalizedUnit>,
    generative_parent_units: Vec<NormalizedUnit>,
    path_level: Option<i32>,
}

pub async fn prepare_snapshot(
    mode: Mode,
    source_path: &Path,
) -> Result<String> {
    let store = SnapshotStore::new(mode).await.c(h!())?;
    let previous = store.latest_bytes().await.c(h!())?;
    let previous_dictionaries = match previous {
        Some((key, bytes)) => {
            log::info!("reading stable ORBIT dictionary IDs from {key}");
            read_archive_dictionaries(&bytes).c(h!())?
        }
        None => DictionaryEntries::new(),
    };
    let units = read_json_source(source_path).await.c(h!())?;
    let dictionaries =
        merge_dictionary_entries(&units, previous_dictionaries).c(h!())?;
    let bytes = create_archive(&units, &dictionaries).c(h!())?;
    let filename = format!("{}.zip", Utc::now().format("%Y%m%d_%H%M%S_%6f"));
    let key = format!("{ORBIT_IMPORT_STORAGE_PREFIX}/{filename}");
    log::info!("writing ORBIT import snapshot to {}/{key}", store.location);
    store.operator.write(&key, bytes).await.c(h!())?;
    let location = format!("{}/{}", store.location.trim_end_matches('/'), key);
    log::info!("stored ORBIT import snapshot at {location}");
    Ok(location)
}

pub async fn load_latest_snapshot(mode: Mode) -> Result<OrbitSnapshot> {
    let store = SnapshotStore::new(mode).await.c(h!())?;
    let (key, bytes) =
        store.latest_bytes().await.c(h!())?.ok_or_else(|| {
            anyhow::anyhow!(
                "no ORBIT import snapshot exists at {}/{}",
                store.location,
                ORBIT_IMPORT_STORAGE_PREFIX
            )
        })?;
    log::info!("loading ORBIT import snapshot {key}");
    read_archive(&bytes).c(h!())
}

impl SnapshotStore {
    async fn new(mode: Mode) -> Result<Self> {
        let config = read_config(mode).c(h!())?;
        if mode == Mode::Live {
            let models_config = config.ai_models_config.ok_or_else(|| {
                anyhow::anyhow!(
                    "ai_models_config is required for ORBIT snapshots"
                )
            })?;
            let s3_config = storage::S3Config::with_prefix(
                &models_config.s3_config,
                String::new(),
            );
            let location = format!("s3://{}", s3_config.bucket);
            let operator = storage::build_s3_operator(&s3_config).c(h!())?;
            return Ok(Self { operator, location });
        }

        let root = PathBuf::from(&config.storage_dir);
        fs::create_dir_all(&root).await.c(h!())?;
        let builder =
            opendal::services::Fs::default().root(&root.to_string_lossy());
        let operator = Operator::new(builder).c(h!())?.finish();
        Ok(Self {
            operator,
            location: root.display().to_string(),
        })
    }

    async fn latest_bytes(&self) -> Result<Option<(String, Vec<u8>)>> {
        let directory = format!("{ORBIT_IMPORT_STORAGE_PREFIX}/");
        log::info!(
            "checking for ORBIT import snapshots at {}/{}",
            self.location,
            ORBIT_IMPORT_STORAGE_PREFIX
        );
        self.operator.create_dir(&directory).await.c(h!())?;
        let entries = self.operator.list(&directory).await.c(h!())?;
        let latest = entries
            .into_iter()
            .filter(|entry| entry.metadata().mode() == EntryMode::FILE)
            .map(|entry| entry.path().to_string())
            .filter_map(|path| {
                snapshot_timestamp(&path).map(|timestamp| (timestamp, path))
            })
            .max_by_key(|(timestamp, _)| *timestamp)
            .map(|(_, path)| path);
        let Some(key) = latest else {
            return Ok(None);
        };
        let bytes = self.operator.read(&key).await.c(h!())?.to_vec();
        Ok(Some((key, bytes)))
    }
}

fn snapshot_timestamp(path: &str) -> Option<NaiveDateTime> {
    let filename = Path::new(path).file_name()?.to_str()?;
    let timestamp = filename.strip_suffix(".zip")?;
    NaiveDateTime::parse_from_str(timestamp, "%Y%m%d_%H%M%S_%6f").ok()
}

async fn read_json_source(path: &Path) -> Result<Vec<SourceUnit>> {
    log::info!("reading ORBIT JSON export from {}", path.display());
    let input = fs::read_to_string(path).await.with_context(|| {
        format!("failed to read ORBIT JSON export {}", path.display())
    })?;
    let (units, unknown_paths) =
        crate::orbit::types::parse_units(&input).c(h!())?;
    anyhow::ensure!(
        unknown_paths.is_empty(),
        "ORBIT JSON export {} contains unknown properties:\n{}",
        path.display(),
        unknown_paths
            .iter()
            .map(|path| format!("  - {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    crate::orbit::matching::validate_source(&units).c(h!())?;
    log::info!(
        "validated {} top-level ORBIT units from {}",
        units.len(),
        path.display()
    );
    Ok(units)
}

fn merge_dictionary_entries(
    units: &[SourceUnit],
    mut entries: DictionaryEntries,
) -> Result<DictionaryEntries> {
    validate_dictionary_entries(&entries).c(h!())?;
    let current = collect_dictionary_values(units).c(h!())?;
    for kind in DictionaryKind::all() {
        let entries = entries.entry(kind).or_default();
        let mut ids_by_key = entries
            .iter()
            .map(|entry| (entry.key_value(), entry.id))
            .collect::<BTreeMap<_, _>>();
        for key in current.get(&kind).into_iter().flatten() {
            if ids_by_key.contains_key(key) {
                continue;
            }
            let id = Uuid::new_v4();
            entries.push(DictionaryEntry {
                id,
                key: key.key.clone(),
                name: key.name.clone(),
            });
            ids_by_key.insert(key.clone(), id);
        }
        entries.sort_by(|left, right| {
            (&left.key, &left.name).cmp(&(&right.key, &right.name))
        });
    }
    Ok(entries)
}

fn validate_dictionary_entries(entries: &DictionaryEntries) -> Result<()> {
    for (kind, entries) in entries {
        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        for entry in entries {
            anyhow::ensure!(
                ids.insert(entry.id),
                "duplicate ID {} in {} snapshot dictionary",
                entry.id,
                kind.table_name()
            );
            anyhow::ensure!(
                keys.insert(entry.key_value()),
                "duplicate ({}, {}) in {} snapshot dictionary",
                entry.key,
                entry.name,
                kind.table_name()
            );
        }
    }
    Ok(())
}

fn create_archive(
    units: &[SourceUnit],
    dictionaries: &DictionaryEntries,
) -> Result<Vec<u8>> {
    let temp_dir = tempdir().c(h!())?;
    let data_dir = temp_dir.path().join("data");
    std::fs::create_dir(&data_dir).c(h!())?;
    for kind in DictionaryKind::all() {
        write_dictionary_parquet(
            &data_dir.join(dictionary_file_name(kind)),
            dictionaries
                .get(&kind)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        )
        .c(h!())?;
    }
    let lookup = dictionary_id_lookup(dictionaries);
    let units = units
        .iter()
        .map(|unit| NormalizedUnit::from_source(unit, &lookup))
        .collect::<Result<Vec<_>>>()
        .c(h!())?;
    write_units_parquet(&data_dir.join(ORBIT_IMPORT_UNITS_FILE_NAME), &units)
        .c(h!())?;

    let archive_path = temp_dir.path().join("orbit-import.zip");
    let archive = File::create(&archive_path).c(h!())?;
    let mut entries =
        WalkDir::new(&data_dir).into_iter().filter_map(|e| e.ok());
    crate::utils::zip::zip_dir(
        &mut entries,
        &data_dir.to_string_lossy(),
        archive,
        zip::CompressionMethod::Deflated,
    )
    .c(h!())?;
    std::fs::read(&archive_path).c(h!())
}

fn read_archive(bytes: &[u8]) -> Result<OrbitSnapshot> {
    let archive_md5 = format!("{:x}", Md5::digest(bytes));
    let temp_dir = extract_archive(bytes).c(h!())?;
    let dictionaries = read_dictionaries(temp_dir.path()).c(h!())?;
    let normalized =
        read_units_parquet(&temp_dir.path().join(ORBIT_IMPORT_UNITS_FILE_NAME))
            .c(h!())?;
    let dictionary_values = dictionary_values_by_id(&dictionaries);
    let units = normalized
        .iter()
        .map(|unit| unit.to_source(&dictionary_values))
        .collect::<Result<Vec<_>>>()
        .c(h!())?;
    crate::orbit::matching::validate_source(&units).c(h!())?;
    Ok(OrbitSnapshot {
        units,
        dictionaries,
        archive_md5,
    })
}

fn read_archive_dictionaries(bytes: &[u8]) -> Result<DictionaryEntries> {
    let temp_dir = extract_archive(bytes).c(h!())?;
    read_dictionaries(temp_dir.path())
}

fn extract_archive(bytes: &[u8]) -> Result<tempfile::TempDir> {
    let temp_dir = tempdir().c(h!())?;
    let archive_path = temp_dir.path().join("orbit-import.zip");
    std::fs::write(&archive_path, bytes).c(h!())?;
    crate::utils::zip::unzip(&archive_path).c(h!())?;
    Ok(temp_dir)
}

fn read_dictionaries(directory: &Path) -> Result<DictionaryEntries> {
    let mut dictionaries = DictionaryEntries::new();
    for kind in DictionaryKind::all() {
        let entries = read_dictionary_parquet(
            &directory.join(dictionary_file_name(kind)),
        )
        .c(h!())?;
        dictionaries.insert(kind, entries);
    }
    validate_dictionary_entries(&dictionaries).c(h!())?;
    Ok(dictionaries)
}

fn dictionary_file_name(kind: DictionaryKind) -> &'static str {
    match kind {
        DictionaryKind::GroupingOfForces => {
            ORBIT_IMPORT_GROUPING_OF_FORCES_FILE_NAME
        }
        DictionaryKind::CombatUnitType => {
            ORBIT_IMPORT_COMBAT_UNIT_TYPE_FILE_NAME
        }
        DictionaryKind::UnitEchelon => ORBIT_IMPORT_UNIT_ECHELON_FILE_NAME,
    }
}

fn dictionary_id_lookup(
    dictionaries: &DictionaryEntries,
) -> HashMap<(DictionaryKind, DictionaryKey), Uuid> {
    dictionaries
        .iter()
        .flat_map(|(kind, entries)| {
            entries
                .iter()
                .map(|entry| ((*kind, entry.key_value()), entry.id))
        })
        .collect()
}

fn dictionary_values_by_id(
    dictionaries: &DictionaryEntries,
) -> HashMap<(DictionaryKind, Uuid), DictionaryValue> {
    dictionaries
        .iter()
        .flat_map(|(kind, entries)| {
            entries.iter().map(|entry| {
                (
                    (*kind, entry.id),
                    DictionaryValue {
                        key: Value::String(entry.key.clone()),
                        name: Value::String(entry.name.clone()),
                    },
                )
            })
        })
        .collect()
}

impl NormalizedUnit {
    fn from_source(
        unit: &SourceUnit,
        dictionary_ids: &HashMap<(DictionaryKind, DictionaryKey), Uuid>,
    ) -> Result<Self> {
        Ok(Self {
            unit_id: unit.unit_id,
            unit_name: unit.unit_name.clone(),
            unit_name_original: unit.unit_name_original.clone(),
            unit_name_short: unit.unit_name_short.clone(),
            operational_unit_name_full: unit.operational_unit_name_full.clone(),
            generative_unit_name_full: unit.generative_unit_name_full.clone(),
            unit_number: unit.unit_number.clone(),
            unit_alternate_names: unit.unit_alternate_names.clone(),
            unit_alternate_numbers: unit.unit_alternate_numbers.clone(),
            unit_echelon_id: resolve_dictionary_id(
                DictionaryKind::UnitEchelon,
                unit.unit_echelon.as_ref(),
                dictionary_ids,
            )?,
            combat_unit_type_id: resolve_dictionary_id(
                DictionaryKind::CombatUnitType,
                unit.combat_unit_type.as_ref(),
                dictionary_ids,
            )?,
            grouping_of_forces_ids: unit
                .grouping_of_forces
                .as_deref()
                .map(|values| {
                    values
                        .iter()
                        .map(|value| {
                            resolve_dictionary_id(
                                DictionaryKind::GroupingOfForces,
                                Some(value),
                                dictionary_ids,
                            )?
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "grouping_of_forces ID is missing"
                                )
                            })
                        })
                        .collect()
                })
                .transpose()?,
            operational_parent_units: unit
                .operational_parent_units
                .iter()
                .map(|parent| Self::from_source(parent, dictionary_ids))
                .collect::<Result<Vec<_>>>()?,
            generative_parent_units: unit
                .generative_parent_units
                .iter()
                .map(|parent| Self::from_source(parent, dictionary_ids))
                .collect::<Result<Vec<_>>>()?,
            path_level: unit.path_level,
        })
    }

    fn to_source(
        &self,
        dictionary_values: &HashMap<(DictionaryKind, Uuid), DictionaryValue>,
    ) -> Result<SourceUnit> {
        Ok(SourceUnit {
            unit_id: self.unit_id,
            unit_name: self.unit_name.clone(),
            unit_name_original: self.unit_name_original.clone(),
            unit_name_short: self.unit_name_short.clone(),
            operational_unit_name_full: self.operational_unit_name_full.clone(),
            generative_unit_name_full: self.generative_unit_name_full.clone(),
            unit_number: self.unit_number.clone(),
            unit_alternate_names: self.unit_alternate_names.clone(),
            unit_alternate_numbers: self.unit_alternate_numbers.clone(),
            unit_echelon: restore_dictionary_value(
                DictionaryKind::UnitEchelon,
                self.unit_echelon_id,
                dictionary_values,
            )?,
            combat_unit_type: restore_dictionary_value(
                DictionaryKind::CombatUnitType,
                self.combat_unit_type_id,
                dictionary_values,
            )?,
            grouping_of_forces: self
                .grouping_of_forces_ids
                .as_deref()
                .map(|ids| {
                    ids.iter()
                        .map(|id| {
                            restore_dictionary_value(
                                DictionaryKind::GroupingOfForces,
                                Some(*id),
                                dictionary_values,
                            )?
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "grouping_of_forces value is missing"
                                )
                            })
                        })
                        .collect()
                })
                .transpose()?,
            operational_parent_units: self
                .operational_parent_units
                .iter()
                .map(|parent| parent.to_source(dictionary_values))
                .collect::<Result<Vec<_>>>()?,
            generative_parent_units: self
                .generative_parent_units
                .iter()
                .map(|parent| parent.to_source(dictionary_values))
                .collect::<Result<Vec<_>>>()?,
            path_level: self.path_level,
        })
    }
}

fn resolve_dictionary_id(
    kind: DictionaryKind,
    value: Option<&DictionaryValue>,
    dictionary_ids: &HashMap<(DictionaryKind, DictionaryKey), Uuid>,
) -> Result<Option<Uuid>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let key = normalize_dictionary(value)?;
    dictionary_ids
        .get(&(kind, key.clone()))
        .copied()
        .map(Some)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "missing normalized {} dictionary value ({}, {})",
                kind.table_name(),
                key.key,
                key.name
            )
        })
}

fn restore_dictionary_value(
    kind: DictionaryKind,
    id: Option<Uuid>,
    dictionary_values: &HashMap<(DictionaryKind, Uuid), DictionaryValue>,
) -> Result<Option<DictionaryValue>> {
    id.map(|id| {
        dictionary_values.get(&(kind, id)).cloned().ok_or_else(|| {
            anyhow::anyhow!("missing {} dictionary ID {id}", kind.table_name())
        })
    })
    .transpose()
}

fn write_dictionary_parquet(
    path: &Path,
    entries: &[DictionaryEntry],
) -> Result<()> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("key", DataType::Utf8, false),
        Field::new("name", DataType::Utf8, false),
    ]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(StringArray::from(
                entries
                    .iter()
                    .map(|entry| entry.id.to_string())
                    .collect::<Vec<_>>(),
            )) as ArrayRef,
            Arc::new(StringArray::from(
                entries
                    .iter()
                    .map(|entry| entry.key.clone())
                    .collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                entries
                    .iter()
                    .map(|entry| entry.name.clone())
                    .collect::<Vec<_>>(),
            )),
        ],
    )
    .c(h!())?;
    write_batch(path, schema, &batch)
}

fn read_dictionary_parquet(path: &Path) -> Result<Vec<DictionaryEntry>> {
    let mut result = Vec::new();
    for batch in read_batches(path).c(h!())? {
        let ids = string_column(&batch, "id").c(h!())?;
        let keys = string_column(&batch, "key").c(h!())?;
        let names = string_column(&batch, "name").c(h!())?;
        for row in 0..batch.num_rows() {
            let id = required_string(ids, row, "id").c(h!())?;
            result.push(DictionaryEntry {
                id: Uuid::parse_str(id).c(h!())?,
                key: required_string(keys, row, "key").c(h!())?.to_string(),
                name: required_string(names, row, "name").c(h!())?.to_string(),
            });
        }
    }
    Ok(result)
}

fn write_units_parquet(path: &Path, units: &[NormalizedUnit]) -> Result<()> {
    let fields = [
        ("unit_id", false),
        ("unit_name", true),
        ("unit_name_original", true),
        ("unit_name_short", true),
        ("operational_unit_name_full", true),
        ("generative_unit_name_full", true),
        ("unit_number", true),
        ("unit_alternate_names", true),
        ("unit_alternate_numbers", true),
        ("unit_echelon_id", true),
        ("combat_unit_type_id", true),
        ("grouping_of_forces_ids", true),
        ("operational_parent_units", false),
        ("generative_parent_units", false),
    ];
    let mut schema_fields = fields
        .iter()
        .map(|(name, nullable)| Field::new(*name, DataType::Utf8, *nullable))
        .collect::<Vec<_>>();
    schema_fields.push(Field::new("path_level", DataType::Int32, true));
    let schema = Arc::new(Schema::new(schema_fields));
    let columns = vec![
        string_array(units.iter().map(|unit| Some(unit.unit_id.to_string()))),
        string_array(units.iter().map(|unit| unit.unit_name.clone())),
        string_array(units.iter().map(|unit| unit.unit_name_original.clone())),
        string_array(units.iter().map(|unit| unit.unit_name_short.clone())),
        string_array(
            units
                .iter()
                .map(|unit| unit.operational_unit_name_full.clone()),
        ),
        string_array(
            units
                .iter()
                .map(|unit| unit.generative_unit_name_full.clone()),
        ),
        string_array(units.iter().map(|unit| unit.unit_number.clone())),
        json_array(
            units.iter().map(|unit| unit.unit_alternate_names.as_ref()),
        )?,
        json_array(
            units
                .iter()
                .map(|unit| unit.unit_alternate_numbers.as_ref()),
        )?,
        string_array(
            units
                .iter()
                .map(|unit| unit.unit_echelon_id.map(|id| id.to_string())),
        ),
        string_array(
            units
                .iter()
                .map(|unit| unit.combat_unit_type_id.map(|id| id.to_string())),
        ),
        json_array(
            units
                .iter()
                .map(|unit| unit.grouping_of_forces_ids.as_ref()),
        )?,
        json_array_required(
            units.iter().map(|unit| &unit.operational_parent_units),
        )?,
        json_array_required(
            units.iter().map(|unit| &unit.generative_parent_units),
        )?,
        Arc::new(Int32Array::from(
            units.iter().map(|unit| unit.path_level).collect::<Vec<_>>(),
        )) as ArrayRef,
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns).c(h!())?;
    write_batch(path, schema, &batch)
}

fn read_units_parquet(path: &Path) -> Result<Vec<NormalizedUnit>> {
    let mut result = Vec::new();
    for batch in read_batches(path).c(h!())? {
        let unit_ids = string_column(&batch, "unit_id").c(h!())?;
        let unit_names = string_column(&batch, "unit_name").c(h!())?;
        let original_names =
            string_column(&batch, "unit_name_original").c(h!())?;
        let short_names = string_column(&batch, "unit_name_short").c(h!())?;
        let operational_names =
            string_column(&batch, "operational_unit_name_full").c(h!())?;
        let generative_names =
            string_column(&batch, "generative_unit_name_full").c(h!())?;
        let unit_numbers = string_column(&batch, "unit_number").c(h!())?;
        let alternate_names =
            string_column(&batch, "unit_alternate_names").c(h!())?;
        let alternate_numbers =
            string_column(&batch, "unit_alternate_numbers").c(h!())?;
        let echelon_ids = string_column(&batch, "unit_echelon_id").c(h!())?;
        let combat_ids =
            string_column(&batch, "combat_unit_type_id").c(h!())?;
        let grouping_ids =
            string_column(&batch, "grouping_of_forces_ids").c(h!())?;
        let operational_parents =
            string_column(&batch, "operational_parent_units").c(h!())?;
        let generative_parents =
            string_column(&batch, "generative_parent_units").c(h!())?;
        let path_levels = batch
            .column_by_name("path_level")
            .and_then(|column| column.as_any().downcast_ref::<Int32Array>())
            .ok_or_else(|| {
                anyhow::anyhow!("missing Int32 path_level column")
            })?;
        for row in 0..batch.num_rows() {
            let unit_id = required_string(unit_ids, row, "unit_id").c(h!())?;
            result.push(NormalizedUnit {
                unit_id: Uuid::parse_str(unit_id).c(h!())?,
                unit_name: optional_string(unit_names, row),
                unit_name_original: optional_string(original_names, row),
                unit_name_short: optional_string(short_names, row),
                operational_unit_name_full: optional_string(
                    operational_names,
                    row,
                ),
                generative_unit_name_full: optional_string(
                    generative_names,
                    row,
                ),
                unit_number: optional_string(unit_numbers, row),
                unit_alternate_names: optional_json(alternate_names, row)?,
                unit_alternate_numbers: optional_json(alternate_numbers, row)?,
                unit_echelon_id: optional_uuid(echelon_ids, row)?,
                combat_unit_type_id: optional_uuid(combat_ids, row)?,
                grouping_of_forces_ids: optional_json(grouping_ids, row)?,
                operational_parent_units: required_json(
                    operational_parents,
                    row,
                    "operational_parent_units",
                )?,
                generative_parent_units: required_json(
                    generative_parents,
                    row,
                    "generative_parent_units",
                )?,
                path_level: (!path_levels.is_null(row))
                    .then(|| path_levels.value(row)),
            });
        }
    }
    Ok(result)
}

fn write_batch(
    path: &Path,
    schema: Arc<Schema>,
    batch: &RecordBatch,
) -> Result<()> {
    let file = File::create(path).c(h!())?;
    let mut writer = ArrowWriter::try_new(file, schema, None).c(h!())?;
    writer.write(batch).c(h!())?;
    writer.close().c(h!())?;
    Ok(())
}

fn read_batches(path: &Path) -> Result<Vec<RecordBatch>> {
    let file = File::open(path).c(h!())?;
    ParquetRecordBatchReaderBuilder::try_new(file)
        .c(h!())?
        .build()
        .c(h!())?
        .collect::<std::result::Result<Vec<_>, arrow_schema::ArrowError>>()
        .c(h!())
}

fn string_array(values: impl Iterator<Item = Option<String>>) -> ArrayRef {
    Arc::new(StringArray::from(values.collect::<Vec<_>>()))
}

fn json_array<'a, T>(
    values: impl Iterator<Item = Option<&'a T>>,
) -> Result<ArrayRef>
where
    T: Serialize + 'a,
{
    Ok(string_array(
        values
            .map(|value| value.map(serde_json::to_string).transpose())
            .collect::<Result<Vec<_>, _>>()
            .c(h!())?
            .into_iter(),
    ))
}

fn json_array_required<'a, T>(
    values: impl Iterator<Item = &'a T>,
) -> Result<ArrayRef>
where
    T: Serialize + 'a,
{
    Ok(string_array(
        values
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .c(h!())?
            .into_iter()
            .map(Some),
    ))
}

fn string_column<'a>(
    batch: &'a RecordBatch,
    name: &str,
) -> Result<&'a StringArray> {
    batch
        .column_by_name(name)
        .and_then(|column| column.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow::anyhow!("missing Utf8 {name} column"))
}

fn required_string<'a>(
    array: &'a StringArray,
    row: usize,
    name: &str,
) -> Result<&'a str> {
    anyhow::ensure!(!array.is_null(row), "{name} is null at row {row}");
    Ok(array.value(row))
}

fn optional_string(array: &StringArray, row: usize) -> Option<String> {
    (!array.is_null(row)).then(|| array.value(row).to_string())
}

fn optional_uuid(array: &StringArray, row: usize) -> Result<Option<Uuid>> {
    optional_string(array, row)
        .map(|value| Uuid::parse_str(&value))
        .transpose()
        .map_err(Into::into)
}

fn optional_json<T>(array: &StringArray, row: usize) -> Result<Option<T>>
where
    T: for<'de> Deserialize<'de>,
{
    optional_string(array, row)
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(Into::into)
}

fn required_json<T>(array: &StringArray, row: usize, name: &str) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(required_string(array, row, name)?).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_round_trip_preserves_units_and_dictionary_ids() {
        let units = vec![sample_unit()];
        let dictionaries =
            merge_dictionary_entries(&units, DictionaryEntries::new()).unwrap();
        let bytes = create_archive(&units, &dictionaries).unwrap();
        let snapshot = read_archive(&bytes).unwrap();

        assert_eq!(snapshot.units, units);
        assert_eq!(snapshot.dictionaries, dictionaries);
        assert_eq!(snapshot.archive_md5, format!("{:x}", Md5::digest(&bytes)));
    }

    #[test]
    fn dictionary_ids_are_reused_and_old_values_are_retained() {
        let old_id = Uuid::new_v4();
        let previous = BTreeMap::from([(
            DictionaryKind::UnitEchelon,
            vec![
                DictionaryEntry {
                    id: old_id,
                    key: "battalion".to_string(),
                    name: "Battalion".to_string(),
                },
                DictionaryEntry {
                    id: Uuid::new_v4(),
                    key: "old".to_string(),
                    name: "Old".to_string(),
                },
            ],
        )]);
        let entries =
            merge_dictionary_entries(&[sample_unit()], previous).unwrap();

        assert_eq!(entries[&DictionaryKind::UnitEchelon].len(), 2);
        assert_eq!(
            entries[&DictionaryKind::UnitEchelon]
                .iter()
                .find(|entry| entry.key == "battalion")
                .unwrap()
                .id,
            old_id
        );
    }

    #[tokio::test]
    async fn latest_snapshot_uses_timestamp_order_and_handles_empty_storage() {
        let temp_dir = tempdir().unwrap();
        let builder = opendal::services::Fs::default()
            .root(&temp_dir.path().to_string_lossy());
        let store = SnapshotStore {
            operator: Operator::new(builder).unwrap().finish(),
            location: temp_dir.path().display().to_string(),
        };
        assert!(store.latest_bytes().await.unwrap().is_none());

        store
            .operator
            .write("orbit-import/20260731_090000_000000.zip", "older snapshot")
            .await
            .unwrap();
        store
            .operator
            .write("orbit-import/20260731_100000_000000.zip", "latest snapshot")
            .await
            .unwrap();
        store
            .operator
            .write("orbit-import/ignored.txt", "ignored")
            .await
            .unwrap();
        store
            .operator
            .write("orbit-import/latest.zip", "ignored")
            .await
            .unwrap();

        let (key, bytes) = store.latest_bytes().await.unwrap().unwrap();
        assert_eq!(key, "orbit-import/20260731_100000_000000.zip");
        assert_eq!(bytes, b"latest snapshot");
    }

    #[tokio::test]
    async fn json_read_errors_include_the_source_path() {
        let temp_dir = tempdir().unwrap();
        let path = temp_dir.path().join("missing-orbit-export.json");
        let error = read_json_source(&path).await.unwrap_err();

        assert!(format!("{error:#}").contains(&path.display().to_string()));
    }

    fn sample_unit() -> SourceUnit {
        SourceUnit {
            unit_id: Uuid::new_v4(),
            unit_name: Some("Unit".to_string()),
            unit_name_original: None,
            unit_name_short: Some("1 bn".to_string()),
            operational_unit_name_full: Some("1 bn / parent".to_string()),
            generative_unit_name_full: Some("1 bn / army".to_string()),
            unit_number: None,
            unit_alternate_names: Some(vec!["Alternative".to_string()]),
            unit_alternate_numbers: None,
            unit_echelon: Some(DictionaryValue {
                key: json!("battalion"),
                name: json!("Battalion"),
            }),
            combat_unit_type: None,
            grouping_of_forces: None,
            operational_parent_units: Vec::new(),
            generative_parent_units: Vec::new(),
            path_level: None,
        }
    }
}

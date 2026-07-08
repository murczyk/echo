use crate::config::{
    get_tz, ORGANISM_GOI_PATH_DEFAULT, ORGANISM_GOI_SSH_PORT_DEFAULT,
};
use crate::entities::{
    goi_integration, sigint_callsign, sigint_network, sigint_network_callsign,
    sigint_network_freq, sigint_unit, source,
};
use crate::error::AppError;
use crate::h;
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::types::{info, warn, Env, ShortContext};
use crate::utils::string::normalize_optional_trimmed;
use calamine::{Data, Reader, Xlsx};
use chrono::{NaiveDateTime, TimeZone, Utc};
use goi_echo_worker::xlsx::empty_xlsx_buffer;
use quick_xml::events::Event;
use quick_xml::name::QName;
use quick_xml::Reader as XmlReader;
use regex::Regex;
use sea_orm::{sea_query::Expr, *};
use sea_query::{Alias, JoinType};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const KNOWLEDGE_KIND_CALL_SIGN: &str = "CALL_SIGN";
const KNOWLEDGE_WORKER_AUTHOR: &str = "EXO";
const KNOWLEDGE_WORKER_ID_PREFIX: &str = "EXO ID ";
const KNOWLEDGE_COMMENT_COL_IDX: usize = 4;
const KNOWLEDGE_UNIT_COL_IDX: usize = 6;
const KNOWLEDGE_POSITION_COL_IDX: usize = 7;
const KNOWLEDGE_WORKER_ID_COL_IDX: usize = 8;
#[cfg(test)]
const TEST_GOI_SYNC_TIMESTAMP: &str = "17.03.2026 23:06:40";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GoiCallsignState {
    pub id: i64,
    pub callsign: String,
    pub frequency: String,
    pub unit: String,
    pub position: String,
    pub comment: String,
    pub row_ref: Option<GoiWorkbookRowRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GoiWorkbookRowRef {
    pub sheet_name: String,
    pub row_num: u32,
}

#[derive(Debug, FromQueryResult)]
struct LiveCallsignRow {
    id: i64,
    network_id: i64,
    sigint_callsign: String,
    position: Option<String>,
    comment: Option<String>,
    source_id: Option<i64>,
    radio_freq: Option<String>,
    sc_deleted: Option<bool>,
    sc_position: Option<String>,
    sc_comment: Option<String>,
    sc_source_id: Option<i32>,
    sc_radio_freq: Option<String>,
    unit_name: Option<String>,
    sc_unit_name: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct GoiCallsignDiff {
    pub new_ids: Vec<i64>,
    pub edited_ids: Vec<i64>,
    pub deleted_ids: Vec<i64>,
}

#[derive(Debug)]
struct GoiRemoteDataPaths {
    knowledge_xlsx: String,
}

#[derive(Debug, Clone)]
enum WorkbookCellValue {
    Empty,
    String(String),
    Float(f64),
    Int(i64),
    Bool(bool),
}

#[derive(Debug, Clone)]
struct WorkbookSheetData {
    name: String,
    rows: Vec<Vec<WorkbookCellValue>>,
}

#[derive(Debug, Clone)]
struct KnowledgeWorkbookData {
    sheets: Vec<WorkbookSheetData>,
}

#[derive(Debug, Clone)]
struct XlsxZipEntry {
    name: String,
    data: Vec<u8>,
    compression: CompressionMethod,
    unix_mode: Option<u32>,
}

#[derive(Debug, Clone)]
struct XlsxArchive {
    entries: Vec<XlsxZipEntry>,
}

pub(super) async fn sync_goi_callsigns_knowledge(
    env: &Env,
    integration: &goi_integration::Model,
) -> Result<(), AppError> {
    let ssh_req = goi_ssh_req_from_integration(integration)?;
    let remote_paths = goi_remote_data_paths(integration);
    let integration_label = goi_integration_log_label(integration);
    let sync_timestamp = goi_sync_timestamp_kyiv();
    info!(
        "[goi-sync] Starting GOI callsigns knowledge sync for {integration_label}; remote workbook={}",
        remote_paths.knowledge_xlsx
    );

    let current_callsigns = load_live_goi_callsigns(&env.dbx).await.c(h!())?;
    info!(
        "[goi-sync] Prepared {} live GOI callsigns for {integration_label}",
        current_callsigns.len()
    );
    for callsign in &current_callsigns {
        info!(
            "[goi-sync] Expected GOI knowledge row for {integration_label}: {}",
            format_goi_callsign_state_for_log(callsign)
        );
    }

    info!(
        "[goi-sync] Downloading GOI knowledge workbook for {integration_label} from {}",
        remote_paths.knowledge_xlsx
    );
    let knowledge_xlsx = download_or_create_knowledge_xlsx(
        ssh_req.clone(),
        &remote_paths.knowledge_xlsx,
        &integration_label,
    )
    .await
    .c(h!())?;
    info!(
        "[goi-sync] Downloaded GOI knowledge workbook for {integration_label}: {} bytes from {}",
        knowledge_xlsx.len(),
        remote_paths.knowledge_xlsx
    );
    let workbook =
        KnowledgeWorkbookData::from_xlsx_bytes(&knowledge_xlsx).c(h!())?;
    info!(
        "[goi-sync] Parsed GOI knowledge workbook for {integration_label}: {} sheets",
        workbook.sheets.len()
    );
    let previous_callsigns = workbook.extract_goi_callsigns_state();
    info!(
        "[goi-sync] Found {} existing worker-managed GOI callsigns in workbook for {integration_label}",
        previous_callsigns.len()
    );
    for callsign in &previous_callsigns {
        info!(
            "[goi-sync] Existing workbook GOI callsign for {integration_label}: {}",
            format_goi_callsign_state_for_log(callsign)
        );
    }
    let diff = diff_goi_callsigns(&previous_callsigns, &current_callsigns);

    info!(
        "[goi-sync] GOI callsigns diff for {integration_label} {}\nnew callsigns - {}\nedited callsigns - {}\ndeleted callsigns - {}",
        remote_paths.knowledge_xlsx,
        format_goi_callsign_id_summary(&diff.new_ids),
        format_goi_callsign_id_summary(&diff.edited_ids),
        format_goi_callsign_id_summary(&diff.deleted_ids),
    );

    info!(
        "[goi-sync] Rebuilding GOI knowledge workbook for {integration_label}"
    );
    let knowledge_xlsx = apply_goi_callsigns_to_xlsx(
        &knowledge_xlsx,
        &workbook,
        &previous_callsigns,
        &current_callsigns,
        &sync_timestamp,
    )
    .c(h!())?;
    info!(
        "[goi-sync] Rebuilt GOI knowledge workbook for {integration_label}: {} bytes",
        knowledge_xlsx.len()
    );
    validate_knowledge_xlsx_bytes(&knowledge_xlsx).c(h!())?;
    info!(
        "[goi-sync] Uploading GOI knowledge workbook for {integration_label} to {}",
        remote_paths.knowledge_xlsx
    );
    super::goi_upload_file(
        ssh_req,
        remote_paths.knowledge_xlsx,
        knowledge_xlsx,
    )
    .await
    .c(h!())?;
    info!(
        "[goi-sync] Finished GOI callsigns knowledge sync for {integration_label}"
    );
    Ok(())
}

async fn download_or_create_knowledge_xlsx(
    ssh_req: CheckOrganismGoiConnectionReq,
    knowledge_xlsx_path: &str,
    integration_label: &str,
) -> Result<Vec<u8>, AppError> {
    if !super::goi_file_exists(ssh_req.clone(), knowledge_xlsx_path.to_string())
        .await
        .c(h!())?
    {
        return create_knowledge_xlsx(
            ssh_req,
            knowledge_xlsx_path,
            integration_label,
        )
        .await;
    }

    match super::goi_download_file(
        ssh_req.clone(),
        knowledge_xlsx_path.to_string(),
    )
    .await
    {
        Ok(file_data) => Ok(file_data),
        Err(err) if goi_download_error_is_missing_file(&err) => {
            create_knowledge_xlsx(
                ssh_req,
                knowledge_xlsx_path,
                integration_label,
            )
            .await
        }
        Err(err) => Err(AppError::from(err)),
    }
}

async fn create_knowledge_xlsx(
    ssh_req: CheckOrganismGoiConnectionReq,
    knowledge_xlsx_path: &str,
    integration_label: &str,
) -> Result<Vec<u8>, AppError> {
    info!(
        "[goi-sync] GOI knowledge workbook is missing for {integration_label}; creating {}",
        knowledge_xlsx_path
    );
    let file_data = empty_xlsx_buffer().c(h!())?;
    super::goi_upload_file(
        ssh_req,
        knowledge_xlsx_path.to_string(),
        file_data.clone(),
    )
    .await
    .c(h!())?;
    Ok(file_data)
}

fn goi_download_error_is_missing_file(err: &anyhow::Error) -> bool {
    let message = format!("{err:#}").to_lowercase();
    message.contains("no such file")
        || message.contains("not found")
        || message.contains("does not exist")
}

fn goi_ssh_req_from_integration(
    integration: &goi_integration::Model,
) -> Result<CheckOrganismGoiConnectionReq, AppError> {
    let ssh_host = normalize_optional_trimmed(integration.ssh_host.clone())
        .ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI SSH host is missing for integration {}",
                integration.id
            ),
        })?;
    let ssh_user = normalize_optional_trimmed(integration.ssh_user.clone())
        .ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI SSH user is missing for integration {}",
                integration.id
            ),
        })?;
    Ok(CheckOrganismGoiConnectionReq {
        ssh_host,
        ssh_user,
        ssh_port: if integration.ssh_port > 0 {
            integration.ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        },
        path: integration.path.clone(),
    })
}

fn goi_remote_data_paths(
    integration: &goi_integration::Model,
) -> GoiRemoteDataPaths {
    let data_dir = goi_remote_data_dir(&integration.path);
    GoiRemoteDataPaths {
        knowledge_xlsx: format!("{data_dir}/xlsx/knowledge.xlsx"),
    }
}

fn goi_remote_data_dir(path: &str) -> String {
    let path = normalize_optional_trimmed(Some(path.to_string()))
        .unwrap_or_else(|| ORGANISM_GOI_PATH_DEFAULT.to_string());
    let path = path.trim_end_matches('/');
    if path.ends_with("/palettes") {
        Path::new(path)
            .parent()
            .and_then(|parent| parent.to_str())
            .map(|parent| parent.to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    }
}

async fn load_live_goi_callsigns(
    db: &DatabaseConnection,
) -> Result<Vec<GoiCallsignState>, AppError> {
    let source_names = load_source_names(db).await.c(h!())?;
    let network_freqs = load_live_network_freqs(db).await.c(h!())?;
    let callsigns = load_live_callsign_rows(db).await.c(h!())?;
    info!(
        "[goi-sync] Loaded GOI callsign sync source data: {} source names, {} active network frequency groups, {} candidate callsign rows",
        source_names.len(),
        network_freqs.len(),
        callsigns.len()
    );

    let mut out = Vec::new();
    for callsign in callsigns {
        info!(
            "[goi-sync] Evaluating candidate GOI callsign row: {}",
            format_live_callsign_row_for_log(&callsign)
        );
        let Some(frequency) =
            effective_live_callsign_frequency(&callsign, &network_freqs)
        else {
            info!(
                "[goi-sync] Skipping candidate GOI callsign row id={} network_id={} because neither the callsign nor the network has a frequency eligible for GOI sync",
                callsign.id,
                callsign.network_id
            );
            continue;
        };
        let callsign_name = callsign.sigint_callsign.trim().to_string();
        if callsign_name.is_empty() {
            info!(
                "[goi-sync] Skipping candidate GOI callsign row id={} network_id={} because callsign is empty after trim",
                callsign.id,
                callsign.network_id
            );
            continue;
        }
        if callsign.sc_deleted == Some(true) {
            info!(
                "[goi-sync] Candidate GOI callsign row id={} network_id={} references a deleted sigint_callsign; exporting with network-local fields only",
                callsign.id,
                callsign.network_id
            );
        }
        let unit = merged_live_unit_name(&callsign);
        let position = merged_live_position(&callsign);
        let source_name = merged_live_source_name(&callsign, &source_names);
        let comment = merged_live_comment_text(&callsign);
        let goi_callsign = GoiCallsignState {
            id: callsign.id,
            callsign: callsign_name,
            frequency,
            unit,
            position,
            comment: render_live_comment(
                comment.as_deref(),
                source_name.as_deref(),
            ),
            row_ref: None,
        };
        info!(
            "[goi-sync] Selected GOI callsign row: {}",
            format_goi_callsign_state_for_log(&goi_callsign)
        );
        out.push(goi_callsign);
    }
    out.sort_by_key(|left| left.id);
    info!(
        "[goi-sync] Finished preparing GOI callsigns: {} rows selected",
        out.len()
    );
    Ok(out)
}

async fn load_source_names(
    db: &DatabaseConnection,
) -> Result<BTreeMap<i64, String>, AppError> {
    Ok(source::Entity::find()
        .filter(source::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|source| (source.id, source.name))
        .collect())
}

async fn load_live_network_freqs(
    db: &DatabaseConnection,
) -> Result<BTreeMap<i64, String>, AppError> {
    #[derive(Debug, FromQueryResult)]
    struct NetworkFreqRow {
        network_id: i64,
        freq: String,
    }

    let today_start = goi_live_cutoff_datetime();
    let rows = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .select_only()
        .column_as(sigint_network::Column::Id, "network_id")
        .column(sigint_network_freq::Column::Freq)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(goi_live_network_condition(today_start))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(goi_live_network_freq_condition(today_start))
        .order_by_asc(sigint_network::Column::Id)
        .order_by_asc(sigint_network_freq::Column::Id)
        .into_model::<NetworkFreqRow>()
        .all(db)
        .await
        .c(h!())?;

    let mut grouped = BTreeMap::<i64, BTreeSet<String>>::new();
    for row in rows {
        let freq = row.freq.trim();
        if !freq.is_empty() {
            grouped
                .entry(row.network_id)
                .or_default()
                .insert(freq.to_string());
        }
    }
    Ok(grouped
        .into_iter()
        .map(|(network_id, freqs)| {
            (network_id, freqs.into_iter().collect::<Vec<_>>().join(", "))
        })
        .collect())
}

async fn load_live_callsign_rows(
    db: &DatabaseConnection,
) -> Result<Vec<LiveCallsignRow>, AppError> {
    let today_start = goi_live_cutoff_datetime();
    Ok(sigint_network_callsign::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_callsign::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintCallsign.def(),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_callsign::Relation::SigintUnit.def(),
            Alias::new("sc_unit"),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintUnit.def(),
            Alias::new("nc_unit"),
        )
        .select_only()
        .column_as(sigint_network_callsign::Column::Id, "id")
        .column_as(
            sigint_network_callsign::Column::SigintNetworkId,
            "network_id",
        )
        .column(sigint_network_callsign::Column::SigintCallsign)
        .column(sigint_network_callsign::Column::Position)
        .column(sigint_network_callsign::Column::Comment)
        .column(sigint_network_callsign::Column::SourceId)
        .column(sigint_network_callsign::Column::RadioFreq)
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Deleted,
            )),
            "sc_deleted",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Position,
            )),
            "sc_position",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Comment,
            )),
            "sc_comment",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::SourceId,
            )),
            "sc_source_id",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::RadioFreq,
            )),
            "sc_radio_freq",
        )
        .column_as(
            Expr::col((Alias::new("nc_unit"), sigint_unit::Column::Name)),
            "unit_name",
        )
        .column_as(
            Expr::col((Alias::new("sc_unit"), sigint_unit::Column::Name)),
            "sc_unit_name",
        )
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(goi_live_network_condition(today_start))
        .order_by_asc(sigint_network_callsign::Column::Id)
        .into_model::<LiveCallsignRow>()
        .all(db)
        .await
        .c(h!())?)
}

fn goi_live_cutoff_datetime() -> NaiveDateTime {
    let today = Utc::now().with_timezone(&get_tz()).date_naive();
    let today_start_local = today.and_hms_opt(0, 0, 0).unwrap_or_default();
    get_tz()
        .from_local_datetime(&today_start_local)
        .single()
        .unwrap_or_else(|| Utc::now().with_timezone(&get_tz()))
        .with_timezone(&Utc)
        .naive_utc()
}

fn goi_live_network_condition(today_start: NaiveDateTime) -> Condition {
    Condition::any()
        .add(sigint_network::Column::ActiveTo.is_null())
        .add(
            Expr::col((
                sigint_network::Entity,
                sigint_network::Column::ActiveTo,
            ))
            .gte(Expr::val(today_start)),
        )
}

fn goi_live_network_freq_condition(today_start: NaiveDateTime) -> Condition {
    Condition::any()
        .add(sigint_network_freq::Column::ActiveTo.is_null())
        .add(
            Expr::col((
                sigint_network_freq::Entity,
                sigint_network_freq::Column::ActiveTo,
            ))
            .gte(Expr::val(today_start)),
        )
}

fn merged_live_unit_name(callsign: &LiveCallsignRow) -> String {
    normalize_optional_trimmed(callsign.unit_name.clone())
        .or_else(|| {
            linked_sigint_callsign_is_active(callsign)
                .then_some(normalize_optional_trimmed(
                    callsign.sc_unit_name.clone(),
                ))
                .flatten()
        })
        .unwrap_or_default()
}

fn merged_live_position(callsign: &LiveCallsignRow) -> String {
    normalize_optional_trimmed(callsign.position.clone())
        .or_else(|| {
            linked_sigint_callsign_is_active(callsign)
                .then_some(normalize_optional_trimmed(
                    callsign.sc_position.clone(),
                ))
                .flatten()
        })
        .unwrap_or_default()
}

fn merged_live_source_name(
    callsign: &LiveCallsignRow,
    source_names: &BTreeMap<i64, String>,
) -> Option<String> {
    let source_id = callsign.source_id.or_else(|| {
        linked_sigint_callsign_is_active(callsign)
            .then_some(callsign.sc_source_id.map(i64::from))
            .flatten()
    })?;
    source_names.get(&source_id).cloned()
}

fn merged_live_comment_text(callsign: &LiveCallsignRow) -> Option<String> {
    callsign.comment.clone().or_else(|| {
        linked_sigint_callsign_is_active(callsign)
            .then_some(callsign.sc_comment.clone())
            .flatten()
    })
}

fn effective_live_callsign_frequency(
    callsign: &LiveCallsignRow,
    network_freqs: &BTreeMap<i64, String>,
) -> Option<String> {
    normalize_optional_trimmed(callsign.radio_freq.clone())
        .or_else(|| {
            linked_sigint_callsign_is_active(callsign)
                .then_some(normalize_optional_trimmed(
                    callsign.sc_radio_freq.clone(),
                ))
                .flatten()
        })
        .or_else(|| {
            network_freqs
                .get(&callsign.network_id)
                .cloned()
                .and_then(|freq| normalize_optional_trimmed(Some(freq)))
        })
}

fn goi_sync_timestamp_kyiv() -> String {
    Utc::now()
        .with_timezone(&get_tz())
        .format("%d.%m.%Y %H:%M:%S")
        .to_string()
}

fn linked_sigint_callsign_is_active(callsign: &LiveCallsignRow) -> bool {
    matches!(callsign.sc_deleted, Some(false))
}

fn render_live_comment(
    comment: Option<&str>,
    source_name: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if let Some(comment) =
        comment.map(str::trim).filter(|comment| !comment.is_empty())
    {
        parts.push(comment.to_string());
    }
    if let Some(source_name) = source_name
        .map(str::trim)
        .filter(|source_name| !source_name.is_empty())
    {
        parts.push(format!("джерело: {source_name}"));
    }
    parts.join("; ")
}

pub(super) fn diff_goi_callsigns(
    previous: &[GoiCallsignState],
    current: &[GoiCallsignState],
) -> GoiCallsignDiff {
    let previous = previous
        .iter()
        .map(|callsign| (callsign.id, callsign))
        .collect::<BTreeMap<_, _>>();
    let current = current
        .iter()
        .map(|callsign| (callsign.id, callsign))
        .collect::<BTreeMap<_, _>>();
    let mut diff = GoiCallsignDiff::default();
    let ids = previous
        .keys()
        .chain(current.keys())
        .copied()
        .collect::<BTreeSet<_>>();

    for id in ids {
        match (previous.get(&id), current.get(&id)) {
            (None, Some(_)) => diff.new_ids.push(id),
            (Some(_), None) => diff.deleted_ids.push(id),
            (Some(previous), Some(current))
                if goi_callsign_changed(previous, current) =>
            {
                diff.edited_ids.push(id);
            }
            _ => {}
        }
    }
    diff
}

fn goi_callsign_changed(
    previous: &GoiCallsignState,
    current: &GoiCallsignState,
) -> bool {
    previous.callsign != current.callsign
        || previous.frequency != current.frequency
        || previous.unit != current.unit
        || previous.position != current.position
        || previous.comment != current.comment
}

fn format_goi_callsign_id_summary(ids: &[i64]) -> String {
    let Some(min_id) = ids.iter().min() else {
        return "len=0, min=-, max=-".to_string();
    };
    let max_id = ids.iter().max().expect("min id exists");
    format!("len={}, min={min_id}, max={max_id}", ids.len())
}

fn goi_integration_log_label(integration: &goi_integration::Model) -> String {
    let label = integration.server_label.trim();
    if label.is_empty() {
        format!("integration_id={}", integration.id)
    } else {
        format!("{label} (integration_id={})", integration.id)
    }
}

fn format_goi_callsign_state_for_log(callsign: &GoiCallsignState) -> String {
    let row_ref = callsign
        .row_ref
        .as_ref()
        .map(|row_ref| format!("{}#{}", row_ref.sheet_name, row_ref.row_num))
        .unwrap_or_else(|| "-".to_string());
    format!(
        "id={} callsign={:?} frequency={:?} unit={:?} position={:?} comment={:?} row_ref={}",
        callsign.id,
        callsign.callsign,
        callsign.frequency,
        callsign.unit,
        callsign.position,
        callsign.comment,
        row_ref
    )
}

fn format_live_callsign_row_for_log(callsign: &LiveCallsignRow) -> String {
    format!(
        "id={} network_id={} sigint_callsign={:?} unit_name={:?} position={:?} comment={:?} source_id={:?} radio_freq={:?} sc_deleted={:?} sc_unit_name={:?} sc_position={:?} sc_comment={:?} sc_source_id={:?} sc_radio_freq={:?}",
        callsign.id,
        callsign.network_id,
        callsign.sigint_callsign,
        callsign.unit_name,
        callsign.position,
        callsign.comment,
        callsign.source_id,
        callsign.radio_freq,
        callsign.sc_deleted,
        callsign.sc_unit_name,
        callsign.sc_position,
        callsign.sc_comment,
        callsign.sc_source_id,
        callsign.sc_radio_freq
    )
}

impl KnowledgeWorkbookData {
    fn from_xlsx_bytes(file_data: &[u8]) -> Result<Self, AppError> {
        let mut workbook: Xlsx<_> =
            Xlsx::new(Cursor::new(file_data.to_vec())).c(h!())?;
        let mut sheets = Vec::new();
        for sheet_name in workbook.sheet_names().to_vec() {
            let range = workbook.worksheet_range(&sheet_name).c(h!())?;
            let rows = range
                .rows()
                .map(|row| row.iter().map(WorkbookCellValue::from).collect())
                .collect::<Vec<Vec<WorkbookCellValue>>>();
            sheets.push(WorkbookSheetData {
                name: sheet_name,
                rows,
            });
        }
        Ok(Self { sheets })
    }

    fn extract_goi_callsigns_state(&self) -> Vec<GoiCallsignState> {
        let mut callsigns = Vec::new();
        for sheet in &self.sheets {
            for (row_idx, row) in sheet.rows.iter().enumerate() {
                if !is_worker_callsign_row(row) {
                    continue;
                }
                let Some(id) =
                    parse_goi_callsign_id(row.get(KNOWLEDGE_WORKER_ID_COL_IDX))
                        .or_else(|| {
                            parse_legacy_h_goi_callsign_id(
                                row.get(KNOWLEDGE_POSITION_COL_IDX),
                            )
                        })
                        .or_else(|| {
                            parse_goi_callsign_id(
                                row.get(KNOWLEDGE_COMMENT_COL_IDX),
                            )
                        })
                else {
                    continue;
                };
                callsigns.push(GoiCallsignState {
                    id,
                    callsign: workbook_cell_text(row.first()),
                    frequency: workbook_cell_text(row.get(1)),
                    unit: workbook_cell_text(row.get(KNOWLEDGE_UNIT_COL_IDX)),
                    position: extract_goi_callsign_position(row),
                    comment: extract_goi_callsign_comment(row),
                    row_ref: Some(GoiWorkbookRowRef {
                        sheet_name: sheet.name.clone(),
                        row_num: (row_idx + 1) as u32,
                    }),
                });
            }
        }
        callsigns.sort_by_key(|left| left.id);
        callsigns
    }

    fn worker_row_nums_by_sheet(&self) -> BTreeMap<String, BTreeSet<u32>> {
        let mut rows_by_sheet = BTreeMap::new();
        for sheet in &self.sheets {
            for (row_idx, row) in sheet.rows.iter().enumerate() {
                if !is_worker_callsign_row(row) {
                    continue;
                }
                rows_by_sheet
                    .entry(sheet.name.clone())
                    .or_insert_with(BTreeSet::new)
                    .insert((row_idx + 1) as u32);
            }
        }
        rows_by_sheet
    }

    fn default_target_sheet_name(
        &self,
        previous_callsigns: &[GoiCallsignState],
    ) -> Result<String, AppError> {
        if let Some(row_ref) = previous_callsigns
            .iter()
            .filter_map(|callsign| callsign.row_ref.clone())
            .find(|row_ref| self.sheet_row_index(row_ref).is_some())
        {
            return Ok(row_ref.sheet_name);
        }
        if let Some(sheet) = self.sheets.iter().find(|sheet| {
            sheet.rows.iter().any(|row| is_worker_callsign_row(row))
        }) {
            return Ok(sheet.name.clone());
        }
        if let Some(sheet) = self
            .sheets
            .iter()
            .find(|sheet| sheet.rows.iter().any(|row| is_callsign_row(row)))
        {
            return Ok(sheet.name.clone());
        }
        self.sheets
            .first()
            .map(|sheet| sheet.name.clone())
            .ok_or_else(|| AppError::BL {
                msg: "GOI knowledge workbook has no sheets".to_string(),
            })
    }

    fn sheet_row_index(&self, row_ref: &GoiWorkbookRowRef) -> Option<usize> {
        let sheet = self
            .sheets
            .iter()
            .find(|sheet| sheet.name == row_ref.sheet_name)?;
        let row_idx = row_ref.row_num.checked_sub(1)? as usize;
        (row_idx < sheet.rows.len()).then_some(row_idx)
    }

    #[cfg(test)]
    fn apply_goi_callsigns(
        &mut self,
        previous_callsigns: &[GoiCallsignState],
        current_callsigns: &[GoiCallsignState],
    ) -> Result<(), AppError> {
        let target_sheet_name =
            self.default_target_sheet_name(previous_callsigns).c(h!())?;
        let worker_row_nums_by_sheet = self.worker_row_nums_by_sheet();
        let mut affected_sheet_names = worker_row_nums_by_sheet
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        affected_sheet_names.insert(target_sheet_name.clone());
        let current_callsigns = unique_sorted_goi_callsigns(current_callsigns);

        for sheet_name in affected_sheet_names {
            let current_sheet_callsigns = if sheet_name == target_sheet_name {
                current_callsigns.as_slice()
            } else {
                &[]
            };
            let sheet = self
                .sheets
                .iter_mut()
                .find(|sheet| sheet.name == sheet_name)
                .ok_or_else(|| AppError::BL {
                    msg: format!(
                        "GOI knowledge workbook has no sheet {sheet_name}"
                    ),
                })?;
            sheet.rows = rewrite_sheet_rows_for_tests(
                &sheet.rows,
                worker_row_nums_by_sheet
                    .get(&sheet_name)
                    .cloned()
                    .unwrap_or_default(),
                current_sheet_callsigns,
                TEST_GOI_SYNC_TIMESTAMP,
            );
        }
        Ok(())
    }
}

#[cfg(test)]
fn rewrite_sheet_rows_for_tests(
    rows: &[Vec<WorkbookCellValue>],
    worker_row_nums: BTreeSet<u32>,
    current_callsigns: &[GoiCallsignState],
    sync_timestamp: &str,
) -> Vec<Vec<WorkbookCellValue>> {
    let mut out_rows = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let row_num = idx as u32 + 1;
        if worker_row_nums.contains(&row_num) {
            continue;
        }
        out_rows.push(row.clone());
    }
    out_rows.extend(current_callsigns.iter().map(|callsign| {
        build_worker_row_cells_for_tests(callsign, sync_timestamp)
    }));
    out_rows
}

#[cfg(test)]
fn build_worker_row_cells_for_tests(
    callsign: &GoiCallsignState,
    sync_timestamp: &str,
) -> Vec<WorkbookCellValue> {
    vec![
        WorkbookCellValue::String(callsign.callsign.clone()),
        WorkbookCellValue::String(callsign.frequency.clone()),
        WorkbookCellValue::String(KNOWLEDGE_KIND_CALL_SIGN.to_string()),
        WorkbookCellValue::String(KNOWLEDGE_WORKER_AUTHOR.to_string()),
        WorkbookCellValue::String(callsign.comment.clone()),
        WorkbookCellValue::String(sync_timestamp.to_string()),
        WorkbookCellValue::String(callsign.unit.clone()),
        WorkbookCellValue::String(callsign.position.clone()),
        WorkbookCellValue::String(format!(
            "{KNOWLEDGE_WORKER_ID_PREFIX}{}",
            callsign.id
        )),
    ]
}

fn apply_goi_callsigns_to_xlsx(
    file_data: &[u8],
    workbook: &KnowledgeWorkbookData,
    previous_callsigns: &[GoiCallsignState],
    current_callsigns: &[GoiCallsignState],
    sync_timestamp: &str,
) -> Result<Vec<u8>, AppError> {
    let target_sheet_name = workbook
        .default_target_sheet_name(previous_callsigns)
        .c(h!())?;
    let worker_row_nums_by_sheet = workbook.worker_row_nums_by_sheet();
    let current_callsigns = unique_sorted_goi_callsigns(current_callsigns);
    let mut archive = XlsxArchive::from_bytes(file_data).c(h!())?;
    let sheet_paths = archive.sheet_paths_by_name().c(h!())?;

    let mut affected_sheet_names = worker_row_nums_by_sheet
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    affected_sheet_names.insert(target_sheet_name.clone());
    let affected_sheet_names =
        affected_sheet_names.into_iter().collect::<Vec<_>>();
    info!(
        "[goi-sync] Rewriting GOI workbook sheets: target_sheet={:?}, affected_sheets={:?}, previous_callsigns={}, current_callsigns={}",
        target_sheet_name,
        affected_sheet_names,
        previous_callsigns.len(),
        current_callsigns.len()
    );

    for sheet_name in affected_sheet_names {
        let sheet_path =
            sheet_paths.get(&sheet_name).ok_or_else(|| AppError::BL {
                msg: format!(
                    "GOI knowledge sheet path is missing for {sheet_name}"
                ),
            })?;
        let sheet_xml = archive.file(sheet_path).c(h!())?;
        let worker_row_nums = worker_row_nums_by_sheet
            .get(&sheet_name)
            .cloned()
            .unwrap_or_default();
        let current_sheet_callsigns = if sheet_name == target_sheet_name {
            current_callsigns.as_slice()
        } else {
            &[]
        };
        info!(
            "[goi-sync] Rewriting GOI knowledge sheet {sheet_name}: previous_worker_rows={}, next_worker_rows={}, sheet_path={sheet_path}",
            worker_row_nums.len(),
            current_sheet_callsigns.len()
        );
        let next_sheet_xml = rewrite_sheet_xml(
            &sheet_xml,
            &worker_row_nums,
            current_sheet_callsigns,
            sync_timestamp,
        )
        .c(h!())?;
        archive
            .replace_file(sheet_path, next_sheet_xml.into_bytes())
            .c(h!())?;
    }

    Ok(archive.to_bytes().c(h!())?)
}

impl XlsxArchive {
    fn from_bytes(file_data: &[u8]) -> Result<Self, AppError> {
        let mut archive =
            ZipArchive::new(Cursor::new(file_data.to_vec())).c(h!())?;
        let mut entries = Vec::new();
        for idx in 0..archive.len() {
            let mut file = archive.by_index(idx).c(h!())?;
            let mut data = Vec::new();
            file.read_to_end(&mut data).c(h!())?;
            entries.push(XlsxZipEntry {
                name: file.name().to_string(),
                data,
                compression: file.compression(),
                unix_mode: file.unix_mode(),
            });
        }
        Ok(Self { entries })
    }

    fn file(&self, name: &str) -> Result<String, AppError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .ok_or_else(|| AppError::BL {
                msg: format!("GOI workbook entry is missing: {name}"),
            })?;
        Ok(String::from_utf8(entry.data.clone()).c(h!())?)
    }

    fn replace_file(
        &mut self,
        name: &str,
        data: Vec<u8>,
    ) -> Result<(), AppError> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.name == name)
            .ok_or_else(|| AppError::BL {
                msg: format!("GOI workbook entry is missing: {name}"),
            })?;
        entry.data = data;
        Ok(())
    }

    fn to_bytes(&self) -> Result<Vec<u8>, AppError> {
        let cursor = Cursor::new(Vec::<u8>::new());
        let mut writer = ZipWriter::new(cursor);
        for entry in &self.entries {
            let mut options: FileOptions<zip::write::ExtendedFileOptions> =
                FileOptions::default().compression_method(entry.compression);
            if let Some(unix_mode) = entry.unix_mode {
                options = options.unix_permissions(unix_mode);
            }
            writer.start_file(&entry.name, options).c(h!())?;
            writer.write_all(&entry.data).c(h!())?;
        }
        Ok(writer.finish().c(h!())?.into_inner())
    }

    fn sheet_paths_by_name(
        &self,
    ) -> Result<BTreeMap<String, String>, AppError> {
        let workbook_xml = self.file("xl/workbook.xml").c(h!())?;
        let rels_xml = self.file("xl/_rels/workbook.xml.rels").c(h!())?;
        let rel_targets = parse_workbook_rel_targets(&rels_xml).c(h!())?;
        let mut reader = XmlReader::from_str(&workbook_xml);
        reader.config_mut().trim_text(true);
        let mut out = BTreeMap::new();
        loop {
            match reader.read_event().c(h!())? {
                Event::Empty(event) | Event::Start(event)
                    if event.name() == QName(b"sheet") =>
                {
                    let mut sheet_name = None;
                    let mut rel_id = None;
                    for attr in event.attributes() {
                        let attr = attr.c(h!())?;
                        if attr.key == QName(b"name") {
                            sheet_name = Some(
                                attr.decode_and_unescape_value(
                                    reader.decoder(),
                                )
                                .c(h!())?
                                .into_owned(),
                            );
                        } else if attr.key == QName(b"r:id") {
                            rel_id = Some(
                                attr.decode_and_unescape_value(
                                    reader.decoder(),
                                )
                                .c(h!())?
                                .into_owned(),
                            );
                        }
                    }
                    let Some(sheet_name) = sheet_name else {
                        continue;
                    };
                    let Some(rel_id) = rel_id else {
                        continue;
                    };
                    let Some(target) = rel_targets.get(&rel_id) else {
                        continue;
                    };
                    out.insert(sheet_name, normalize_workbook_target(target));
                }
                Event::Eof => break,
                _ => {}
            }
        }
        Ok(out)
    }
}

fn validate_knowledge_xlsx_bytes(file_data: &[u8]) -> Result<(), AppError> {
    validate_zip_archive_bytes(file_data).c(h!())?;
    KnowledgeWorkbookData::from_xlsx_bytes(file_data).c(h!())?;
    Ok(())
}

fn validate_zip_archive_bytes(file_data: &[u8]) -> Result<(), AppError> {
    let mut archive =
        ZipArchive::new(Cursor::new(file_data.to_vec())).c(h!())?;
    for idx in 0..archive.len() {
        let mut file = archive.by_index(idx).c(h!())?;
        validate_zip_entry_local_header(file_data, &file).c(h!())?;
        std::io::copy(&mut file, &mut std::io::sink()).c(h!())?;
    }
    Ok(())
}

fn validate_zip_entry_local_header<R: Read>(
    file_data: &[u8],
    file: &zip::read::ZipFile<'_, R>,
) -> Result<(), AppError> {
    let header_start = file.header_start() as usize;
    let signature =
        zip_u32_at(file_data, header_start).ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI workbook ZIP entry {} has truncated local header",
                file.name()
            ),
        })?;
    if signature != 0x0403_4b50 {
        return Err(AppError::BL {
            msg: format!(
                "GOI workbook ZIP entry {} has invalid local header signature",
                file.name()
            ),
        });
    }

    let flags = zip_u16_at(file_data, header_start + 6).ok_or_else(|| {
        AppError::BL {
            msg: format!(
                "GOI workbook ZIP entry {} has truncated local header flags",
                file.name()
            ),
        }
    })?;
    if flags & 0x08 != 0 {
        return Ok(());
    }

    let local_crc32 =
        zip_u32_at(file_data, header_start + 14).ok_or_else(|| {
            AppError::BL {
                msg: format!(
                    "GOI workbook ZIP entry {} has truncated local header CRC",
                    file.name()
                ),
            }
        })?;
    let local_compressed_size = zip_u32_at(file_data, header_start + 18)
        .ok_or_else(|| AppError::BL {
            msg: format!(
                "GOI workbook ZIP entry {} has truncated local compressed size",
                file.name()
            ),
        })?;
    let local_uncompressed_size =
        zip_u32_at(file_data, header_start + 22).ok_or_else(|| {
            AppError::BL {
                msg: format!(
                    "GOI workbook ZIP entry {} has truncated local uncompressed size",
                    file.name()
                ),
            }
        })?;

    validate_zip_entry_local_u32(
        file.name(),
        "CRC32",
        u64::from(local_crc32),
        u64::from(file.crc32()),
    )?;
    validate_zip_entry_local_u32(
        file.name(),
        "compressed size",
        u64::from(local_compressed_size),
        file.compressed_size(),
    )?;
    validate_zip_entry_local_u32(
        file.name(),
        "uncompressed size",
        u64::from(local_uncompressed_size),
        file.size(),
    )?;
    Ok(())
}

fn validate_zip_entry_local_u32(
    name: &str,
    field: &str,
    local_value: u64,
    central_value: u64,
) -> Result<(), AppError> {
    if local_value == u64::from(u32::MAX)
        || central_value == u64::from(u32::MAX)
    {
        return Ok(());
    }
    if local_value != central_value {
        return Err(AppError::BL {
            msg: format!(
                "GOI workbook ZIP entry {name} has mismatched local header {field}: local={local_value}, central={central_value}"
            ),
        });
    }
    Ok(())
}

fn zip_u16_at(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn zip_u32_at(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn parse_workbook_rel_targets(
    rels_xml: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    let mut reader = XmlReader::from_str(rels_xml);
    reader.config_mut().trim_text(true);
    let mut out = BTreeMap::new();
    loop {
        match reader.read_event().c(h!())? {
            Event::Empty(event) | Event::Start(event)
                if event.name() == QName(b"Relationship") =>
            {
                let mut rel_id = None;
                let mut target = None;
                for attr in event.attributes() {
                    let attr = attr.c(h!())?;
                    if attr.key == QName(b"Id") {
                        rel_id = Some(
                            attr.decode_and_unescape_value(reader.decoder())
                                .c(h!())?
                                .into_owned(),
                        );
                    } else if attr.key == QName(b"Target") {
                        target = Some(
                            attr.decode_and_unescape_value(reader.decoder())
                                .c(h!())?
                                .into_owned(),
                        );
                    }
                }
                if let (Some(rel_id), Some(target)) = (rel_id, target) {
                    out.insert(rel_id, target);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

fn normalize_workbook_target(target: &str) -> String {
    if let Some(target) = target.strip_prefix("/xl/") {
        return format!("xl/{target}");
    }
    if target.starts_with("xl/") {
        return target.to_string();
    }
    format!("xl/{target}")
}

#[derive(Debug, Clone)]
struct SheetXmlRow {
    xml: String,
    is_worker: bool,
}

fn unique_sorted_goi_callsigns(
    current_callsigns: &[GoiCallsignState],
) -> Vec<GoiCallsignState> {
    let mut current_callsigns = current_callsigns.to_vec();
    current_callsigns.sort_by_key(|callsign| callsign.id);
    let duplicate_ids = current_callsigns
        .windows(2)
        .filter_map(|pair| (pair[0].id == pair[1].id).then_some(pair[0].id))
        .collect::<BTreeSet<_>>();
    if !duplicate_ids.is_empty() {
        warn!(
            "[goi-sync] Deduplicating GOI knowledge callsign rows by EXO ID before workbook write: duplicate_ids={duplicate_ids:?}"
        );
        current_callsigns.dedup_by_key(|callsign| callsign.id);
    }
    current_callsigns
}

fn rewrite_sheet_xml(
    sheet_xml: &str,
    worker_row_nums: &BTreeSet<u32>,
    current_callsigns: &[GoiCallsignState],
    sync_timestamp: &str,
) -> Result<String, AppError> {
    let (prefix, rows, suffix) = split_sheet_xml(sheet_xml).c(h!())?;
    let current_callsigns = unique_sorted_goi_callsigns(current_callsigns);
    let rows = rows
        .into_iter()
        .map(|(row_num, xml)| SheetXmlRow {
            is_worker: worker_row_nums.contains(&row_num),
            xml,
        })
        .collect::<Vec<_>>();
    let worker_row_num_min = worker_row_nums.first().copied();
    let worker_row_num_max = worker_row_nums.last().copied();
    info!(
        "[goi-sync] rewrite_sheet_xml: source_rows={}, previous_worker_rows={}, next_worker_rows={}, worker_row_num_min={:?}, worker_row_num_max={:?}",
        rows.len(),
        worker_row_nums.len(),
        current_callsigns.len(),
        worker_row_num_min,
        worker_row_num_max,
    );

    let mut out_rows = Vec::new();
    for row in rows {
        if row.is_worker {
            continue;
        }
        out_rows.push(row.xml);
    }
    let next_worker_row_num = out_rows
        .iter()
        .filter_map(|row| extract_row_num(row))
        .max()
        .map(|row_num| row_num + 1)
        .unwrap_or(1);
    out_rows.extend(current_callsigns.iter().enumerate().map(
        |(idx, callsign)| {
            build_worker_row_xml(
                next_worker_row_num + idx as u32,
                callsign,
                sync_timestamp,
            )
        },
    ));

    let mut out = String::with_capacity(
        prefix.len()
            + suffix.len()
            + out_rows.iter().map(|row| row.len()).sum::<usize>(),
    );
    out.push_str(&prefix);
    for row in &out_rows {
        out.push_str(row);
    }
    out.push_str(&suffix);
    info!(
        "[goi-sync] rewrite_sheet_xml finished: output_rows={}",
        out_rows.len()
    );
    Ok(update_sheet_dimension(&out, &out_rows))
}

fn split_sheet_xml(
    sheet_xml: &str,
) -> Result<(String, Vec<(u32, String)>, String), AppError> {
    let sheet_data_start =
        sheet_xml.find("<sheetData").ok_or_else(|| AppError::BL {
            msg: "GOI sheet XML has no <sheetData>".to_string(),
        })?;
    let sheet_data_tag_end = sheet_xml[sheet_data_start..]
        .find('>')
        .map(|idx| sheet_data_start + idx + 1)
        .ok_or_else(|| AppError::BL {
            msg: "GOI sheet XML has broken <sheetData> tag".to_string(),
        })?;
    let sheet_data_tag = &sheet_xml[sheet_data_start..sheet_data_tag_end];
    if sheet_data_tag.trim_end().ends_with("/>") {
        let sheet_data_open = sheet_data_tag
            .trim_end_matches('>')
            .trim_end()
            .trim_end_matches('/')
            .trim_end();
        return Ok((
            format!("{}{}>", &sheet_xml[..sheet_data_start], sheet_data_open),
            Vec::new(),
            format!("</sheetData>{}", &sheet_xml[sheet_data_tag_end..]),
        ));
    }

    let sheet_data_end =
        sheet_xml.find("</sheetData>").ok_or_else(|| AppError::BL {
            msg: "GOI sheet XML has no </sheetData>".to_string(),
        })?;

    let prefix = sheet_xml[..sheet_data_tag_end].to_string();
    let suffix = sheet_xml[sheet_data_end..].to_string();
    let sheet_data_inner = &sheet_xml[sheet_data_tag_end..sheet_data_end];
    let row_regex = Regex::new(r#"(?s)<row\b.*?</row>"#).c(h!())?;
    let row_num_regex = Regex::new(r#"<row\b[^>]*\br="(\d+)""#).c(h!())?;
    let mut rows = Vec::new();
    for row_match in row_regex.find_iter(sheet_data_inner) {
        let row_xml = row_match.as_str().to_string();
        let row_num = row_num_regex
            .captures(&row_xml)
            .and_then(|caps| caps.get(1))
            .and_then(|value| value.as_str().parse::<u32>().ok())
            .ok_or_else(|| AppError::BL {
                msg: "GOI sheet row has no numeric r attribute".to_string(),
            })?;
        rows.push((row_num, row_xml));
    }
    Ok((prefix, rows, suffix))
}

fn build_worker_row_xml(
    row_num: u32,
    callsign: &GoiCallsignState,
    sync_timestamp: &str,
) -> String {
    let mut cells = Vec::new();
    push_inline_string_cell(&mut cells, "A", row_num, &callsign.callsign);
    push_inline_string_cell(&mut cells, "B", row_num, &callsign.frequency);
    push_inline_string_cell(&mut cells, "C", row_num, KNOWLEDGE_KIND_CALL_SIGN);
    push_inline_string_cell(&mut cells, "D", row_num, KNOWLEDGE_WORKER_AUTHOR);
    push_inline_string_cell(&mut cells, "E", row_num, &callsign.comment);
    push_inline_string_cell(&mut cells, "F", row_num, sync_timestamp);
    push_inline_string_cell(&mut cells, "G", row_num, &callsign.unit);
    push_inline_string_cell(&mut cells, "H", row_num, &callsign.position);
    push_inline_string_cell(
        &mut cells,
        "I",
        row_num,
        &format!("{KNOWLEDGE_WORKER_ID_PREFIX}{}", callsign.id),
    );
    format!(r#"<row r="{row_num}">{}</row>"#, cells.join(""))
}

fn push_inline_string_cell(
    cells: &mut Vec<String>,
    col: &str,
    row_num: u32,
    value: &str,
) {
    if value.is_empty() {
        return;
    }
    let cell_ref = format!("{col}{row_num}");
    let value = quick_xml::escape::escape(value);
    cells.push(format!(
        r#"<c r="{cell_ref}" t="inlineStr"><is><t xml:space="preserve">{value}</t></is></c>"#
    ));
}

fn update_sheet_dimension(sheet_xml: &str, rows_xml: &[String]) -> String {
    let next_ref = match rows_xml
        .iter()
        .filter_map(|row_xml| extract_row_num(row_xml))
        .max()
    {
        Some(max_row_num) => {
            let max_col = rows_xml
                .iter()
                .flat_map(|row_xml| extract_cell_cols(row_xml))
                .max_by_key(|col| col_letters_to_idx(col))
                .unwrap_or_else(|| "A".to_string());
            format!("A1:{max_col}{max_row_num}")
        }
        None => "A1".to_string(),
    };
    let valid_dimension_regex =
        match Regex::new(r#"<dimension\b([^>]*?)\bref="[^"]*"([^>]*/?>)"#) {
            Ok(regex) => regex,
            Err(_) => return sheet_xml.to_string(),
        };
    if valid_dimension_regex.is_match(sheet_xml) {
        return valid_dimension_regex
            .replace(
                sheet_xml,
                format!(r#"<dimension${{1}}ref="{next_ref}"${{2}}"#),
            )
            .into_owned();
    }

    let malformed_dimension_regex =
        match Regex::new(r#"<dimension="[^"]*"([^>]*/?>)"#) {
            Ok(regex) => regex,
            Err(_) => return sheet_xml.to_string(),
        };
    if malformed_dimension_regex.is_match(sheet_xml) {
        return malformed_dimension_regex
            .replace(sheet_xml, format!(r#"<dimension ref="{next_ref}"${{1}}"#))
            .into_owned();
    }

    if let Some(sheet_data_start) = sheet_xml.find("<sheetData") {
        let mut out = String::with_capacity(
            sheet_xml.len() + r#"<dimension ref=""/>"#.len() + next_ref.len(),
        );
        out.push_str(&sheet_xml[..sheet_data_start]);
        out.push_str(&format!(r#"<dimension ref="{next_ref}"/>"#));
        out.push_str(&sheet_xml[sheet_data_start..]);
        return out;
    }

    sheet_xml.to_string()
}

fn extract_row_num(row_xml: &str) -> Option<u32> {
    Regex::new(r#"<row\b[^>]*\br="(\d+)""#)
        .ok()
        .and_then(|regex| regex.captures(row_xml))
        .and_then(|caps| caps.get(1))
        .and_then(|value| value.as_str().parse::<u32>().ok())
}

fn extract_cell_cols(row_xml: &str) -> Vec<String> {
    Regex::new(r#"<c\b[^>]*\br="([A-Z]+)\d+""#)
        .ok()
        .map(|regex| {
            regex
                .captures_iter(row_xml)
                .filter_map(|caps| {
                    caps.get(1).map(|value| value.as_str().to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn col_letters_to_idx(col: &str) -> usize {
    col.bytes().fold(0usize, |acc, ch| {
        acc * 26 + (usize::from(ch) - usize::from(b'A') + 1)
    })
}

fn row_text_equals(
    row: &[WorkbookCellValue],
    idx: usize,
    expected: &str,
) -> bool {
    workbook_cell_text(row.get(idx)) == expected.trim()
}

fn workbook_cell_text(cell: Option<&WorkbookCellValue>) -> String {
    match cell {
        Some(WorkbookCellValue::String(value)) => value.trim().to_string(),
        Some(WorkbookCellValue::Float(value)) => value.to_string(),
        Some(WorkbookCellValue::Int(value)) => value.to_string(),
        Some(WorkbookCellValue::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn is_callsign_row(row: &[WorkbookCellValue]) -> bool {
    row_text_equals(row, 2, KNOWLEDGE_KIND_CALL_SIGN)
}

fn is_worker_callsign_row(row: &[WorkbookCellValue]) -> bool {
    is_callsign_row(row) && row_text_equals(row, 3, KNOWLEDGE_WORKER_AUTHOR)
}

fn extract_goi_callsign_comment(row: &[WorkbookCellValue]) -> String {
    let note = workbook_cell_text(row.get(KNOWLEDGE_COMMENT_COL_IDX));
    let extra = workbook_cell_text(row.get(KNOWLEDGE_POSITION_COL_IDX));
    if parse_goi_callsign_id(row.get(KNOWLEDGE_COMMENT_COL_IDX)).is_some() {
        return extra;
    }
    note
}

fn extract_goi_callsign_position(row: &[WorkbookCellValue]) -> String {
    if parse_goi_callsign_id(row.get(KNOWLEDGE_WORKER_ID_COL_IDX)).is_some() {
        if parse_legacy_h_goi_callsign_id(row.get(KNOWLEDGE_POSITION_COL_IDX))
            .is_some()
        {
            return String::new();
        }
        return workbook_cell_text(row.get(KNOWLEDGE_POSITION_COL_IDX));
    }
    String::new()
}

fn parse_goi_callsign_id(cell: Option<&WorkbookCellValue>) -> Option<i64> {
    let value = workbook_cell_text(cell);
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(value) = value.strip_prefix(KNOWLEDGE_WORKER_ID_PREFIX) {
        return value.trim().parse::<i64>().ok();
    }
    value.parse::<i64>().ok()
}

fn parse_legacy_h_goi_callsign_id(
    cell: Option<&WorkbookCellValue>,
) -> Option<i64> {
    let value = workbook_cell_text(cell);
    value
        .trim()
        .strip_prefix(KNOWLEDGE_WORKER_ID_PREFIX)?
        .trim()
        .parse::<i64>()
        .ok()
}

impl From<&Data> for WorkbookCellValue {
    fn from(cell: &Data) -> Self {
        match cell {
            Data::Int(value) => Self::Int(*value),
            Data::Float(value) => Self::Float(*value),
            Data::String(value) => Self::String(value.clone()),
            Data::Bool(value) => Self::Bool(*value),
            Data::DateTime(value) => value
                .as_datetime()
                .map(|datetime| Self::String(datetime.to_string()))
                .unwrap_or_else(|| Self::Float(value.as_f64())),
            Data::DateTimeIso(value) | Data::DurationIso(value) => {
                Self::String(value.clone())
            }
            Data::Error(value) => Self::String(value.to_string()),
            Data::Empty => Self::Empty,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn sample_callsign(
        id: i64,
        callsign: &str,
        row_num: Option<u32>,
    ) -> GoiCallsignState {
        GoiCallsignState {
            id,
            callsign: callsign.to_string(),
            frequency: "145.500".to_string(),
            unit: "3 ОМСБр".to_string(),
            position: "КР".to_string(),
            comment: "джерело: Пролом".to_string(),
            row_ref: row_num.map(|row_num| GoiWorkbookRowRef {
                sheet_name: "Knowledge".to_string(),
                row_num,
            }),
        }
    }

    fn sample_live_callsign_row() -> LiveCallsignRow {
        LiveCallsignRow {
            id: 10,
            network_id: 20,
            sigint_callsign: "BARS".to_string(),
            position: None,
            comment: None,
            source_id: None,
            radio_freq: None,
            sc_deleted: Some(false),
            sc_position: Some("fallback position".to_string()),
            sc_comment: Some("fallback comment".to_string()),
            sc_source_id: Some(7),
            sc_radio_freq: Some("145.600".to_string()),
            unit_name: None,
            sc_unit_name: Some("fallback unit".to_string()),
        }
    }

    #[test]
    fn diff_goi_callsigns_reports_all_real_ids() {
        let previous = vec![
            sample_callsign(2, "BETA", Some(2)),
            sample_callsign(3, "GAMMA", Some(3)),
            sample_callsign(4, "DELTA", Some(4)),
        ];
        let mut edited = sample_callsign(3, "GAMMA", Some(3));
        edited.comment = "джерело: Барс".to_string();
        let current = vec![
            sample_callsign(1, "ALFA", None),
            sample_callsign(2, "BETA", None),
            edited,
        ];

        let diff = diff_goi_callsigns(&previous, &current);

        assert_eq!(diff.new_ids, vec![1]);
        assert_eq!(diff.edited_ids, vec![3]);
        assert_eq!(diff.deleted_ids, vec![4]);
    }

    #[test]
    fn goi_download_error_is_missing_file_matches_expected_ssh_errors() {
        assert!(goi_download_error_is_missing_file(&anyhow::anyhow!(
            "scp_recv failed: No such file"
        )));
        assert!(goi_download_error_is_missing_file(&anyhow::anyhow!(
            "remote path does not exist"
        )));
        assert!(!goi_download_error_is_missing_file(&anyhow::anyhow!(
            "permission denied"
        )));
    }

    #[test]
    fn format_goi_callsign_id_summary_reports_len_min_max() {
        assert_eq!(format_goi_callsign_id_summary(&[]), "len=0, min=-, max=-");
        assert_eq!(
            format_goi_callsign_id_summary(&[30, 10, 20]),
            "len=3, min=10, max=30"
        );
    }

    #[test]
    fn merged_live_unit_name_ignores_deleted_linked_callsign() {
        let mut callsign = sample_live_callsign_row();
        callsign.sc_deleted = Some(true);

        let unit = merged_live_unit_name(&callsign);

        assert_eq!(unit, "");
    }

    #[test]
    fn merged_live_unit_name_prefers_network_callsign_unit() {
        let mut callsign = sample_live_callsign_row();
        callsign.unit_name = Some("  3 ОМСБр  ".to_string());

        let unit = merged_live_unit_name(&callsign);

        assert_eq!(unit, "3 ОМСБр");
    }

    #[test]
    fn merged_live_unit_name_uses_linked_callsign_unit() {
        let callsign = sample_live_callsign_row();

        let unit = merged_live_unit_name(&callsign);

        assert_eq!(unit, "fallback unit");
    }

    #[test]
    fn merged_live_position_ignores_deleted_linked_callsign() {
        let mut callsign = sample_live_callsign_row();
        callsign.sc_deleted = Some(true);

        let position = merged_live_position(&callsign);

        assert_eq!(position, "");
    }

    #[test]
    fn merged_live_position_prefers_network_callsign_position() {
        let mut callsign = sample_live_callsign_row();
        callsign.position = Some("  КР  ".to_string());

        let position = merged_live_position(&callsign);

        assert_eq!(position, "КР");
    }

    #[test]
    fn merged_live_position_uses_linked_callsign_position() {
        let callsign = sample_live_callsign_row();

        let position = merged_live_position(&callsign);

        assert_eq!(position, "fallback position");
    }

    #[test]
    fn merged_live_source_name_ignores_deleted_linked_callsign() {
        let mut callsign = sample_live_callsign_row();
        callsign.sc_deleted = Some(true);
        let source_names = BTreeMap::from([(7_i64, "source".to_string())]);

        let source_name = merged_live_source_name(&callsign, &source_names);

        assert_eq!(source_name, None);
    }

    #[test]
    fn merged_live_comment_text_ignores_deleted_linked_callsign() {
        let mut callsign = sample_live_callsign_row();
        callsign.sc_deleted = Some(true);

        let comment = merged_live_comment_text(&callsign);

        assert_eq!(comment, None);
    }

    #[test]
    fn render_live_comment_puts_rank_before_source() {
        let comment = render_live_comment(Some(" сержант "), Some(" ПРОЛОМ "));

        assert_eq!(comment, "сержант; джерело: ПРОЛОМ");
    }

    #[test]
    fn render_live_comment_does_not_prepend_empty_rank() {
        let comment = render_live_comment(Some("  "), Some(" ПРОЛОМ "));

        assert_eq!(comment, "джерело: ПРОЛОМ");
    }

    #[test]
    fn effective_live_callsign_frequency_prefers_network_callsign_radio_freq() {
        let mut callsign = sample_live_callsign_row();
        callsign.radio_freq = Some(" 144.500 ".to_string());
        let network_freqs =
            BTreeMap::from([(20_i64, "111.111, 222.222".to_string())]);

        let frequency =
            effective_live_callsign_frequency(&callsign, &network_freqs);

        assert_eq!(frequency, Some("144.500".to_string()));
    }

    #[test]
    fn effective_live_callsign_frequency_uses_linked_callsign_radio_freq() {
        let callsign = sample_live_callsign_row();

        let frequency =
            effective_live_callsign_frequency(&callsign, &BTreeMap::new());

        assert_eq!(frequency, Some("145.600".to_string()));
    }

    #[test]
    fn effective_live_callsign_frequency_ignores_deleted_linked_callsign() {
        let mut callsign = sample_live_callsign_row();
        callsign.sc_deleted = Some(true);
        let network_freqs = BTreeMap::from([(20_i64, "111.111".to_string())]);

        let frequency =
            effective_live_callsign_frequency(&callsign, &network_freqs);

        assert_eq!(frequency, Some("111.111".to_string()));
    }

    #[test]
    fn validate_zip_archive_bytes_rejects_local_header_size_mismatch() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored);
        writer
            .start_file("xl/worksheets/sheet1.xml", options)
            .expect("start_file");
        writer.write_all(b"abc").expect("write_all");
        let mut data = writer.finish().expect("finish").into_inner();
        assert!(validate_zip_archive_bytes(&data).is_ok());

        data[18..22].copy_from_slice(&4_u32.to_le_bytes());

        assert!(validate_zip_archive_bytes(&data).is_err());
    }

    #[test]
    fn update_sheet_dimension_keeps_valid_ref_and_expands_last_row() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H3"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2"/></row><row r="3"><c r="A3"/></row><row r="4"><c r="A4"/><c r="H4"/></row></sheetData></worksheet>"#;
        let rows_xml = vec![
            r#"<row r="1"><c r="A1"/></row>"#.to_string(),
            r#"<row r="2"><c r="A2"/></row>"#.to_string(),
            r#"<row r="3"><c r="A3"/></row>"#.to_string(),
            r#"<row r="4"><c r="A4"/><c r="H4"/></row>"#.to_string(),
        ];

        let updated = update_sheet_dimension(sheet_xml, &rows_xml);

        assert!(updated.contains(r#"<dimension ref="A1:H4"/>"#));
    }

    #[test]
    fn update_sheet_dimension_repairs_malformed_dimension_tag() {
        let sheet_xml = r#"<worksheet><dimension="A1:H3"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2"/></row><row r="3"><c r="A3"/></row><row r="4"><c r="A4"/><c r="H4"/></row></sheetData></worksheet>"#;
        let rows_xml = vec![
            r#"<row r="1"><c r="A1"/></row>"#.to_string(),
            r#"<row r="2"><c r="A2"/></row>"#.to_string(),
            r#"<row r="3"><c r="A3"/></row>"#.to_string(),
            r#"<row r="4"><c r="A4"/><c r="H4"/></row>"#.to_string(),
        ];

        let updated = update_sheet_dimension(sheet_xml, &rows_xml);

        assert!(updated.contains(r#"<dimension ref="A1:H4"/>"#));
    }

    #[test]
    fn update_sheet_dimension_inserts_missing_dimension_tag() {
        let sheet_xml = r#"<worksheet><sheetData><row r="1"><c r="A1"/><c r="H1"/></row></sheetData></worksheet>"#;
        let rows_xml =
            vec![r#"<row r="1"><c r="A1"/><c r="H1"/></row>"#.to_string()];

        let updated = update_sheet_dimension(sheet_xml, &rows_xml);

        assert!(updated.contains(r#"<dimension ref="A1:H1"/><sheetData>"#));
    }

    #[test]
    fn extract_goi_callsigns_state_reads_worker_rows_from_workbook() {
        let workbook = KnowledgeWorkbookData {
            sheets: vec![
                WorkbookSheetData {
                    name: "Knowledge".to_string(),
                    rows: vec![
                        vec![
                            WorkbookCellValue::String("MANUAL".to_string()),
                            WorkbookCellValue::String("111.111".to_string()),
                            WorkbookCellValue::String(
                                KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                            ),
                            WorkbookCellValue::String("USER".to_string()),
                            WorkbookCellValue::String("999".to_string()),
                        ],
                        vec![
                            WorkbookCellValue::String("BETA".to_string()),
                            WorkbookCellValue::String("145.500".to_string()),
                            WorkbookCellValue::String(
                                KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                            ),
                            WorkbookCellValue::String(
                                KNOWLEDGE_WORKER_AUTHOR.to_string(),
                            ),
                            WorkbookCellValue::String(
                                "джерело: Пролом".to_string(),
                            ),
                            WorkbookCellValue::Empty,
                            WorkbookCellValue::String("3 ОМСБр".to_string()),
                            WorkbookCellValue::String("КР".to_string()),
                            WorkbookCellValue::String("EXO ID 2".to_string()),
                        ],
                    ],
                },
                WorkbookSheetData {
                    name: "Other".to_string(),
                    rows: vec![vec![
                        WorkbookCellValue::String("ALFA".to_string()),
                        WorkbookCellValue::String("146.600".to_string()),
                        WorkbookCellValue::String(
                            KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                        ),
                        WorkbookCellValue::String(
                            KNOWLEDGE_WORKER_AUTHOR.to_string(),
                        ),
                        WorkbookCellValue::Float(1.0),
                    ]],
                },
            ],
        };

        let state = workbook.extract_goi_callsigns_state();

        assert_eq!(state.len(), 2);
        assert_eq!(state[0].id, 1);
        assert_eq!(state[0].callsign, "ALFA");
        assert_eq!(
            state[0].row_ref,
            Some(GoiWorkbookRowRef {
                sheet_name: "Other".to_string(),
                row_num: 1,
            })
        );
        assert_eq!(state[1].id, 2);
        assert_eq!(state[1].callsign, "BETA");
        assert_eq!(state[1].frequency, "145.500");
        assert_eq!(state[1].unit, "3 ОМСБр");
        assert_eq!(state[1].position, "КР");
        assert_eq!(state[1].comment, "джерело: Пролом");
    }

    #[test]
    fn extract_goi_callsigns_state_reads_legacy_column_h_id_layout() {
        let workbook = KnowledgeWorkbookData {
            sheets: vec![WorkbookSheetData {
                name: "Knowledge".to_string(),
                rows: vec![vec![
                    WorkbookCellValue::String("BETA".to_string()),
                    WorkbookCellValue::String("145.500".to_string()),
                    WorkbookCellValue::String(
                        KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                    ),
                    WorkbookCellValue::String(
                        KNOWLEDGE_WORKER_AUTHOR.to_string(),
                    ),
                    WorkbookCellValue::String("джерело: Пролом".to_string()),
                    WorkbookCellValue::String(
                        TEST_GOI_SYNC_TIMESTAMP.to_string(),
                    ),
                    WorkbookCellValue::String("3 ОМСБр".to_string()),
                    WorkbookCellValue::String("EXO ID 2".to_string()),
                ]],
            }],
        };

        let state = workbook.extract_goi_callsigns_state();

        assert_eq!(state.len(), 1);
        assert_eq!(state[0].id, 2);
        assert_eq!(state[0].position, "");
        assert_eq!(state[0].comment, "джерело: Пролом");
    }

    #[test]
    fn extract_goi_callsigns_state_reads_legacy_worker_comment_layout() {
        let workbook = KnowledgeWorkbookData {
            sheets: vec![WorkbookSheetData {
                name: "Knowledge".to_string(),
                rows: vec![vec![
                    WorkbookCellValue::String("BETA".to_string()),
                    WorkbookCellValue::String("145.500".to_string()),
                    WorkbookCellValue::String(
                        KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                    ),
                    WorkbookCellValue::String(
                        KNOWLEDGE_WORKER_AUTHOR.to_string(),
                    ),
                    WorkbookCellValue::String("EXO ID 2".to_string()),
                    WorkbookCellValue::String(
                        TEST_GOI_SYNC_TIMESTAMP.to_string(),
                    ),
                    WorkbookCellValue::String("3 ОМСБр".to_string()),
                    WorkbookCellValue::String("джерело: Пролом".to_string()),
                ]],
            }],
        };

        let state = workbook.extract_goi_callsigns_state();

        assert_eq!(state.len(), 1);
        assert_eq!(state[0].id, 2);
        assert_eq!(state[0].position, "");
        assert_eq!(state[0].comment, "джерело: Пролом");
    }

    #[test]
    fn apply_goi_callsigns_to_empty_xlsx_creates_worker_rows() {
        let file_data = empty_xlsx_buffer().expect("empty xlsx");
        let workbook =
            KnowledgeWorkbookData::from_xlsx_bytes(&file_data).expect("parse");
        let current = vec![
            sample_callsign(5, "EPSILON", None),
            sample_callsign(2, "BETA", None),
        ];

        let next_file_data = apply_goi_callsigns_to_xlsx(
            &file_data,
            &workbook,
            &[],
            &current,
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("apply_goi_callsigns_to_xlsx");
        validate_knowledge_xlsx_bytes(&next_file_data).expect("validate");
        let next = KnowledgeWorkbookData::from_xlsx_bytes(&next_file_data)
            .expect("parse next")
            .extract_goi_callsigns_state();

        assert_eq!(next.len(), 2);
        assert_eq!(next[0].id, 2);
        assert_eq!(next[0].callsign, "BETA");
        assert_eq!(next[0].unit, "3 ОМСБр");
        assert_eq!(next[0].position, "КР");
        assert_eq!(next[1].id, 5);
        assert_eq!(next[1].callsign, "EPSILON");
    }

    #[test]
    fn apply_goi_callsigns_removes_stale_rows_and_compacts_worker_block() {
        let mut workbook = KnowledgeWorkbookData {
            sheets: vec![WorkbookSheetData {
                name: "Knowledge".to_string(),
                rows: vec![
                    vec![],
                    vec![
                        WorkbookCellValue::String("BETA".to_string()),
                        WorkbookCellValue::String("145.500".to_string()),
                        WorkbookCellValue::String(
                            KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                        ),
                        WorkbookCellValue::String(
                            KNOWLEDGE_WORKER_AUTHOR.to_string(),
                        ),
                        WorkbookCellValue::String(
                            "джерело: Пролом".to_string(),
                        ),
                        WorkbookCellValue::String(
                            TEST_GOI_SYNC_TIMESTAMP.to_string(),
                        ),
                        WorkbookCellValue::String("3 ОМСБр".to_string()),
                        WorkbookCellValue::String("EXO ID 2".to_string()),
                    ],
                    vec![
                        WorkbookCellValue::String("DELTA".to_string()),
                        WorkbookCellValue::String("145.500".to_string()),
                        WorkbookCellValue::String(
                            KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                        ),
                        WorkbookCellValue::String(
                            KNOWLEDGE_WORKER_AUTHOR.to_string(),
                        ),
                        WorkbookCellValue::String(
                            "джерело: Пролом".to_string(),
                        ),
                        WorkbookCellValue::String(
                            TEST_GOI_SYNC_TIMESTAMP.to_string(),
                        ),
                        WorkbookCellValue::String("3 ОМСБр".to_string()),
                        WorkbookCellValue::String("EXO ID 4".to_string()),
                    ],
                ],
            }],
        };
        let previous = vec![
            sample_callsign(2, "BETA", Some(2)),
            sample_callsign(4, "DELTA", Some(3)),
        ];
        let current = vec![
            sample_callsign(2, "BETA", None),
            sample_callsign(5, "EPSILON", None),
        ];

        workbook
            .apply_goi_callsigns(&previous, &current)
            .expect("apply_goi_callsigns");
        let next = workbook.extract_goi_callsigns_state();

        assert_eq!(next.len(), 2);
        assert_eq!(next[0].id, 2);
        assert_eq!(next[0].row_ref.as_ref().map(|row| row.row_num), Some(2));
        assert_eq!(next[1].id, 5);
        assert_eq!(next[1].row_ref.as_ref().map(|row| row.row_num), Some(3));
        assert_eq!(next[1].callsign, "EPSILON");
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[2][5])),
            TEST_GOI_SYNC_TIMESTAMP
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[2][4])),
            "джерело: Пролом"
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[2][6])),
            "3 ОМСБр"
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[2][7])),
            "КР"
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[2][8])),
            "EXO ID 5"
        );
    }

    #[test]
    fn rewrite_sheet_xml_preserves_manual_rows_and_compacts_worker_block() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H4"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2"/></row><row r="3"><c r="A3"/></row><row r="4"><c r="A4"/><c r="B4"><f>SUM(A1:A3)</f></c></row></sheetData></worksheet>"#;
        let current = vec![sample_callsign(2, "BETA", None)];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::from([2, 3]),
            &current,
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert!(rewritten.contains(
            r#"<row r="4"><c r="A4"/><c r="B4"><f>SUM(A1:A3)</f></c></row>"#
        ));
        assert!(rewritten.contains(r#"<row r="5"><c r="A5" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c>"#));
        assert!(!rewritten.contains(r#"<row r="2"><c r="A2"/></row>"#));
        assert!(!rewritten.contains(r#"<row r="3"><c r="A3"/></row>"#));
    }

    #[test]
    fn rewrite_sheet_xml_expands_self_closing_sheet_data() {
        let sheet_xml =
            r#"<worksheet><dimension ref="A1"/><sheetData/></worksheet>"#;
        let current = vec![sample_callsign(2, "BETA", None)];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::new(),
            &current,
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert!(rewritten.contains("<sheetData>"));
        assert!(rewritten.contains("</sheetData>"));
        assert!(rewritten.contains(r#"<dimension ref="A1:I1"/>"#));
        assert!(rewritten.contains(r#"<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c>"#));
    }

    #[test]
    fn rewrite_sheet_xml_appends_missing_ids_sorted_by_id() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H3"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2"/></row><row r="3"><c r="A3"/><c r="B3"><f>SUM(A1:A2)</f></c></row></sheetData></worksheet>"#;
        let current = vec![
            sample_callsign(5, "EPSILON", None),
            sample_callsign(2, "BETA", None),
        ];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::from([2]),
            &unique_sorted_goi_callsigns(&current),
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert!(rewritten.contains(
            r#"<row r="3"><c r="A3"/><c r="B3"><f>SUM(A1:A2)</f></c></row>"#
        ));
        assert!(rewritten.contains(r#"<row r="4"><c r="A4" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="H4" t="inlineStr"><is><t xml:space="preserve">КР</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="I4" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c>"#));
        assert!(rewritten.contains(r#"<row r="5"><c r="A5" t="inlineStr"><is><t xml:space="preserve">EPSILON</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="H5" t="inlineStr"><is><t xml:space="preserve">КР</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="I5" t="inlineStr"><is><t xml:space="preserve">EXO ID 5</t></is></c>"#));
        assert!(!rewritten.contains(r#"<row r="2"><c r="A2"/></row>"#));
    }

    #[test]
    fn rewrite_sheet_xml_deduplicates_current_callsign_ids() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H1"/><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>"#;
        let current = vec![
            sample_callsign(2, "BETA", None),
            sample_callsign(2, "BETA DUPLICATE", None),
            sample_callsign(5, "EPSILON", None),
        ];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::new(),
            &current,
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert_eq!(rewritten.matches("EXO ID 2").count(), 1);
        assert_eq!(rewritten.matches("EXO ID 5").count(), 1);
        assert!(rewritten.contains(r#"<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c>"#));
        assert!(rewritten.contains(r#"<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">EPSILON</t></is></c>"#));
        assert!(!rewritten.contains("BETA DUPLICATE"));
    }

    #[test]
    fn rewrite_sheet_xml_restores_erased_column_g() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H2"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c><c r="B2" t="inlineStr"><is><t xml:space="preserve">145.500</t></is></c><c r="C2" t="inlineStr"><is><t xml:space="preserve">CALL_SIGN</t></is></c><c r="D2" t="inlineStr"><is><t xml:space="preserve">EXO</t></is></c><c r="H2" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c></row></sheetData></worksheet>"#;
        let current = vec![sample_callsign(2, "BETA", None)];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::from([2]),
            &current,
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert!(rewritten.contains(r#"<c r="G2" t="inlineStr"><is><t xml:space="preserve">3 ОМСБр</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="H2" t="inlineStr"><is><t xml:space="preserve">КР</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="I2" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c>"#));
        assert!(!rewritten.contains(r#"<c r="H2" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c>"#));
    }

    #[test]
    fn rewrite_sheet_xml_removes_stale_worker_rows_and_shrinks_empty_sheet() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c><c r="C1" t="inlineStr"><is><t xml:space="preserve">CALL_SIGN</t></is></c><c r="D1" t="inlineStr"><is><t xml:space="preserve">EXO</t></is></c><c r="H1" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c></row></sheetData></worksheet>"#;

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::from([1]),
            &[],
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert!(rewritten.contains(r#"<dimension ref="A1"/>"#));
        assert!(!rewritten.contains("EXO ID 2"));
    }

    #[test]
    fn rewrite_sheet_xml_uses_current_data_when_existing_rows_are_reordered() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H3"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">EPSILON OLD</t></is></c><c r="C2" t="inlineStr"><is><t xml:space="preserve">CALL_SIGN</t></is></c><c r="D2" t="inlineStr"><is><t xml:space="preserve">EXO</t></is></c><c r="H2" t="inlineStr"><is><t xml:space="preserve">EXO ID 5</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">BETA OLD</t></is></c><c r="C3" t="inlineStr"><is><t xml:space="preserve">CALL_SIGN</t></is></c><c r="D3" t="inlineStr"><is><t xml:space="preserve">EXO</t></is></c><c r="H3" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c></row></sheetData></worksheet>"#;
        let current = vec![
            sample_callsign(5, "EPSILON", None),
            sample_callsign(2, "BETA", None),
        ];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::from([2, 3]),
            &unique_sorted_goi_callsigns(&current),
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert!(rewritten.contains(r#"<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="H2" t="inlineStr"><is><t xml:space="preserve">КР</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="I2" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c>"#));
        assert!(rewritten.contains(r#"<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">EPSILON</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="H3" t="inlineStr"><is><t xml:space="preserve">КР</t></is></c>"#));
        assert!(rewritten.contains(r#"<c r="I3" t="inlineStr"><is><t xml:space="preserve">EXO ID 5</t></is></c>"#));
        assert!(!rewritten.contains("BETA OLD"));
        assert!(!rewritten.contains("EPSILON OLD"));
    }

    #[test]
    fn rewrite_sheet_xml_removes_existing_duplicate_worker_rows() {
        let sheet_xml = r#"<worksheet><dimension ref="A1:H3"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">BETA OLD 1</t></is></c><c r="C2" t="inlineStr"><is><t xml:space="preserve">CALL_SIGN</t></is></c><c r="D2" t="inlineStr"><is><t xml:space="preserve">EXO</t></is></c><c r="H2" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">BETA OLD 2</t></is></c><c r="C3" t="inlineStr"><is><t xml:space="preserve">CALL_SIGN</t></is></c><c r="D3" t="inlineStr"><is><t xml:space="preserve">EXO</t></is></c><c r="H3" t="inlineStr"><is><t xml:space="preserve">EXO ID 2</t></is></c></row></sheetData></worksheet>"#;
        let current = vec![sample_callsign(2, "BETA", None)];

        let rewritten = rewrite_sheet_xml(
            sheet_xml,
            &BTreeSet::from([2, 3]),
            &current,
            TEST_GOI_SYNC_TIMESTAMP,
        )
        .expect("rewrite_sheet_xml");

        assert_eq!(rewritten.matches("EXO ID 2").count(), 1);
        assert!(rewritten.contains(r#"<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">BETA</t></is></c>"#));
        assert!(!rewritten.contains("BETA OLD 1"));
        assert!(!rewritten.contains("BETA OLD 2"));
    }

    #[test]
    fn apply_goi_callsigns_migrates_legacy_column_e_id_layout() {
        let mut workbook = KnowledgeWorkbookData {
            sheets: vec![WorkbookSheetData {
                name: "Knowledge".to_string(),
                rows: vec![vec![
                    WorkbookCellValue::String("BETA OLD".to_string()),
                    WorkbookCellValue::String("145.500".to_string()),
                    WorkbookCellValue::String(
                        KNOWLEDGE_KIND_CALL_SIGN.to_string(),
                    ),
                    WorkbookCellValue::String(
                        KNOWLEDGE_WORKER_AUTHOR.to_string(),
                    ),
                    WorkbookCellValue::String("EXO ID 2".to_string()),
                    WorkbookCellValue::String(
                        TEST_GOI_SYNC_TIMESTAMP.to_string(),
                    ),
                    WorkbookCellValue::Empty,
                    WorkbookCellValue::String("old comment".to_string()),
                ]],
            }],
        };
        let previous = workbook.extract_goi_callsigns_state();
        let current = vec![sample_callsign(2, "BETA", None)];

        workbook
            .apply_goi_callsigns(&previous, &current)
            .expect("apply_goi_callsigns");
        let next = workbook.extract_goi_callsigns_state();

        assert_eq!(next.len(), 1);
        assert_eq!(next[0].id, 2);
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[0][4])),
            "джерело: Пролом"
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[0][6])),
            "3 ОМСБр"
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[0][7])),
            "КР"
        );
        assert_eq!(
            workbook_cell_text(Some(&workbook.sheets[0].rows[0][8])),
            "EXO ID 2"
        );
    }
}

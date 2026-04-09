use crate::entities::{
    datasource, sigint_network, sigint_network::Entity as SigintNetwork,
    sigint_peleng,
};
use crate::error::AppError;
use crate::rer_importer::inbox::get_inbox_messages_with_conn;
use crate::rer_importer::reports::types::ReportPreviewReq;
use crate::rer_importer::types::InboxMessage;
use crate::types::*;
use crate::utils::dt_zoned_from_millis;
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use anyhow::Context;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use docx_rs::{
    AlignmentType, Docx, PageMargin, PageOrientationType, Paragraph, Run,
};
use geoconvert::{LatLon, Mgrs};
use itertools::Itertools;
use sea_orm::*;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

const REPORT_1213_EMPTY_TEXT: &str =
    "За обраний період даних для звіту 1.2.13 не виявлено";
const REPORT_1213_UNKNOWN_TEXT: &str = "Не встановлено";
const REPORT_1213_DOC_NAME: &str = "Форма №1.2.13/ГУР";
const REPORT_1213_DOC_HEADER: &str =
    "Донесення за результатами функціонування тактичної радіопеленгаторної мережі у зоні відповідальності УОС (УВ (с), УСіЗ)";

const REPORT_1213_P1: &str = "  1. Склад сил і засобів, які розгорнуті для визначення місцеположення джерел (об’єктів) розвідки:";
const REPORT_1213_P2: &str = "Для визначення місцезнаходження джерел (об’єктів ) розвідки задіяно ... операторів з моніторингу радіомереж, розгорнуто ....";
const REPORT_1213_P3: &str = "  2. Зміни в стані засобів пеленгування (вихід з ладу, зміна технічних позицій, розгортання нових засобів, втрати та заходи щодо відновлення): Обладнання та засоби пеленгування в наявності та у справному стані.";
const REPORT_1213_P4: &str = "  3. Загальна кількість викритих (підтверджених) районів, кількість отриманих пеленгів (напрямків): 0";
const REPORT_1213_P5: &str =
    "   4. Результати визначення місцеположення джерел (об’єктів) розвідки.";
const REPORT_1213_DOC_FOOTER_PARAGRAPH: &str = "Начальник ОВУР";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Report1213Data {
    report_till_at: Option<DateTime<Utc>>,
    items: Vec<Report1213Item>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Report1213Item {
    network_name: String,
    nominal_working_freq: String,
    first_seen_at: NaiveDateTime,
    last_seen_at: NaiveDateTime,
    node_callsign: Option<String>,
    source_mgrs: Option<String>,
}

#[derive(Debug, Clone)]
struct SenderNameStat {
    count: usize,
    last_seen_at: NaiveDateTime,
}

#[derive(Debug, Clone)]
struct Report1213Accumulator {
    network_name: String,
    nominal_working_freq: String,
    first_seen_at: NaiveDateTime,
    last_seen_at: NaiveDateTime,
    sender_name_stats: BTreeMap<String, SenderNameStat>,
    latest_source_mgrs: Option<(NaiveDateTime, String)>,
}

impl Report1213Accumulator {
    fn new(
        network_name: String,
        nominal_working_freq: String,
        seen_at: NaiveDateTime,
    ) -> Self {
        Self {
            network_name,
            nominal_working_freq,
            first_seen_at: seen_at,
            last_seen_at: seen_at,
            sender_name_stats: BTreeMap::new(),
            latest_source_mgrs: None,
        }
    }

    fn observe_datetime(&mut self, seen_at: NaiveDateTime) {
        self.first_seen_at = self.first_seen_at.min(seen_at);
        self.last_seen_at = self.last_seen_at.max(seen_at);
    }

    fn observe_sender_names(
        &mut self,
        sender_names: &[String],
        seen_at: NaiveDateTime,
    ) {
        for sender_name in sender_names {
            self.sender_name_stats
                .entry(sender_name.clone())
                .and_modify(|stat| {
                    stat.count += 1;
                    stat.last_seen_at = stat.last_seen_at.max(seen_at);
                })
                .or_insert(SenderNameStat {
                    count: 1,
                    last_seen_at: seen_at,
                });
        }
    }

    fn observe_source_mgrs(&mut self, mgrs: String, seen_at: NaiveDateTime) {
        match self.latest_source_mgrs.as_ref() {
            Some((latest_seen_at, _)) if *latest_seen_at > seen_at => {}
            _ => self.latest_source_mgrs = Some((seen_at, mgrs)),
        }
    }

    fn finish(self) -> Report1213Item {
        Report1213Item {
            network_name: self.network_name,
            nominal_working_freq: self.nominal_working_freq,
            first_seen_at: self.first_seen_at,
            last_seen_at: self.last_seen_at,
            node_callsign: pick_report_1213_sender_name(
                &self.sender_name_stats,
            ),
            source_mgrs: self.latest_source_mgrs.map(|(_, mgrs)| mgrs),
        }
    }
}

pub async fn report_docx_kind_report_1213(
    user: Identity,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let (read_db, replica_label) = env.replica_with_label();
    match replica_label {
        Some(label) => info!("Report 1.2.13 using replica {label}"),
        None => info!("Report 1.2.13 using primary database"),
    }

    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&read_db, user)
        .await
        .c(h!())?;
    let report_data =
        collect_report_1213_data(&read_db, &login, &logins, env, req).await?;

    build_report_1213_docx_to_path(&report_data, outpath).context(h!())?;
    Ok(())
}

async fn collect_report_1213_data(
    dbx: &DatabaseConnection,
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &ReportPreviewReq,
) -> Result<Report1213Data, AppError> {
    let mut inbox_req = req.req.clone();
    inbox_req.nolimit = Some(true);
    inbox_req.report_tags_only_this_unit = Some(false);

    let messages =
        get_inbox_messages_with_conn(dbx, login, logins, env, &inbox_req)
            .await
            .c(h!())?;
    let message_ids = messages
        .iter()
        .map(|(message_id, _)| *message_id)
        .collect_vec();
    let pelengs_by_message =
        load_report_1213_pelengs(dbx, &message_ids).await?;
    let own_datasource_ids = if req.report_tags_only_this_unit == Some(true) {
        Some(load_report_1213_datasource_ids(dbx, logins).await?)
    } else {
        None
    };
    let messages = messages
        .into_iter()
        .filter(|(message_id, message)| {
            pelengs_by_message.contains_key(message_id)
                && report_1213_message_matches_datasource_scope(
                    message,
                    own_datasource_ids.as_ref(),
                )
        })
        .collect_vec();

    let network_ids = messages
        .iter()
        .flat_map(|(_, message)| {
            message.network_ids.clone().unwrap_or_default()
        })
        .collect::<BTreeSet<_>>();
    let network_names =
        load_report_1213_network_names(dbx, &network_ids).await?;
    let include_only_linked_networks =
        req.report_1213_linked_networks_only.unwrap_or(true);

    let mut report_data = build_report_1213_data(
        messages,
        &network_names,
        &pelengs_by_message,
        include_only_linked_networks,
    )?;
    report_data.report_till_at = req
        .req
        .till_date_inclusive_ms
        .and_then(DateTime::from_timestamp_millis);
    Ok(report_data)
}

async fn load_report_1213_datasource_ids(
    dbx: &DatabaseConnection,
    logins: &[String],
) -> Result<BTreeSet<i64>, AppError> {
    if logins.is_empty() {
        return Ok(BTreeSet::new());
    }

    Ok(datasource::Entity::find()
        .filter(datasource::Column::Deleted.eq(false))
        .filter(datasource::Column::ApiLogin.is_in(logins.to_vec()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|datasource| datasource.id)
        .collect())
}

async fn load_report_1213_pelengs(
    dbx: &DatabaseConnection,
    message_ids: &[i64],
) -> Result<BTreeMap<i64, Vec<sigint_peleng::Model>>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let mut pelengs_map = BTreeMap::<i64, Vec<sigint_peleng::Model>>::new();
    for peleng in sigint_peleng::Entity::find()
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .filter(
            sigint_peleng::Column::SourceInboxItemId
                .eq_any(message_ids.to_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?
    {
        pelengs_map
            .entry(peleng.source_inbox_item_id)
            .or_default()
            .push(peleng);
    }

    Ok(pelengs_map)
}

async fn load_report_1213_network_names(
    dbx: &DatabaseConnection,
    network_ids: &BTreeSet<i64>,
) -> Result<HashMap<i64, String>, AppError> {
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    Ok(SigintNetwork::find()
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            sigint_network::Column::Id
                .eq_any(network_ids.iter().copied().collect_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|network| (network.id, network.name))
        .collect())
}

fn build_report_1213_data(
    messages: Vec<(i64, InboxMessage)>,
    network_names: &HashMap<i64, String>,
    pelengs_by_message: &BTreeMap<i64, Vec<sigint_peleng::Model>>,
    include_only_linked_networks: bool,
) -> Result<Report1213Data, AppError> {
    let mut rows: BTreeMap<(String, String), Report1213Accumulator> =
        BTreeMap::new();

    for (message_id, message) in messages {
        let Some(freq) = sanitize_report_1213_text(message.freq.clone()) else {
            continue;
        };
        let Some(seen_at) = extract_report_1213_datetime(&message)? else {
            continue;
        };
        let Some(pelengs) = pelengs_by_message.get(&message_id) else {
            continue;
        };

        let sender_names = message
            .metadata
            .iter()
            .filter_map(|entry| {
                sanitize_report_1213_text(entry.sender_name.clone())
            })
            .collect_vec();
        let source_mgrs = extract_report_1213_mgrs(pelengs);

        for row_def in build_report_1213_row_defs(
            &message,
            network_names,
            include_only_linked_networks,
        ) {
            let row = rows
                .entry((row_def.row_key, freq.clone()))
                .or_insert_with(|| {
                    Report1213Accumulator::new(
                        row_def.network_name,
                        freq.clone(),
                        seen_at,
                    )
                });
            row.observe_datetime(seen_at);
            row.observe_sender_names(&sender_names, seen_at);
            if let Some(ref source_mgrs) = source_mgrs {
                row.observe_source_mgrs(source_mgrs.clone(), seen_at);
            }
        }
    }

    let mut items = rows.into_values().map(|row| row.finish()).collect_vec();
    items.sort_by(|left, right| {
        left.nominal_working_freq
            .cmp(&right.nominal_working_freq)
            .then_with(|| left.network_name.cmp(&right.network_name))
    });

    Ok(Report1213Data {
        report_till_at: None,
        items,
    })
}

fn report_1213_message_matches_datasource_scope(
    message: &InboxMessage,
    own_datasource_ids: Option<&BTreeSet<i64>>,
) -> bool {
    let Some(own_datasource_ids) = own_datasource_ids else {
        return true;
    };

    message.datasource_id.is_some_and(|datasource_id| {
        own_datasource_ids.contains(&datasource_id)
    })
}

#[derive(Debug, Clone)]
struct Report1213RowDef {
    row_key: String,
    network_name: String,
}

fn build_report_1213_row_defs(
    message: &InboxMessage,
    network_names: &HashMap<i64, String>,
    include_only_linked_networks: bool,
) -> Vec<Report1213RowDef> {
    let linked_rows = message
        .network_ids
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|network_id| {
            network_names.get(&network_id).map(|network_name| {
                Report1213RowDef {
                    row_key: format!("network:{network_id}"),
                    network_name: network_name.clone(),
                }
            })
        })
        .unique_by(|row| row.row_key.clone())
        .collect_vec();

    if !linked_rows.is_empty() || include_only_linked_networks {
        return linked_rows;
    }

    let network_name = report_1213_fuzzy_network_name(message);
    vec![Report1213RowDef {
        row_key: format!("fuzzy:{network_name}"),
        network_name,
    }]
}

fn report_1213_fuzzy_network_name(message: &InboxMessage) -> String {
    sanitize_report_1213_text(message.unit.clone())
        .unwrap_or_else(|| REPORT_1213_UNKNOWN_TEXT.to_string())
}

fn extract_report_1213_datetime(
    message: &InboxMessage,
) -> Result<Option<NaiveDateTime>, AppError> {
    if let Some(timestamp_ms) = message.timestamp {
        return Ok(Some(dt_zoned_from_millis(timestamp_ms)?.naive_local()));
    }

    let (Some(date), Some(time)) =
        (message.date.as_ref(), message.time.as_ref())
    else {
        return Ok(None);
    };
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
    let time = parse_report_1213_time(time).context(h!())?;
    Ok(Some(date.and_time(time)))
}

fn parse_report_1213_time(input: &str) -> Result<NaiveTime, AppError> {
    for fmt in ["%H:%M:%S", "%H:%M"] {
        if let Ok(time) = NaiveTime::parse_from_str(input, fmt) {
            return Ok(time);
        }
    }
    Err(format!("Unable to parse report 1.2.13 time value: {input}").into())
}

fn extract_report_1213_mgrs(
    pelengs: &[sigint_peleng::Model],
) -> Option<String> {
    let peleng = pelengs
        .iter()
        .max_by_key(|peleng| (peleng.created_at, peleng.id))?;
    let latlon = LatLon::create(peleng.lat, peleng.lng).ok()?;
    Some(Mgrs::from_latlon(&latlon, 6).to_string())
}

fn pick_report_1213_sender_name(
    sender_name_stats: &BTreeMap<String, SenderNameStat>,
) -> Option<String> {
    sender_name_stats
        .iter()
        .max_by_key(|(sender_name, stat)| {
            (
                stat.count,
                stat.last_seen_at,
                Reverse((*sender_name).clone()),
            )
        })
        .map(|(sender_name, _)| sender_name.clone())
}

fn sanitize_report_1213_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn build_report_1213_docx_to_path(
    report_data: &Report1213Data,
    outpath: &Path,
) -> Result<(), AppError> {
    let file = std::fs::File::create(outpath)?;
    build_report_1213_docx(report_data)
        .build()
        .pack(file)
        .context(h!())?;
    Ok(())
}

fn build_report_1213_docx(report_data: &Report1213Data) -> Docx {
    let mut doc = Docx::new()
        .page_orient(PageOrientationType::Portrait)
        .default_size(24)
        .page_size(11906, 16838)
        .page_margin(PageMargin::new().left(600).right(300).top(1200));

    let form_paragraph = Paragraph::new()
        .add_run(Run::new().add_text(REPORT_1213_DOC_NAME).size(22))
        .align(AlignmentType::Right);
    let title_paragraph = Paragraph::new()
        .add_run(Run::new().add_text(REPORT_1213_DOC_HEADER).bold())
        .align(AlignmentType::Center);

    doc = doc
        .add_paragraph(form_paragraph)
        .add_paragraph(Paragraph::new())
        .add_paragraph(title_paragraph);

    if let Some(report_till_at) = report_data.report_till_at {
        let timestamp_txt = format!(
            "(станом на {})",
            crate::rer_importer::reports::digest::convert_utc_to_kyiv_time(
                report_till_at,
            )
        );
        doc = doc.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(&timestamp_txt))
                .align(AlignmentType::Center),
        );
    }

    doc = doc
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(REPORT_1213_P1)),
        )
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(REPORT_1213_P2)),
        )
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(REPORT_1213_P3)),
        )
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(REPORT_1213_P4)),
        )
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(REPORT_1213_P5)),
        )
        .add_paragraph(Paragraph::new());

    if report_data.items.is_empty() {
        doc = doc.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(REPORT_1213_EMPTY_TEXT)),
        );
    } else {
        for (idx, item) in report_data.items.iter().enumerate() {
            doc = doc
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(
                    format!("Назва радіомережі: {}", item.network_name),
                )))
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(
                    format!(
                        "Номінал робочої частоти: {}",
                        item.nominal_working_freq
                    ),
                )))
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(
                    format!(
                        "Час функціонування: {}",
                        render_report_1213_activity_period(item)
                    ),
                )))
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(
                    format!(
                        "Позивний вузла зв’язку: {}",
                        item.node_callsign.clone().unwrap_or_else(|| {
                            REPORT_1213_UNKNOWN_TEXT.to_string()
                        })
                    ),
                )))
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(
                    format!(
                        "Координати джерел (об’єктів): {}",
                        item.source_mgrs.clone().unwrap_or_else(|| {
                            REPORT_1213_UNKNOWN_TEXT.to_string()
                        })
                    ),
                )));

            if idx + 1 != report_data.items.len() {
                doc = doc.add_paragraph(Paragraph::new());
            }
        }
    }

    doc =
        doc.add_paragraph(Paragraph::new())
            .add_paragraph(Paragraph::new())
            .add_paragraph(Paragraph::new())
            .add_paragraph(Paragraph::new())
            .add_paragraph(Paragraph::new().add_run(
                Run::new().add_text(REPORT_1213_DOC_FOOTER_PARAGRAPH),
            ));

    doc
}

fn render_report_1213_activity_period(item: &Report1213Item) -> String {
    format!(
        "{}-{}",
        item.first_seen_at.format("%H:%M"),
        item.last_seen_at.format("%H:%M")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        datasource, datasource_group, login, organism, sigint_inbox_item,
        sigint_inbox_item_metadata, sigint_inbox_item_network, sigint_network,
        sigint_peleng, signal_message, signal_message_group,
    };
    use crate::functest::tests::*;
    use chrono::NaiveDate;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
    };
    use serde_json::json;
    use serial_test::serial;
    use tempfile::NamedTempFile;

    async fn seed_report_1213_message(
        dbx: &DatabaseConnection,
        datasource_group: &datasource_group::Model,
        network: Option<&sigint_network::Model>,
        label: &str,
        freq: &str,
        seen_at: NaiveDateTime,
        coords: Option<(f64, f64)>,
        unit: Option<&str>,
        metadata_sender_name: Option<&str>,
        callsigns: &[&str],
    ) -> Result<(), AppError> {
        let signal_message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(label.to_string())),
                created_at: Set(seen_at),
                timestamp: Set(Some(seen_at)),
                message_uid: Set(Some(label.to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(signal_message.id),
                group_master_key: Set(Some(
                    datasource_group.group_master_key.clone(),
                )),
                datasource_group_id: Set(Some(datasource_group.id)),
                sender: Set(Some(format!("{label}-sender"))),
                message_uid: Set(Some(label.to_string())),
                created_at: Set(seen_at),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(signal_message.id),
                freq: Set(Some(freq.to_string())),
                coords: Set(
                    coords.map(|(lat, lng)| format!("{lat:.6},{lng:.6}"))
                ),
                callsigns: Set(Some(json!(callsigns))),
                date: Set(Some(seen_at.date().to_string())),
                time: Set(Some(seen_at.time().format("%H:%M:%S").to_string())),
                unit: Set(unit.map(ToString::to_string)),
                unit_v2: Set(unit.map(ToString::to_string)),
                reviewed: Set(Some(true)),
                checked: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        if let Some((lat, lng)) = coords {
            mk_sigint_peleng(
                dbx,
                sigint_peleng::ActiveModel {
                    source_inbox_item_id: Set(signal_message.id),
                    lat: Set(lat),
                    lng: Set(lng),
                    created_at: Set(seen_at),
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
        }

        if let Some(network) = network {
            mk_sigint_inbox_item_network(
                dbx,
                sigint_inbox_item_network::ActiveModel {
                    sigint_inbox_item_id: Set(signal_message.id),
                    sigint_network_id: Set(network.id),
                    created_at: Set(seen_at),
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
        }

        if let Some(metadata_sender_name) = metadata_sender_name {
            mk_sigint_inbox_item_metadata(
                dbx,
                sigint_inbox_item_metadata::ActiveModel {
                    sigint_inbox_item_id: Set(signal_message.id),
                    sender_name: Set(Some(metadata_sender_name.to_string())),
                    created_at: Set(seen_at),
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
        }

        Ok(())
    }

    fn test_dt(day: u32, hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 3, day)
            .expect("date")
            .and_hms_opt(hour, minute, 0)
            .expect("time")
    }

    fn reported_dt(day: u32, hour: u32, minute: u32) -> NaiveDateTime {
        crate::utils::dt_zoned_from_millis(
            test_dt(day, hour, minute).and_utc().timestamp_millis(),
        )
        .expect("local dt")
        .naive_local()
    }

    fn mgrs_from_latlng(lat: f64, lng: f64) -> String {
        Mgrs::from_latlon(&LatLon::create(lat, lng).expect("latlon"), 6)
            .to_string()
    }

    async fn clear_datasource_api_login(
        dbx: &DatabaseConnection,
        datasource_id: i64,
    ) {
        let mut datasource = datasource::Entity::find_by_id(datasource_id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        datasource.api_login = Set(None);
        datasource.update(dbx).await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn collect_report_1213_data_prefers_structured_sender_name_and_latest_coords(
    ) {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        let network_with_sender = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("ОГ Лёва 121 мсп 68 мсд 6 А".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_without_sender = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("1843 омсб 68 мсд 6 А".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            Some(&network_with_sender),
            "msg-yamal-1",
            "138.8150",
            test_dt(9, 6, 10),
            Some((48.0, 37.0)),
            None,
            Some("ЯМАЛ"),
            &["ЯМАЛ"],
        )
        .await
        .unwrap();
        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            Some(&network_with_sender),
            "msg-yamal-2",
            "138.8150",
            test_dt(9, 18, 0),
            None,
            None,
            Some("КРАСИВЫЙ"),
            &["КРАСИВЫЙ"],
        )
        .await
        .unwrap();
        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            Some(&network_with_sender),
            "msg-yamal-3",
            "138.8150",
            test_dt(9, 22, 29),
            Some((48.1, 37.1)),
            None,
            Some("ЯМАЛ"),
            &["ЯМАЛ"],
        )
        .await
        .unwrap();

        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            Some(&network_without_sender),
            "msg-unknown-1",
            "136.2350",
            test_dt(9, 1, 30),
            None,
            None,
            None,
            &["КИСАК"],
        )
        .await
        .unwrap();
        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            Some(&network_without_sender),
            "msg-unknown-2",
            "136.2350",
            test_dt(9, 20, 30),
            Some((48.05, 37.05)),
            None,
            None,
            &["СОЮЗ"],
        )
        .await
        .unwrap();

        let req = ReportPreviewReq {
            kind: "report_1213".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(8, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(10, 23, 59).and_utc().timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: None,
            report_1213_linked_networks_only: Some(true),
            without_comments: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
        };

        let logins = vec![login.login.clone()];
        let report_data = collect_report_1213_data(
            &env.dbx,
            &login.login,
            &logins,
            &env,
            &req,
        )
        .await
        .unwrap();

        assert_eq!(report_data.items.len(), 2);

        let rows = report_data
            .items
            .into_iter()
            .map(|item| (item.network_name.clone(), item))
            .collect::<BTreeMap<_, _>>();

        let row_with_sender = rows.get("ОГ Лёва 121 мсп 68 мсд 6 А").unwrap();
        assert_eq!(row_with_sender.nominal_working_freq, "138.8150");
        assert_eq!(row_with_sender.first_seen_at, reported_dt(9, 6, 10));
        assert_eq!(row_with_sender.last_seen_at, reported_dt(9, 22, 29));
        assert_eq!(row_with_sender.node_callsign.as_deref(), Some("ЯМАЛ"));
        assert_eq!(
            row_with_sender.source_mgrs,
            Some(mgrs_from_latlng(48.1, 37.1))
        );

        let row_without_sender = rows.get("1843 омсб 68 мсд 6 А").unwrap();
        assert_eq!(row_without_sender.nominal_working_freq, "136.2350");
        assert_eq!(row_without_sender.first_seen_at, reported_dt(9, 20, 30));
        assert_eq!(row_without_sender.last_seen_at, reported_dt(9, 20, 30));
        assert_eq!(row_without_sender.node_callsign, None);
        assert_eq!(
            row_without_sender.source_mgrs,
            Some(mgrs_from_latlng(48.05, 37.05))
        );
    }

    #[tokio::test]
    #[serial]
    async fn collect_report_1213_can_limit_to_datasources_of_users_organism() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("вБпЛА 1855 омсб 68 мсд 6 А".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let mut own_datasource =
            datasource::Entity::find_by_id(datasource_group.datasource_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        own_datasource.api_login = Set(Some(login.login.clone()));
        own_datasource.update(&env.dbx).await.unwrap();

        let outsider_organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set("outsider".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let outsider_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("outsider-report-1213".to_string()),
                organism_id: Set(Some(outsider_organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let outsider_datasource = mk_datasource(
            &env.dbx,
            datasource::ActiveModel {
                api_login: Set(Some(outsider_login.login.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let outsider_datasource_group = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(datasource_group
                    .group_master_key
                    .clone()),
                datasource_id: Set(outsider_datasource.id),
                name: Set("outsider-dsg".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            Some(&network),
            "msg-own",
            "139.2250",
            test_dt(9, 0, 6),
            Some((48.2, 37.2)),
            None,
            Some("ЗАЛИВ"),
            &["ЗАЛИВ"],
        )
        .await
        .unwrap();
        seed_report_1213_message(
            &env.dbx,
            &outsider_datasource_group,
            Some(&network),
            "msg-outsider",
            "139.2250",
            test_dt(9, 22, 41),
            Some((48.3, 37.3)),
            None,
            Some("ЧУЖИЙ"),
            &["ЧУЖИЙ"],
        )
        .await
        .unwrap();

        let req = ReportPreviewReq {
            kind: "report_1213".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(8, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(10, 23, 59).and_utc().timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: Some(true),
            report_1213_linked_networks_only: Some(true),
            without_comments: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
        };

        let logins = vec![login.login.clone()];
        let report_data = collect_report_1213_data(
            &env.dbx,
            &login.login,
            &logins,
            &env,
            &req,
        )
        .await
        .unwrap();

        assert_eq!(report_data.items.len(), 1);
        let row = report_data.items.first().unwrap();
        assert_eq!(row.network_name, "вБпЛА 1855 омсб 68 мсд 6 А");
        assert_eq!(row.first_seen_at, reported_dt(9, 0, 6));
        assert_eq!(row.last_seen_at, reported_dt(9, 0, 6));
        assert_eq!(row.node_callsign.as_deref(), Some("ЗАЛИВ"));
        assert_eq!(row.source_mgrs, Some(mgrs_from_latlng(48.2, 37.2)));

        clear_datasource_api_login(&env.dbx, datasource_group.datasource_id)
            .await;
        clear_datasource_api_login(&env.dbx, outsider_datasource.id).await;
    }

    #[tokio::test]
    #[serial]
    async fn collect_report_1213_can_include_fuzzy_unit_matches() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            None,
            "msg-fuzzy-unit",
            "138.6250",
            test_dt(9, 5, 14),
            Some((48.25, 37.25)),
            Some("121 мсп 68 мсд 6 А"),
            None,
            &["СИГМА"],
        )
        .await
        .unwrap();
        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            None,
            "msg-fuzzy-unknown",
            "139.2250",
            test_dt(9, 0, 6),
            Some((48.2, 37.2)),
            None,
            Some("ЗАЛИВ"),
            &["ЗАЛИВ"],
        )
        .await
        .unwrap();

        let req = ReportPreviewReq {
            kind: "report_1213".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(8, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(10, 23, 59).and_utc().timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: None,
            report_1213_linked_networks_only: Some(false),
            without_comments: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
        };

        let logins = vec![login.login.clone()];
        let report_data = collect_report_1213_data(
            &env.dbx,
            &login.login,
            &logins,
            &env,
            &req,
        )
        .await
        .unwrap();

        let rows = report_data
            .items
            .into_iter()
            .map(|item| (item.network_name.clone(), item))
            .collect::<BTreeMap<_, _>>();

        let fuzzy_row = rows.get("121 мсп 68 мсд 6 А").unwrap();
        assert_eq!(fuzzy_row.nominal_working_freq, "138.6250");
        assert_eq!(fuzzy_row.first_seen_at, reported_dt(9, 5, 14));
        assert_eq!(fuzzy_row.last_seen_at, reported_dt(9, 5, 14));
        assert_eq!(fuzzy_row.source_mgrs, Some(mgrs_from_latlng(48.25, 37.25)));

        let unknown_row = rows.get(REPORT_1213_UNKNOWN_TEXT).unwrap();
        assert_eq!(unknown_row.nominal_working_freq, "139.2250");
        assert_eq!(unknown_row.node_callsign.as_deref(), Some("ЗАЛИВ"));
        assert_eq!(unknown_row.source_mgrs, Some(mgrs_from_latlng(48.2, 37.2)));
    }

    #[tokio::test]
    #[serial]
    async fn collect_report_1213_can_exclude_fuzzy_unit_matches() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        seed_report_1213_message(
            &env.dbx,
            &datasource_group,
            None,
            "msg-fuzzy-unit",
            "138.6250",
            test_dt(9, 5, 14),
            Some((48.25, 37.25)),
            Some("121 мсп 68 мсд 6 А"),
            None,
            &["СИГМА"],
        )
        .await
        .unwrap();

        let req = ReportPreviewReq {
            kind: "report_1213".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(8, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(10, 23, 59).and_utc().timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: None,
            report_1213_linked_networks_only: Some(true),
            without_comments: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
        };

        let logins = vec![login.login.clone()];
        let report_data = collect_report_1213_data(
            &env.dbx,
            &login.login,
            &logins,
            &env,
            &req,
        )
        .await
        .unwrap();

        assert!(report_data.items.is_empty());
    }

    #[test]
    fn build_report_1213_docx_to_path_writes_nonempty_docx() {
        let tmp = NamedTempFile::new().unwrap();
        let report_data = Report1213Data {
            report_till_at: Some(
                DateTime::from_timestamp_millis(
                    test_dt(9, 22, 29).and_utc().timestamp_millis(),
                )
                .unwrap(),
            ),
            items: vec![Report1213Item {
                network_name: "ОГ Лёва 121 мсп 68 мсд 6 А".to_string(),
                nominal_working_freq: "138.8150".to_string(),
                first_seen_at: test_dt(9, 6, 10),
                last_seen_at: test_dt(9, 22, 29),
                node_callsign: Some("ЯМАЛ".to_string()),
                source_mgrs: Some("37UDR0123412345".to_string()),
            }],
        };

        build_report_1213_docx_to_path(&report_data, tmp.path()).unwrap();

        let bytes = std::fs::read(tmp.path()).unwrap();
        assert!(!bytes.is_empty());
        assert!(bytes.starts_with(b"PK"));
    }
}

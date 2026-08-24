use crate::config::{get_tz, ORGANISM_GOI_REPORT_XLSX_CREATION_DATE};
use crate::entities::*;
use crate::error::AppError;
use crate::organism::goi::aor_scope::goi_joined_aor_visible_for_organism;
use crate::sigint::aor::report_order;
use crate::types::*;
use chrono::prelude::*;
use rust_xlsxwriter::{DocProperties, ExcelDateTime, Workbook};
use sea_orm::{prelude::Expr, *};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

pub async fn report_xlsx_networks_goi(
    env: &Env,
    outpath: &PathBuf,
    organism_id: Option<i64>,
) -> Result<(), AppError> {
    let mut workbook =
        build_goi_report_workbook(env, organism_id).await.c(h!())?;
    workbook.save(outpath).context(h!())?;
    Ok(())
}

pub async fn report_xlsx_networks_goi_to_buffer(
    env: &Env,
    organism_id: Option<i64>,
) -> Result<Vec<u8>, AppError> {
    let mut workbook =
        build_goi_report_workbook(env, organism_id).await.c(h!())?;
    workbook
        .save_to_buffer()
        .context(h!())
        .map_err(AppError::from)
}

pub async fn login_organism_id(
    dbx: &DatabaseConnection,
    user_id: &uuid::Uuid,
) -> Result<Option<i64>, AppError> {
    Ok(login::Entity::find_by_id(*user_id)
        .one(dbx)
        .await
        .c(h!())?
        .and_then(|login| login.organism_id))
}

#[derive(FromQueryResult)]
struct NetworkFreq {
    network_freq_id: i64,
    network_aor_id: i64,
    aor_id: i64,
    freq: String,
    location: String,
    unit_name: Option<String>,
    created_at: NaiveDateTime,
    aor_name: String,
    aor_order: f64,
}

async fn build_goi_report_workbook(
    env: &Env,
    organism_id: Option<i64>,
) -> Result<Workbook, AppError> {
    let grouped = get_goi_report_freqs(env, organism_id).await.context(h!())?;
    let record_count = grouped.iter().fold(0_usize, |count, (_, freqs)| {
        count.saturating_add(freqs.len())
    });
    crate::report_history::ensure_report_record_count(record_count)?;
    let mut workbook = new_goi_report_workbook()?;

    let _enemy_sheet =
        workbook.add_worksheet().set_name("Противник").c(h!())?;
    let _trash_sheet =
        workbook.add_worksheet().set_name("Нечистоти🚾").c(h!())?;

    for (aor_name, freqs) in grouped {
        write_goi_report_sheet(&mut workbook, &aor_name, &freqs)?;
    }

    Ok(workbook)
}

fn new_goi_report_workbook() -> Result<Workbook, AppError> {
    let (year, month, day) = ORGANISM_GOI_REPORT_XLSX_CREATION_DATE;
    let creation_date = ExcelDateTime::from_ymd(year, month, day).c(h!())?;
    let properties = DocProperties::new().set_creation_datetime(&creation_date);
    let mut workbook = Workbook::new();
    workbook.set_properties(&properties);
    Ok(workbook)
}

fn write_goi_report_sheet(
    workbook: &mut Workbook,
    aor_name: &str,
    freqs: &[NetworkFreq],
) -> Result<(), AppError> {
    let safe_sheet_name = sanitize_sheet_name(aor_name);
    let worksheet = workbook
        .add_worksheet()
        .set_name(&safe_sheet_name)
        .c(h!())?;

    for (index, freq) in freqs.iter().enumerate() {
        let row = index as u32;
        worksheet.write_string(row, 0, &freq.freq).c(h!())?;
        worksheet.write_string(row, 1, &freq.location).c(h!())?;
        worksheet
            .write_string(
                row,
                2,
                freq.unit_name.as_deref().unwrap_or("в дорозвідці"),
            )
            .c(h!())?;
        worksheet
            .write_string(
                row,
                5,
                freq.created_at.and_utc().timestamp_millis().to_string(),
            )
            .c(h!())?;
    }

    worksheet.set_column_width(0, 15).c(h!())?;
    worksheet.set_column_width(1, 50).c(h!())?;
    worksheet.set_column_width(2, 50).c(h!())?;
    worksheet.set_column_width(5, 20).c(h!())?;
    Ok(())
}

async fn get_goi_report_freqs(
    env: &Env,
    organism_id: Option<i64>,
) -> Result<Vec<(String, Vec<NetworkFreq>)>, AppError> {
    let today = Utc::now().with_timezone(&get_tz()).date_naive();
    let today_start_local = today.and_hms_opt(0, 0, 0).unwrap_or_default();
    let today_start = get_tz()
        .from_local_datetime(&today_start_local)
        .single()
        .context(h!())?
        .with_timezone(&Utc)
        .naive_utc();
    let mut q = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .column_as(sigint_network_freq::Column::Id, "network_freq_id")
        .column_as(sigint_network_aor::Column::Id, "network_aor_id")
        .column_as(area_of_responsibility::Column::Id, "aor_id")
        .column(sigint_network_freq::Column::Freq)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_network::Column::Location)
        .column_as(area_of_responsibility::Column::Name, "aor_name")
        .column_as(
            area_of_responsibility::Column::OrderForReportLegacy,
            "aor_order",
        )
        .column(sigint_network_freq::Column::CreatedAt)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_network::Column::ActiveTo.is_null())
                .add(
                    Expr::col((
                        sigint_network::Entity,
                        sigint_network::Column::ActiveTo,
                    ))
                    .gte(Expr::val(today_start)),
                ),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_network_freq::Column::ActiveTo.is_null())
                .add(
                    Expr::col((
                        sigint_network_freq::Entity,
                        sigint_network_freq::Column::ActiveTo,
                    ))
                    .gt(Expr::val(today_start)),
                ),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .filter(area_of_responsibility::Column::IsDefault.eq(false))
        .filter(
            Condition::any()
                .add(sigint_unit::Column::Deleted.eq(false))
                .add(sigint_unit::Column::Deleted.is_null()),
        )
        .order_by_asc(sigint_network_aor::Column::Id)
        .order_by_asc(sigint_network_freq::Column::Id);

    if let Some(organism_id) = organism_id {
        q = q.filter(goi_joined_aor_visible_for_organism(organism_id));
    }

    // debug!(
    //     "GOI report SQL: {}",
    //     &q.build(DbBackend::Postgres).to_string()
    // );

    let mut freqs =
        q.into_model::<NetworkFreq>().all(&env.dbx).await.c(h!())?;
    let order_by_aor_id =
        report_order::effective_report_order_map(&env.dbx, organism_id)
            .await
            .c(h!())?;
    for freq in &mut freqs {
        if let Some(order_for_report) = order_by_aor_id.get(&freq.aor_id) {
            freq.aor_order = *order_for_report;
        }
    }
    let freqs = keep_first_network_aor_per_freq(freqs);

    let mut grouped: Vec<(String, Vec<NetworkFreq>)> = Vec::new();
    for freq in freqs {
        if let Some((aor_name, aor_freqs)) = grouped.last_mut() {
            if aor_name == &freq.aor_name {
                aor_freqs.push(freq);
                continue;
            }
        }
        grouped.push((freq.aor_name.clone(), vec![freq]));
    }

    Ok(grouped)
}

fn keep_first_network_aor_per_freq(
    freqs: Vec<NetworkFreq>,
) -> Vec<NetworkFreq> {
    let mut first_freq_rows =
        HashMap::<i64, (NetworkFreq, BTreeSet<String>)>::new();
    for freq in freqs {
        let network_freq_id = freq.network_freq_id;
        let unit_name = freq.unit_name.clone();
        match first_freq_rows.get_mut(&network_freq_id) {
            Some((current, unit_names)) => {
                add_unit_name(unit_names, unit_name);
                if current.network_aor_id > freq.network_aor_id {
                    *current = freq;
                }
            }
            None => {
                let mut unit_names = BTreeSet::new();
                add_unit_name(&mut unit_names, unit_name);
                first_freq_rows.insert(network_freq_id, (freq, unit_names));
            }
        }
    }

    let mut freqs = first_freq_rows
        .into_values()
        .map(|(mut freq, unit_names)| {
            freq.unit_name = (!unit_names.is_empty())
                .then(|| unit_names.into_iter().collect::<Vec<_>>().join(", "));
            freq
        })
        .collect::<Vec<_>>();
    freqs.sort_by(|left, right| {
        left.aor_order
            .total_cmp(&right.aor_order)
            .then_with(|| left.aor_name.cmp(&right.aor_name))
            .then_with(|| left.freq.cmp(&right.freq))
            .then_with(|| left.network_freq_id.cmp(&right.network_freq_id))
    });
    freqs
}

fn add_unit_name(unit_names: &mut BTreeSet<String>, unit_name: Option<String>) {
    if let Some(unit_name) =
        unit_name.map(|unit_name| unit_name.trim().to_string())
    {
        if !unit_name.is_empty() {
            unit_names.insert(unit_name);
        }
    }
}

/// Excel sheet names cannot contain certain characters or exceed 31 chars.
fn sanitize_sheet_name(name: &str) -> String {
    let mut clean = name
        .replace([':', '\\', '/', '?', '*', '[', ']'], "_")
        .trim()
        .to_string();
    if clean.len() > 31 {
        clean.truncate(31);
    }
    if clean.is_empty() {
        clean = "Unnamed".to_string();
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::{
        keep_first_network_aor_per_freq, new_goi_report_workbook, NetworkFreq,
    };
    use chrono::NaiveDate;

    fn test_freq(
        network_freq_id: i64,
        network_aor_id: i64,
        aor_name: &str,
        aor_order: f64,
        freq: &str,
        unit_name: Option<&str>,
    ) -> NetworkFreq {
        NetworkFreq {
            network_freq_id,
            network_aor_id,
            aor_id: network_aor_id,
            freq: freq.to_string(),
            location: "loc".to_string(),
            unit_name: unit_name.map(str::to_string),
            created_at: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            aor_name: aor_name.to_string(),
            aor_order,
        }
    }

    #[test]
    fn keep_first_network_aor_per_freq_uses_lowest_link_id() {
        let freqs = vec![
            test_freq(10, 20, "B", 2.0, "200", None),
            test_freq(10, 5, "A", 1.0, "200", None),
            test_freq(11, 7, "C", 3.0, "300", None),
        ];

        let rows = keep_first_network_aor_per_freq(freqs);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].network_freq_id, 10);
        assert_eq!(rows[0].network_aor_id, 5);
        assert_eq!(rows[0].aor_name, "A");
        assert_eq!(rows[1].network_freq_id, 11);
    }

    #[test]
    fn keep_first_network_aor_per_freq_collects_all_unit_names() {
        let freqs = vec![
            test_freq(10, 20, "B", 2.0, "200", Some("Unit B")),
            test_freq(10, 5, "A", 1.0, "200", Some("Unit C")),
            test_freq(10, 5, "A", 1.0, "200", Some("Unit A")),
            test_freq(11, 7, "C", 3.0, "300", None),
        ];

        let rows = keep_first_network_aor_per_freq(freqs);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].network_freq_id, 10);
        assert_eq!(rows[0].network_aor_id, 5);
        assert_eq!(rows[0].aor_name, "A");
        assert_eq!(
            rows[0].unit_name.as_deref(),
            Some("Unit A, Unit B, Unit C")
        );
        assert_eq!(rows[1].unit_name, None);
    }

    #[test]
    fn goi_report_workbook_bytes_are_deterministic() {
        let mut first = new_goi_report_workbook().expect("first workbook");
        first
            .add_worksheet()
            .write_string(0, 0, "same data")
            .expect("write first workbook");
        let first = first.save_to_buffer().expect("save first workbook");

        let mut second = new_goi_report_workbook().expect("second workbook");
        second
            .add_worksheet()
            .write_string(0, 0, "same data")
            .expect("write second workbook");
        let second = second.save_to_buffer().expect("save second workbook");

        assert_eq!(first, second);
    }
}

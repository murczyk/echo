use crate::config::get_tz;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_identity::Identity;
use chrono::prelude::*;
use rust_xlsxwriter::Workbook;
use sea_orm::{prelude::Expr, *};
use std::path::PathBuf;

pub async fn report_xlsx_networks_goi(
    _user: Identity,
    env: &Env,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let mut workbook = build_goi_report_workbook(env).await.c(h!())?;
    workbook.save(outpath).context(h!())?;
    Ok(())
}

pub async fn report_xlsx_networks_goi_to_buffer(
    env: &Env,
) -> Result<Vec<u8>, AppError> {
    let mut workbook = build_goi_report_workbook(env).await.c(h!())?;
    workbook
        .save_to_buffer()
        .context(h!())
        .map_err(AppError::from)
}

#[derive(FromQueryResult)]
struct NetworkFreq {
    freq: String,
    location: String,
    unit_name: Option<String>,
    created_at: NaiveDateTime,
    aor_name: String,
}

async fn build_goi_report_workbook(env: &Env) -> Result<Workbook, AppError> {
    let grouped = get_goi_report_freqs(env).await.context(h!())?;
    let mut workbook = Workbook::new();

    let _enemy_sheet =
        workbook.add_worksheet().set_name("Противник").c(h!())?;
    let _trash_sheet =
        workbook.add_worksheet().set_name("Нечистоти🚾").c(h!())?;

    for (aor_name, freqs) in grouped {
        write_goi_report_sheet(&mut workbook, &aor_name, &freqs)?;
    }

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
) -> Result<HashMap<String, Vec<NetworkFreq>>, AppError> {
    let today = Utc::now().with_timezone(&get_tz()).date_naive();
    let today_start_local = today.and_hms_opt(0, 0, 0).unwrap_or_default();
    let today_start = get_tz()
        .from_local_datetime(&today_start_local)
        .single()
        .context(h!())?
        .with_timezone(&Utc)
        .naive_utc();
    let q = sigint_network::Entity::find()
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
        .column(sigint_network_freq::Column::Freq)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_network::Column::Location)
        .column_as(area_of_responsibility::Column::Name, "aor_name")
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
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .filter(area_of_responsibility::Column::IsDefault.eq(false))
        .filter(
            Condition::any()
                .add(sigint_unit::Column::Deleted.eq(false))
                .add(sigint_unit::Column::Deleted.is_null()),
        )
        .order_by_asc(area_of_responsibility::Column::Name)
        .order_by_asc(sigint_network_freq::Column::Freq);

    // debug!(
    //     "GOI report SQL: {}",
    //     &q.build(DbBackend::Postgres).to_string()
    // );

    let freqs = q.into_model::<NetworkFreq>().all(&env.dbx).await.c(h!())?;

    let mut grouped: HashMap<String, Vec<NetworkFreq>> = HashMap::new();

    for f in freqs {
        grouped.entry(f.aor_name.clone()).or_default().push(f);
    }

    Ok(grouped)
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

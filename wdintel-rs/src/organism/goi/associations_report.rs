use crate::error::AppError;
use crate::h;
use crate::organism::goi::types::GoiAssociation;
use crate::types::ShortContext;
use anyhow::Context;
use chrono::DateTime;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook, Worksheet};

const HEADERS: [&str; 13] = [
    "ID ГОІ",
    "Дата в ГОІ",
    "Сервер",
    "Частота",
    "Координати",
    "Категорія",
    "Автор",
    "Позивні",
    "Підрозділ",
    "Кількість",
    "Висновок",
    "Оригінал повідомлення",
    "Імпортовано",
];

const COLUMN_WIDTHS: [f64; 13] = [
    12.0, 20.0, 24.0, 14.0, 24.0, 20.0, 18.0, 28.0, 28.0, 12.0, 50.0, 70.0,
    20.0,
];

pub(super) fn render_goi_associations_report(
    associations: &[GoiAssociation],
) -> Result<Vec<u8>, AppError> {
    crate::report_history::ensure_report_record_count(associations.len())
        .context(h!())?;
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet().set_name("Висновки").c(h!())?;
    let cell_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Top)
        .set_text_wrap();
    let header_format = cell_format
        .clone()
        .set_bold()
        .set_align(FormatAlign::Center);

    write_headers(worksheet, &header_format).c(h!())?;
    for (index, association) in associations.iter().enumerate() {
        let row = u32::try_from(index + 1).c(h!())?;
        write_association(worksheet, row, association, &cell_format).c(h!())?;
    }
    configure_worksheet(worksheet, associations.len()).c(h!())?;
    Ok(workbook.save_to_buffer().c(h!())?)
}

fn write_headers(
    worksheet: &mut Worksheet,
    header_format: &Format,
) -> Result<(), AppError> {
    for (column, header) in HEADERS.iter().enumerate() {
        worksheet
            .write_string_with_format(
                0,
                u16::try_from(column).c(h!())?,
                *header,
                header_format,
            )
            .c(h!())?;
    }
    Ok(())
}

fn write_association(
    worksheet: &mut Worksheet,
    row: u32,
    association: &GoiAssociation,
    cell_format: &Format,
) -> Result<(), AppError> {
    let values = [
        association.source_association_id.to_string(),
        format_date_time(association.source_created_at_ms),
        association.server_label.clone(),
        association.frequency.clone().unwrap_or_default(),
        association.coordinates.clone().unwrap_or_default(),
        association.category.clone().unwrap_or_default(),
        association.author.clone().unwrap_or_default(),
        association.call_signs.join(", "),
        association.formation.clone().unwrap_or_default(),
        association
            .association_count
            .map(|value| value.to_string())
            .unwrap_or_default(),
        association.note.clone().unwrap_or_default(),
        association.original_message.clone().unwrap_or_default(),
        format_date_time(association.created_at_ms),
    ];
    for (column, value) in values.iter().enumerate() {
        worksheet
            .write_string_with_format(
                row,
                u16::try_from(column).c(h!())?,
                value,
                cell_format,
            )
            .c(h!())?;
    }
    Ok(())
}

fn configure_worksheet(
    worksheet: &mut Worksheet,
    association_count: usize,
) -> Result<(), AppError> {
    for (column, width) in COLUMN_WIDTHS.iter().enumerate() {
        worksheet
            .set_column_width(u16::try_from(column).c(h!())?, *width)
            .c(h!())?;
    }
    worksheet.set_row_height(0, 30).c(h!())?;
    worksheet.set_freeze_panes(1, 0).c(h!())?;
    worksheet
        .autofilter(
            0,
            0,
            u32::try_from(association_count).c(h!())?,
            u16::try_from(HEADERS.len() - 1).c(h!())?,
        )
        .c(h!())?;
    Ok(())
}

fn format_date_time(value: i64) -> String {
    DateTime::from_timestamp_millis(value)
        .map(|value| {
            value
                .with_timezone(&chrono_tz::Europe::Kyiv)
                .format("%d.%m.%Y %H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}

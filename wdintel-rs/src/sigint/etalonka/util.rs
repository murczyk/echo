use crate::utils::*;
use docx_rs::*;

/// Add paragraph with a bold filed name and regular value pair.
pub fn add_field(
    doc: Docx,
    field_name: &str,
    value: &str,
    // numbering_id: usize,
) -> Docx {
    doc.add_paragraph(
        Paragraph::new()
            // .numbering(NumberingId::new(numbering_id), IndentLevel::new(0))
            .add_run(Run::new().add_text(field_name).bold())
            .add_run(Run::new().add_text(value)),
    )
}

/// generate style identifier by its name
pub fn gen_style_id_by_name(name: &str) -> String {
    format!("Style_{}", name.replace(" ", ""))
}

/// Creates and return paragraph Style with defined font name, size, bold and allignment
pub fn define_new_paragraph_style(
    name: &str,
    font_name: &str,
    font_size: usize,
    bold: bool,
    align: AlignmentType,
) -> Style {
    let style = Style::new(gen_style_id_by_name(name), StyleType::Paragraph)
        .name(name)
        .based_on("Normal")
        .next("Normal");

    let mut run_property = RunProperty::new()
        .fonts(RunFonts::new().ascii(font_name))
        .size(font_size);

    if bold {
        run_property = run_property.bold();
    }

    Style {
        run_property,
        paragraph_property: ParagraphProperty::new().align(align),
        ..style
    }
}

/// Create TableCell with text. Width, Style, filment, borders and grid_span number should be provided
pub fn create_table_header_cell(
    width: usize,
    fill: Option<&str>,
    style_id: &str,
    text: &str,
    with_empty_borders: bool,
    grid_span: usize,
) -> TableCell {
    let table_cell_borders = if with_empty_borders {
        TableCellBorders::with_empty()
    } else {
        TableCellBorders::new()
    };

    let mut cell = TableCell::new()
        .width(width, WidthType::Dxa)
        .add_paragraph(
            Paragraph::new()
                .style(style_id)
                .add_run(Run::new().add_text(text)),
        )
        .set_borders(table_cell_borders);

    if let Some(fill_color) = fill {
        cell = cell.shading(Shading::new().fill(fill_color));
    }

    if grid_span > 0 {
        cell = cell.grid_span(grid_span);
    }

    cell
}

/// Create TableCell with text. Width, borders and text color could be defined
pub fn create_table_data_cell(
    width: usize,
    text: &str,
    color: Option<String>,
    with_empty_borders: bool,
) -> TableCell {
    let table_cell_borders = if with_empty_borders {
        TableCellBorders::with_empty()
    } else {
        TableCellBorders::new()
    };

    TableCell::new()
        .width(width, WidthType::Dxa)
        .add_paragraph(paragraph_with_linebreaks(text, color.as_deref()))
        .set_borders(table_cell_borders)
}

pub fn format_datetime_field(dt_millis: Option<i64>) -> String {
    dt_millis
        .and_then(|millis| dt_from_millis(millis).ok())
        .map(|dt| dt.format("%d.%m.%Y %H:%M").to_string())
        .unwrap_or_default()
}

/// Convert text with line brakes into a Paragraph with TextWrapping breaks
pub fn paragraph_with_linebreaks(text: &str, color: Option<&str>) -> Paragraph {
    let mut paragraph = Paragraph::new();
    let lines: Vec<&str> = text.trim().split('\n').collect();

    for (i, line) in lines.iter().enumerate() {
        let mut run = Run::new().add_text(line.to_string());

        if let Some(c) = color {
            run = run.color(c);
        }

        paragraph = paragraph.add_run(run);

        if i < lines.len() - 1 {
            paragraph = paragraph
                .add_run(Run::new().add_break(BreakType::TextWrapping));
        }
    }

    paragraph
}

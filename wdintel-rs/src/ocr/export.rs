use crate::config::{
    OCR_EXPORT_MAX_CELLS, OCR_EXPORT_MAX_TABLES, OCR_EXPORT_MAX_TEXT_CHARS,
    OCR_MAX_RESULT_BYTES,
};
use crate::h;
use crate::ocr::package::{sanitize_html, sanitize_html_without_images};
use crate::types::ShortContext;
use docx_rs::{Docx, Paragraph, Run, Table, TableCell, TableRow};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use std::collections::HashSet;
use std::io::Cursor;

pub enum ExportFormat {
    Docx,
    Xlsx,
    Markdown,
    Html,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "docx" => Some(Self::Docx),
            "xlsx" => Some(Self::Xlsx),
            "md" => Some(Self::Markdown),
            "html" => Some(Self::Html),
            _ => None,
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Markdown => "md",
            Self::Html => "html",
        }
    }

    pub fn content_type(&self) -> &'static str {
        match self {
            Self::Docx => {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
            Self::Xlsx => {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            }
            Self::Markdown => "text/markdown; charset=utf-8",
            Self::Html => "text/html; charset=utf-8",
        }
    }
}

#[derive(Clone)]
enum Block {
    Heading(u8, String),
    Paragraph(String),
    ListItem(String),
    Table(usize),
}

#[derive(Clone)]
struct ExportCell {
    row: usize,
    column: usize,
    rowspan: usize,
    colspan: usize,
    header: bool,
    text: String,
}

#[derive(Clone, Default)]
struct ExportTable {
    caption: Option<String>,
    cells: Vec<ExportCell>,
    row_count: usize,
    column_count: usize,
}

#[derive(Default)]
struct ExportDocument {
    blocks: Vec<Block>,
    tables: Vec<ExportTable>,
    text_chars: usize,
    table_cells: usize,
}

pub fn generate(html: &str, format: ExportFormat) -> anyhow::Result<Vec<u8>> {
    let bytes = match format {
        ExportFormat::Html => {
            super::render_document(&sanitize_html(html)).into_bytes()
        }
        ExportFormat::Markdown => {
            markdown(&parse_export_document(html).c(h!())?).into_bytes()
        }
        ExportFormat::Docx => {
            docx(&parse_export_document(html).c(h!())?).c(h!())?
        }
        ExportFormat::Xlsx => {
            xlsx(&parse_export_document(html).c(h!())?).c(h!())?
        }
    };
    if u64::try_from(bytes.len()).c(h!())? > OCR_MAX_RESULT_BYTES {
        anyhow::bail!("OCR export exceeds the result size limit");
    }
    Ok(bytes)
}

fn parse_export_document(html: &str) -> anyhow::Result<ExportDocument> {
    parse_document(&sanitize_html_without_images(html)).c(h!())
}

fn parse_document(html: &str) -> anyhow::Result<ExportDocument> {
    let dom = tl::parse(html, tl::ParserOptions::default()).c(h!())?;
    let parser = dom.parser();
    let mut document = ExportDocument::default();
    for handle in dom.children() {
        if let Some(node) = handle.get(parser) {
            collect_blocks(node, parser, &mut document).c(h!())?;
        }
    }
    Ok(document)
}

fn collect_blocks(
    node: &tl::Node<'_>,
    parser: &tl::Parser<'_>,
    document: &mut ExportDocument,
) -> anyhow::Result<()> {
    let tl::Node::Tag(tag) = node else {
        return Ok(());
    };
    let name = tag.name().as_utf8_str();
    let name = name.as_ref();
    match name {
        "table" => {
            if document.tables.len() >= OCR_EXPORT_MAX_TABLES {
                anyhow::bail!("OCR export contains too many tables");
            }
            let table = parse_table(tag, parser).c(h!())?;
            document.table_cells = document
                .table_cells
                .checked_add(table.cells.len())
                .c(h!())?;
            if document.table_cells > OCR_EXPORT_MAX_CELLS {
                anyhow::bail!("OCR export contains too many table cells");
            }
            document.text_chars = document
                .text_chars
                .checked_add(
                    table
                        .cells
                        .iter()
                        .map(|cell| cell.text.chars().count())
                        .sum(),
                )
                .c(h!())?;
            let index = document.tables.len();
            document.tables.push(table);
            document.blocks.push(Block::Table(index));
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            push_text_block(
                document,
                normalize_text(&tag.inner_text(parser)),
                |text| Block::Heading(name[1..].parse().unwrap_or(1), text),
            )?;
        }
        "p" | "figcaption" => push_text_block(
            document,
            normalize_text(&tag.inner_text(parser)),
            Block::Paragraph,
        )?,
        "li" => push_text_block(
            document,
            normalize_text(&tag.inner_text(parser)),
            Block::ListItem,
        )?,
        _ => {
            for child in tag.children().all(parser) {
                collect_blocks(child, parser, document).c(h!())?;
            }
        }
    }
    if document.text_chars > OCR_EXPORT_MAX_TEXT_CHARS {
        anyhow::bail!("OCR export contains too much text");
    }
    Ok(())
}

fn push_text_block(
    document: &mut ExportDocument,
    text: String,
    block: impl FnOnce(String) -> Block,
) -> anyhow::Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    document.text_chars = document
        .text_chars
        .checked_add(text.chars().count())
        .c(h!())?;
    document.blocks.push(block(text));
    Ok(())
}

fn parse_table(
    table: &tl::HTMLTag<'_>,
    parser: &tl::Parser<'_>,
) -> anyhow::Result<ExportTable> {
    let caption = table
        .query_selector(parser, "caption")
        .and_then(|mut rows| rows.next())
        .and_then(|handle| handle.get(parser))
        .map(|node| normalize_text(&node.inner_text(parser)))
        .filter(|text| !text.is_empty());
    let mut result = ExportTable {
        caption,
        ..Default::default()
    };
    let rows = table.query_selector(parser, "tr").c(h!())?;
    let mut occupied = HashSet::new();
    for (row, handle) in rows.enumerate() {
        let node = handle.get(parser).c(h!())?;
        let tl::Node::Tag(row_tag) = node else {
            continue;
        };
        let mut column: usize = 0;
        for cell_node in row_tag.children().all(parser) {
            let tl::Node::Tag(cell_tag) = cell_node else {
                continue;
            };
            let cell_name = cell_tag.name().as_utf8_str();
            if !matches!(cell_name.as_ref(), "th" | "td") {
                continue;
            }
            while occupied.contains(&(row, column)) {
                column += 1;
            }
            let rowspan = span(cell_tag, "rowspan");
            let colspan = span(cell_tag, "colspan");
            let last_row = row.checked_add(rowspan).c(h!())?;
            let last_column = column.checked_add(colspan).c(h!())?;
            if last_row > 1_048_576 || last_column > 16_384 {
                anyhow::bail!("OCR table exceeds spreadsheet dimensions");
            }
            for occupied_row in row..last_row {
                for occupied_column in column..last_column {
                    occupied.insert((occupied_row, occupied_column));
                }
            }
            result.cells.push(ExportCell {
                row,
                column,
                rowspan,
                colspan,
                header: cell_name.as_ref() == "th",
                text: normalize_text(&cell_tag.inner_text(parser)),
            });
            if result.cells.len() > OCR_EXPORT_MAX_CELLS {
                anyhow::bail!("OCR export contains too many table cells");
            }
            result.row_count = result.row_count.max(last_row);
            result.column_count = result.column_count.max(last_column);
            column = last_column;
        }
    }
    Ok(result)
}

fn span(tag: &tl::HTMLTag<'_>, name: &str) -> usize {
    tag.attributes()
        .get(name)
        .flatten()
        .and_then(|value| value.as_utf8_str().parse().ok())
        .unwrap_or(1)
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn markdown(document: &ExportDocument) -> String {
    let mut output = String::new();
    for block in &document.blocks {
        match block {
            Block::Heading(level, text) => {
                output.push_str(&"#".repeat(usize::from(*level)));
                output.push(' ');
                output.push_str(&markdown_text(text));
                output.push_str("\n\n");
            }
            Block::Paragraph(text) => {
                output.push_str(&markdown_text(text));
                output.push_str("\n\n");
            }
            Block::ListItem(text) => {
                output.push_str("- ");
                output.push_str(&markdown_text(text));
                output.push('\n');
            }
            Block::Table(index) => {
                write_markdown_table(&mut output, &document.tables[*index])
            }
        }
    }
    output.trim_end().to_string() + "\n"
}

fn markdown_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\r', '\n'], " ")
}

fn write_markdown_table(output: &mut String, table: &ExportTable) {
    if let Some(caption) = &table.caption {
        output.push_str(&markdown_text(caption));
        output.push_str("\n\n");
    }
    let grid = table_grid(table);
    if grid.is_empty() || table.column_count == 0 {
        return;
    }
    write_markdown_row(output, &grid[0]);
    output.push('|');
    for _ in 0..table.column_count {
        output.push_str(" --- |");
    }
    output.push('\n');
    for row in grid.iter().skip(1) {
        write_markdown_row(output, row);
    }
    output.push('\n');
}

fn write_markdown_row(output: &mut String, row: &[String]) {
    output.push('|');
    for cell in row {
        output.push(' ');
        output.push_str(&markdown_text(cell));
        output.push_str(" |");
    }
    output.push('\n');
}

fn table_grid(table: &ExportTable) -> Vec<Vec<String>> {
    let mut grid =
        vec![vec![String::new(); table.column_count]; table.row_count];
    for cell in &table.cells {
        grid[cell.row][cell.column] = cell.text.clone();
    }
    grid
}

fn docx(document: &ExportDocument) -> anyhow::Result<Vec<u8>> {
    let mut result = Docx::new();
    for block in &document.blocks {
        result = match block {
            Block::Heading(level, text) => result.add_paragraph(
                Paragraph::new()
                    .style(&format!("Heading{level}"))
                    .add_run(Run::new().add_text(text)),
            ),
            Block::Paragraph(text) => result.add_paragraph(
                Paragraph::new().add_run(Run::new().add_text(text)),
            ),
            Block::ListItem(text) => result.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(format!("• {text}"))),
            ),
            Block::Table(index) => {
                result.add_table(docx_table(&document.tables[*index]))
            }
        };
    }
    let mut bytes = Vec::new();
    result.build().pack(Cursor::new(&mut bytes)).c(h!())?;
    Ok(bytes)
}

fn docx_table(table: &ExportTable) -> Table {
    let grid = table_grid(table);
    let header_positions = table
        .cells
        .iter()
        .filter(|cell| cell.header)
        .map(|cell| (cell.row, cell.column))
        .collect::<HashSet<_>>();
    let rows = grid
        .into_iter()
        .enumerate()
        .map(|(row, values)| {
            TableRow::new(
                values
                    .into_iter()
                    .enumerate()
                    .map(|(column, text)| {
                        let run = Run::new().add_text(text);
                        let run = if header_positions.contains(&(row, column)) {
                            run.bold()
                        } else {
                            run
                        };
                        TableCell::new()
                            .add_paragraph(Paragraph::new().add_run(run))
                    })
                    .collect(),
            )
        })
        .collect();
    Table::new(rows).set_grid(vec![2_000; table.column_count])
}

fn xlsx(document: &ExportDocument) -> anyhow::Result<Vec<u8>> {
    let mut workbook = Workbook::new();
    let cell_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_text_wrap()
        .set_align(FormatAlign::VerticalCenter);
    let header_format = cell_format.clone().set_bold();
    if document.tables.is_empty() {
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("OCR").c(h!())?;
        let text = document
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Heading(_, text)
                | Block::Paragraph(text)
                | Block::ListItem(text) => Some(text.as_str()),
                Block::Table(_) => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        worksheet.write_string(0, 0, &text).c(h!())?;
        worksheet.set_column_width(0, 80).c(h!())?;
    }
    for (index, table) in document.tables.iter().enumerate() {
        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name(format!("Таблиця {}", index + 1))
            .c(h!())?;
        for column in 0..table.column_count {
            worksheet
                .set_column_width(u16::try_from(column).c(h!())?, 18)
                .c(h!())?;
        }
        for cell in &table.cells {
            let row = u32::try_from(cell.row).c(h!())?;
            let column = u16::try_from(cell.column).c(h!())?;
            let format = if cell.header {
                &header_format
            } else {
                &cell_format
            };
            if cell.rowspan > 1 || cell.colspan > 1 {
                worksheet
                    .merge_range(
                        row,
                        column,
                        u32::try_from(cell.row + cell.rowspan - 1).c(h!())?,
                        u16::try_from(cell.column + cell.colspan - 1)
                            .c(h!())?,
                        &cell.text,
                        format,
                    )
                    .c(h!())?;
            } else {
                worksheet
                    .write_string_with_format(row, column, &cell.text, format)
                    .c(h!())?;
            }
        }
    }
    workbook.save_to_buffer().c(h!())
}

#[cfg(test)]
mod tests {
    use super::{generate, ExportFormat};
    use calamine::{Reader, Xlsx};
    use std::io::Cursor;
    use zip::ZipArchive;

    const HTML: &str = r#"<article><h1>Звіт</h1><p>Безпечний текст</p><script>alert(1)</script><table><tr><th>Назва</th><th>Значення</th></tr><tr><td rowspan="2">A</td><td>=HYPERLINK("javascript:alert(1)")</td></tr><tr><td>2</td></tr></table><table><tr><td>B</td></tr></table></article>"#;

    #[test]
    fn markdown_contains_only_sanitized_document_content() {
        let markdown =
            String::from_utf8(generate(HTML, ExportFormat::Markdown).unwrap())
                .unwrap();
        assert!(markdown.contains("# Звіт"));
        assert!(!markdown.contains("<script"));
        assert!(!markdown.contains("alert(1)</script>"));
    }

    #[test]
    fn xlsx_puts_each_table_on_its_own_sheet_and_writes_formulas_as_text() {
        let bytes = generate(HTML, ExportFormat::Xlsx).unwrap();
        let mut workbook = Xlsx::new(Cursor::new(bytes)).unwrap();
        assert_eq!(workbook.sheet_names(), &["Таблиця 1", "Таблиця 2"]);
        assert_eq!(
            workbook
                .worksheet_range("Таблиця 1")
                .unwrap()
                .get_value((1, 1))
                .unwrap()
                .to_string(),
            "=HYPERLINK(\"javascript:alert(1)\")"
        );
        assert!(workbook
            .worksheet_formula("Таблиця 1")
            .unwrap()
            .cells()
            .all(|(_, _, value)| value.is_empty()));
    }

    #[test]
    fn generated_docx_is_macro_free() {
        let bytes = generate(HTML, ExportFormat::Docx).unwrap();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(archive.by_name("word/document.xml").is_ok());
        assert!((0..archive.len()).all(|index| {
            !archive
                .by_index(index)
                .unwrap()
                .name()
                .to_ascii_lowercase()
                .contains("vbaproject")
        }));
    }

    #[test]
    fn html_export_has_csp_and_no_active_content() {
        let html =
            String::from_utf8(generate(HTML, ExportFormat::Html).unwrap())
                .unwrap();
        assert!(html.contains("Content-Security-Policy"));
        assert!(!html.contains("<script"));
    }
}

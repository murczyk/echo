use docx_rs::*;

pub struct DocxConfig {
    pub width_unit: usize,       // 1820
    pub highlight_color: String, // "FF0000"
}

pub enum ParagraphStyle {
    Default,
    Bold,
    Italic,
    BoldAndItalic,
}

pub fn mk_header_cell(text: &str, config: &DocxConfig) -> TableCell {
    TableCell::new()
        .width(config.width_unit * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        // .vertical_merge(VMergeType::Restart)
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(text).bold())
                .line_spacing(LineSpacing::new().before(80).after(80))
                .align(AlignmentType::Center),
        )
}

pub fn mk_text_cell(
    text: &str,
    style: ParagraphStyle,
    config: &DocxConfig,
) -> TableCell {
    mk_cell(config, mk_paragraph(text, style))
}

pub fn mk_cell(config: &DocxConfig, paragraph: Paragraph) -> TableCell {
    TableCell::new()
        .width(config.width_unit * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(paragraph)
}

pub fn mk_multiline_text_cell(
    lines: Vec<String>,
    config: &DocxConfig,
) -> TableCell {
    let mut cell = TableCell::new()
        .width(config.width_unit * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center);
    let mut remaining_count: i32 = lines.len() as i32;
    for text in lines {
        let mut separator_line_border =
            ParagraphBorder::new(ParagraphBorderPosition::Bottom);
        separator_line_border.val = BorderType::Single;
        let mut paragraph_borders_config = ParagraphBorders::with_empty();
        paragraph_borders_config =
            paragraph_borders_config.set(separator_line_border);
        remaining_count -= 1;
        let mut paragraph = Paragraph::new().add_run(Run::new().add_text(text));
        if remaining_count > 0 {
            paragraph.property = paragraph
                .property
                .set_borders(paragraph_borders_config.clone());
            paragraph.property = paragraph
                .property
                .line_spacing(LineSpacing::new().after(20));
        }
        cell = cell.add_paragraph(paragraph);
    }
    cell
}

pub fn mk_bullet_list_cell(
    lines: Vec<String>,
    config: &DocxConfig,
) -> TableCell {
    let mut cell = TableCell::new()
        .width(config.width_unit * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center);
    for text in lines {
        cell = cell.add_paragraph(mk_paragraph(
            &format!(" • {text}"),
            ParagraphStyle::Default,
        ));
    }
    cell
}

pub fn mk_paragraph(text: &str, style: ParagraphStyle) -> Paragraph {
    let text = Run::new().add_text(text);
    let text = match style {
        ParagraphStyle::Default => text,
        ParagraphStyle::Bold => text.bold(),
        ParagraphStyle::Italic => text.italic(),
        ParagraphStyle::BoldAndItalic => text.bold().italic(),
    };
    Paragraph::new()
        .add_run(text)
        .line_spacing(LineSpacing::new().before(80).after(80))
}

pub fn mk_merged_text_cell(
    text: &str,
    is_highlighted: bool,
    style: ParagraphStyle,
    config: &DocxConfig,
) -> TableCell {
    let mut text = mk_paragraph(text, style);
    if is_highlighted {
        text = text.color(&config.highlight_color);
    }
    TableCell::new()
        .width(config.width_unit * 2, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .vertical_merge(VMergeType::Restart)
        .add_paragraph(text.align(AlignmentType::Center))
        .grid_span(6)
}

pub fn mk_hyperlink(text: &str, link: &str) -> Paragraph {
    mk_paragraph(text, ParagraphStyle::Default)
        .add_hyperlink(Hyperlink::new(link, HyperlinkType::External))
}

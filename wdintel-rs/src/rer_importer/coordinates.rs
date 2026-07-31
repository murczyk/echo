use lazy_static::lazy_static;
use milgeo_rs::coordinates::Coords;
use regex::Regex;

pub fn body_noheader_for_inbox_coords(
    body: &str,
    meow_format: Option<&crate::rer_importer::meow_format::MeowFormat>,
) -> Result<
    crate::rer_importer::body_noheader::NoHeadersBody,
    crate::error::AppError,
> {
    // Regular meow messages need the meow body splitter because their time
    // header is not a generic body_noheader header.
    if crate::rer_importer::meow_format::parse_kraken_audio(body).is_none() {
        if let Some(meow_format) = meow_format {
            return Ok(meow_format.body_noheader.clone());
        }
    }

    crate::sigint::parser::extract_text_without_top_comment(body)
}

pub fn body_noheader_for_reprocess_coords(
    body: &str,
) -> Result<
    crate::rer_importer::body_noheader::NoHeadersBody,
    crate::error::AppError,
> {
    let lnow = chrono::Local::now().with_timezone(&crate::config::get_tz());
    let meow_format = crate::rer_importer::meow_format::parse(lnow, body);
    body_noheader_for_inbox_coords(body, meow_format.as_ref())
}

pub async fn extract_inbox_coords(
    body: &str,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> Vec<Coords> {
    if crate::rer_importer::zp_peleng_extended_format::parse(body).is_some() {
        return extract_coords(body).await;
    }

    // Do not scan the raw message as one blob because unit/network headers can
    // contain reference locations. Use the parsed body, extracted comments,
    // and standard coordinate metadata stripped by body_noheader.
    let body = prepare_inbox_body_for_coords(body, body_noheader);
    extract_coords(&body).await
}

pub async fn extract_coords(body: &str) -> Vec<Coords> {
    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_extended_format::parse(body)
    {
        return milgeo_rs::coordinates::rer_extract_coords(
            &zp_peleng.coordinate_text,
        )
        .await;
    }
    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_vorony_odina_format::parse(body)
    {
        return milgeo_rs::coordinates::rer_extract_coords(
            &zp_peleng.coordinate_text,
        )
        .await;
    }

    let body = prepare_body_for_coords(body);
    milgeo_rs::coordinates::rer_extract_coords(&body).await
}

fn prepare_inbox_body_for_coords(
    body: &str,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> String {
    let comments = crate::sigint::parser::parse_comments(body);
    let mut parts = comments.top.into_iter().collect::<Vec<_>>();
    parts.extend(comments.bottom);
    parts.extend(explicit_coordinate_lines(body));
    parts.extend(standard_coordinate_metadata_lines(body, body_noheader));
    let body_noheader = coordinate_body_text(body, body_noheader);
    if !body_noheader.trim().is_empty() {
        parts.push(body_noheader);
    }
    parts.join("\n")
}

fn explicit_coordinate_lines(body: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut parser = CoordinateMetadataParser::new(&[]);
    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if is_standalone_coordinate_value_line(line) {
            lines.push(line.to_string());
        } else {
            parser.accept_metadata_line(line);
        }
    }
    lines.extend(parser.into_lines());
    lines
}

fn standard_coordinate_metadata_lines(
    body: &str,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> Vec<String> {
    let lines = coordinate_input_lines(body, body_noheader);
    let mut parser = CoordinateMetadataParser::new(&lines);
    for input_line in lines {
        if input_line.is_body_line {
            continue;
        }
        let line = input_line.text.as_str();
        if crate::rer_importer::body_noheader::is_datetime_header_line(line) {
            parser.accept_datetime_header(line);
            continue;
        }
        if line.is_empty() {
            parser.accept_empty_line();
            continue;
        }
        parser.accept_line(line);
    }
    parser.into_lines()
}

struct CoordinateInputLine {
    text: String,
    is_body_line: bool,
}

struct OriginalLine {
    text: String,
    comparable_text: String,
    comparable_start: usize,
    comparable_end: usize,
}

fn coordinate_input_lines(
    body: &str,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> Vec<CoordinateInputLine> {
    let original_lines = original_lines(body);
    let body_line_flags = body_line_flags(&original_lines, body_noheader);

    original_lines
        .into_iter()
        .zip(body_line_flags)
        .map(|(line, is_body_line)| CoordinateInputLine {
            text: line.text.trim().to_string(),
            is_body_line,
        })
        .collect()
}

fn original_lines(body: &str) -> Vec<OriginalLine> {
    let mut lines = Vec::new();
    let mut line_start = 0;
    for raw_line in body.split_inclusive('\n') {
        let raw_line_len = raw_line.chars().count();
        let text = trim_line_end(raw_line);
        lines.push(original_line(text, line_start));
        line_start += raw_line_len;
    }
    lines
}

fn original_line(line: &str, line_start: usize) -> OriginalLine {
    if let Some(marker_start) = line.find("Отримано з пост") {
        let prefix = &line[..marker_start];
        let comparable_text = prefix.trim();
        let trim_start = prefix.find(comparable_text).unwrap_or(0);
        let comparable_start =
            line_start + prefix[..trim_start].chars().count();
        let comparable_end = comparable_start + comparable_text.chars().count();
        return OriginalLine {
            text: line.to_string(),
            comparable_text: comparable_text.to_string(),
            comparable_start,
            comparable_end,
        };
    }

    OriginalLine {
        text: line.to_string(),
        comparable_text: line.to_string(),
        comparable_start: line_start,
        comparable_end: line_start + line.chars().count(),
    }
}

fn body_line_flags(
    lines: &[OriginalLine],
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> Vec<bool> {
    let body_lines = body_noheader.body.lines().collect::<Vec<_>>();
    let mut flags = vec![false; lines.len()];
    let mut body_line_idx = 0;
    for (idx, line) in lines.iter().enumerate() {
        let Some(body_line) = body_lines.get(body_line_idx) else {
            break;
        };
        if !line_is_inside_body_noheader(line, body_noheader) {
            continue;
        }
        if line.comparable_text == *body_line {
            flags[idx] = true;
            body_line_idx += 1;
        }
    }
    flags
}

fn line_is_inside_body_noheader(
    line: &OriginalLine,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> bool {
    !body_noheader.body.is_empty()
        && line.comparable_start >= body_noheader.start
        && line.comparable_end <= body_noheader.end
}

fn coordinate_body_text(
    body: &str,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> String {
    let lines = original_lines(body);
    let body_line_flags = body_line_flags(&lines, body_noheader);

    lines
        .into_iter()
        .zip(body_line_flags)
        .filter_map(|(line, is_body_line)| {
            is_body_line.then_some(line.comparable_text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct CoordinateMetadataParser {
    has_datetime_header: bool,
    seen_datetime_header: bool,
    pre_datetime_state: PreDatetimeState,
    pending_pre_datetime_coordinate_lines: Vec<String>,
    pending_split_pre_datetime_coordinate_lines: Vec<String>,
    pending_split_coordinate: PendingSplitCoordinate,
    lines: Vec<String>,
}

impl CoordinateMetadataParser {
    fn new(lines: &[CoordinateInputLine]) -> Self {
        Self {
            has_datetime_header: has_metadata_datetime_header(lines),
            seen_datetime_header: false,
            pre_datetime_state: PreDatetimeState::Clean,
            pending_pre_datetime_coordinate_lines: Vec::new(),
            pending_split_pre_datetime_coordinate_lines: Vec::new(),
            pending_split_coordinate: PendingSplitCoordinate::default(),
            lines: Vec::new(),
        }
    }

    fn into_lines(self) -> Vec<String> {
        self.lines
    }

    fn accepts_metadata_lines(&self) -> bool {
        self.seen_datetime_header || !self.has_datetime_header
    }

    fn accept_datetime_header(&mut self, line: &str) {
        if !self.pre_datetime_state.is_unstructured()
            && is_buran_datetime_header_line(line)
        {
            self.push_pending_pre_datetime_coordinate_lines();
        }
        self.seen_datetime_header = true;
        self.pre_datetime_state = PreDatetimeState::Clean;
        self.pending_pre_datetime_coordinate_lines.clear();
        self.pending_split_pre_datetime_coordinate_lines.clear();
        self.pending_split_coordinate.reset();
    }

    fn accept_empty_line(&mut self) {
        if self.seen_datetime_header {
            return;
        }
        self.pre_datetime_state = PreDatetimeState::Clean;
        self.pending_split_coordinate.reset();
    }

    fn accept_line(&mut self, line: &str) {
        if self.accepts_metadata_lines() {
            self.accept_metadata_line(line);
        } else {
            self.accept_pre_datetime_line(line);
        }
    }

    fn accept_metadata_line(&mut self, line: &str) {
        if is_standard_coordinate_metadata_line(line) {
            self.pending_split_coordinate.reset();
            self.lines.push(line.to_string());
        } else if is_coordinate_label_marker_line(line) {
            self.pending_split_coordinate.start();
        } else {
            match self.pending_split_coordinate.accept_line(line) {
                SplitCoordinateResult::Complete(lines) => {
                    self.lines.extend(lines);
                }
                SplitCoordinateResult::Pending => {}
                SplitCoordinateResult::NotMatched => {}
            }
        }
    }

    fn accept_pre_datetime_line(&mut self, line: &str) {
        if is_coordinate_label_value_line(line) {
            self.pending_split_coordinate.reset();
            if self.pre_datetime_state.is_structured() {
                self.lines.push(line.to_string());
            } else if !self.pre_datetime_state.is_unstructured() {
                self.pending_pre_datetime_coordinate_lines
                    .push(line.to_string());
            }
        } else if is_coordinate_label_marker_line(line) {
            if self.pre_datetime_state.is_unstructured() {
                self.pending_split_coordinate.reset();
            } else {
                self.pending_split_coordinate.start();
            }
        } else {
            match self.pending_split_coordinate.accept_line(line) {
                SplitCoordinateResult::Complete(lines) => {
                    self.push_pre_datetime_coordinate_lines(lines);
                }
                SplitCoordinateResult::Pending => {}
                SplitCoordinateResult::NotMatched => {
                    self.accept_pre_datetime_non_coordinate_line(line);
                }
            }
        }
    }

    fn accept_pre_datetime_non_coordinate_line(&mut self, line: &str) {
        if is_structured_pre_datetime_header_line(line) {
            self.pre_datetime_state = PreDatetimeState::StructuredHeader;
            self.push_pending_pre_datetime_coordinate_lines();
        } else {
            self.pre_datetime_state = PreDatetimeState::UnstructuredLine;
            self.pending_pre_datetime_coordinate_lines.clear();
            self.pending_split_pre_datetime_coordinate_lines.clear();
        }
    }

    fn push_pending_pre_datetime_coordinate_lines(&mut self) {
        self.lines
            .append(&mut self.pending_pre_datetime_coordinate_lines);
        self.lines
            .append(&mut self.pending_split_pre_datetime_coordinate_lines);
        self.pending_split_coordinate.reset();
    }

    fn push_pre_datetime_coordinate_lines(&mut self, mut lines: Vec<String>) {
        if self.pre_datetime_state.is_structured() {
            self.lines.append(&mut lines);
        } else {
            self.pending_split_pre_datetime_coordinate_lines
                .append(&mut lines);
        }
    }
}

fn has_metadata_datetime_header(lines: &[CoordinateInputLine]) -> bool {
    let boundary = lines
        .iter()
        .position(|line| line.is_body_line)
        .or_else(|| lines.iter().position(|line| is_dialog_line(&line.text)))
        .unwrap_or(lines.len());

    lines[..boundary].iter().any(|line| {
        crate::rer_importer::body_noheader::is_datetime_header_line(&line.text)
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PreDatetimeState {
    Clean,
    StructuredHeader,
    UnstructuredLine,
}

impl PreDatetimeState {
    fn is_structured(self) -> bool {
        self == Self::StructuredHeader
    }

    fn is_unstructured(self) -> bool {
        self == Self::UnstructuredLine
    }
}

#[derive(Default)]
struct PendingSplitCoordinate {
    waiting_for_value: bool,
    single_decimal_coordinate_lines: Vec<String>,
    sk42_coordinate_lines: Vec<String>,
}

impl PendingSplitCoordinate {
    fn start(&mut self) {
        self.waiting_for_value = true;
        self.single_decimal_coordinate_lines.clear();
        self.sk42_coordinate_lines.clear();
    }

    fn reset(&mut self) {
        self.waiting_for_value = false;
        self.single_decimal_coordinate_lines.clear();
        self.sk42_coordinate_lines.clear();
    }

    fn accept_line(&mut self, line: &str) -> SplitCoordinateResult {
        if !self.waiting_for_value {
            return SplitCoordinateResult::NotMatched;
        }
        if is_standalone_coordinate_value_line(line) {
            self.reset();
            return SplitCoordinateResult::Complete(vec![line.to_string()]);
        }
        if is_single_decimal_coordinate_line(line) {
            self.single_decimal_coordinate_lines.push(line.to_string());
            if self.single_decimal_coordinate_lines.len() == 2 {
                self.waiting_for_value = false;
                return SplitCoordinateResult::Complete(std::mem::take(
                    &mut self.single_decimal_coordinate_lines,
                ));
            }
            return SplitCoordinateResult::Pending;
        }
        if !self.single_decimal_coordinate_lines.is_empty() {
            self.reset();
            return SplitCoordinateResult::NotMatched;
        }
        if let Some(result) = self.accept_sk42_line(line) {
            return result;
        }
        self.reset();
        SplitCoordinateResult::NotMatched
    }

    fn accept_sk42_line(
        &mut self,
        line: &str,
    ) -> Option<SplitCoordinateResult> {
        if is_sk42_x_coordinate_line(line)
            && self.sk42_coordinate_lines.is_empty()
        {
            self.sk42_coordinate_lines.push(line.to_string());
            return Some(SplitCoordinateResult::Pending);
        }
        if is_sk42_y_coordinate_line(line)
            && self.sk42_coordinate_lines.len() == 1
            && is_sk42_x_coordinate_line(&self.sk42_coordinate_lines[0])
        {
            self.sk42_coordinate_lines.push(line.to_string());
            self.waiting_for_value = false;
            return Some(SplitCoordinateResult::Complete(std::mem::take(
                &mut self.sk42_coordinate_lines,
            )));
        }
        None
    }
}

enum SplitCoordinateResult {
    Complete(Vec<String>),
    Pending,
    NotMatched,
}

fn trim_line_end(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn is_standard_coordinate_metadata_line(line: &str) -> bool {
    is_coordinate_label_value_line(line) || is_decimal_coords_only_line(line)
}

fn is_coordinate_label_value_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_COORDINATE_LABEL: Regex = Regex::new(
            r#"(?i)^\s*(?:координати|координаты|координата|coordinates?|coords?|mgrs|wgs(?:84)?)(?:\s*\([^)]*\))?\s*[:：]\s*\S"#
        )
        .unwrap();
    }

    RE_COORDINATE_LABEL.is_match(line)
}

fn is_coordinate_label_marker_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_COORDINATE_LABEL_MARKER: Regex = Regex::new(
            r#"(?i)^\s*(?:координати|координаты|координата|coordinates?|coords?|mgrs|wgs(?:84)?)(?:\s*\([^)]*\))?\s*[:：]\s*$"#
        )
        .unwrap();
    }

    RE_COORDINATE_LABEL_MARKER.is_match(line)
}

fn is_dialog_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_DIALOG_LINE: Regex =
            Regex::new(r#"^([—–―‒\-]|\d+\s*[\.\)\-:]|\d+\s+[—–―‒\-])"#)
                .unwrap();
    }

    RE_DIALOG_LINE.is_match(line.trim())
}

fn is_standalone_coordinate_value_line(line: &str) -> bool {
    is_decimal_coords_only_line(line) || is_mgrs_only_line(line)
}

fn is_mgrs_only_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_MGRS_ONLY: Regex = Regex::new(
            r#"(?i)^\s*\d{1,2}[C-HJ-NP-X]\s*[A-HJ-NP-Z]{2}(?:\s+\d{1,5}\s+\d{1,5}|\s*\d{2,10})\s*$"#
        )
        .unwrap();
    }

    RE_MGRS_ONLY.is_match(line)
}

fn is_single_decimal_coordinate_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_SINGLE_DECIMAL_COORD: Regex =
            Regex::new(r#"^\s*-?\d{1,3}[.,]\d{5,7}\s*$"#).unwrap();
    }

    RE_SINGLE_DECIMAL_COORD.is_match(line)
}

fn is_decimal_coords_only_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_DECIMAL_COORDS_ONLY: Regex = Regex::new(
            r#"^\s*-?\d{1,3}[.,]\d{5,7}\s*[, ]\s*-?\d{1,3}[.,]\d{5,7}\s*$"#
        )
        .unwrap();
    }

    RE_DECIMAL_COORDS_ONLY.is_match(line)
}

fn is_sk42_x_coordinate_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_SK42_X: Regex =
            Regex::new(r#"(?i)^\s*x\s*:\s*\d{2}-\d{5}\s*$"#).unwrap();
    }

    RE_SK42_X.is_match(line)
}

fn is_sk42_y_coordinate_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_SK42_Y: Regex =
            Regex::new(r#"(?i)^\s*y\s*:\s*\d{2}-\d{5}\s*$"#).unwrap();
    }

    RE_SK42_Y.is_match(line)
}

fn is_structured_pre_datetime_header_line(line: &str) -> bool {
    lazy_static! {
        static ref RE: Regex = Regex::new(
            r#"(?i)^\s*(?:район|частота|локація|локация|мережа|сеть|засічка|засечка|підрозділ|подразделение|хто|кому|абоненти|абоненты|позивні|позывные|пост|тип сигналу|тип сигнала|приналежність|принадлежность|мітки перехоплення|метки перехвата)\s*:"#
        )
        .unwrap();
    }
    RE.is_match(line)
}

fn is_buran_datetime_header_line(line: &str) -> bool {
    lazy_static! {
        static ref RE: Regex = Regex::new(r#"^(Дата|Час)\s*[: ]"#).unwrap();
    }
    RE.is_match(line)
}

fn prepare_body_for_coords(body: &str) -> String {
    let mut result = String::with_capacity(body.len());
    for line in body.lines() {
        if !is_non_coordinate_header_line(line) {
            result.push_str(line);
        }
        result.push('\n');
    }
    result
}

fn is_non_coordinate_header_line(line: &str) -> bool {
    if crate::rer_importer::callsigns::is_callsign_details_line(line) {
        return true;
    }
    if line_mentions_coordinates(line) {
        return false;
    }

    is_dmr_metadata_line(line)
        || is_callsign_map_line(line)
        || is_received_from_post_line(line)
}

fn line_mentions_coordinates(line: &str) -> bool {
    let line = line.to_lowercase();
    line.contains("координат")
        || line.contains("coordinate")
        || line.contains("coords")
        || line.contains("mgrs")
        || line.contains("wgs")
}

fn is_dmr_metadata_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_CC: Regex =
            Regex::new(r#"(?i)^\s*(?:[cс]{2}\s*:?\s*|код\s+кольору\s*:?\s*)"#)
                .unwrap();
        static ref RE_ID: Regex = Regex::new(
            r#"(?i)^\s*(?:[iі]d\s*➡️?|source\s+id|[iі]d\s+відправника|[iі]d)\s*:?\s+"#
        )
        .unwrap();
        static ref RE_CG: Regex = Regex::new(
            r#"(?i)^\s*(?:[iі]d\s*\(\s*[cс]g\s*\)\s*⬅️?|[iі]d\s*⬅️?(?:\s*\(\s*[cс]g\s*\))?|[iі]d\s+отримувача|group\s+id|код\s+групи|[cс]g)\s*:?\s+"#
        )
        .unwrap();
    }

    RE_CC.is_match(line) || RE_ID.is_match(line) || RE_CG.is_match(line)
}

fn is_callsign_map_line(line: &str) -> bool {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r#"(?i)^\s*(?:позивні|позывные|callsigns?)\s*:"#)
                .unwrap();
    }
    RE.is_match(line)
}

fn is_received_from_post_line(line: &str) -> bool {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r#"(?i)^\s*отримано\s+з\s+поста\s+"#).unwrap();
    }
    RE.is_match(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_headers_body_at(
        body: &str,
        body_noheader: &str,
    ) -> crate::rer_importer::body_noheader::NoHeadersBody {
        let start_byte = body.find(body_noheader).unwrap();
        let start = body[..start_byte].chars().count();
        let end = start + body_noheader.chars().count();
        crate::rer_importer::body_noheader::NoHeadersBody {
            body: body_noheader.to_string(),
            start,
            end,
        }
    }

    #[tokio::test]
    async fn extract_coords_ignores_sc_transcript_dmr_header_ids() {
        let body = r#"27.06.2026 19:15:21
Отримано з поста "SC1"
*152.365*
СС 13
ID➡️ 1098326, 5366440, 6350404, 287992, 3481020, 5291195, 7275810, 7121109, 3707804, 5267267, 775024
ID⬅️(CG) 1871040, 3106946, 2122380, 1139383, 443796, 3102387, 2626603, 4704746, 5243519, 1095394, 7494299
(УКХ р/м 352 мсп 47 тд 1 ТА (ПЕТРОПАВЛІВКА)🔑СС:13)

`152.365 | 1098326`
`19:15:21` — А да, плюс, плюс, я еще недели 3 назад докладывал.
"#;

        assert!(!milgeo_rs::coordinates::rer_extract_coords(body)
            .await
            .is_empty());
        assert!(extract_coords(body).await.is_empty());
    }

    #[tokio::test]
    async fn extract_coords_ignores_callsign_mgrs_details() {
        for details in [
            "КОСМОС (MGRS: 37TBN8304188110)\nДЮРАСЕЛ (MGRS: —)",
            "БУРЯТ (MGRS: 37TBN9194296930)\nТАДЖИК (MGRS: —)",
            "НВ (MGRS: 37TBN9224596386)\nНВ (MGRS: —)",
        ] {
            let body = format!(
                r#"Отримано з поста "ІНТЕРСЕПТОР Х"
--------------------------------------
29.07.2026, 16:27:27
146.0750
УКХ р/м 2 бмп 155 пмп 55 дмп (ЦВІТКОВЕ, ВЕРХНЯ ТЕРСА)
{details}

1 — Перевірка зв'язку."#
            );

            assert!(extract_coords(&body).await.is_empty());

            let body_noheader =
                body_noheader_for_reprocess_coords(&body).unwrap();
            assert!(extract_inbox_coords(&body, &body_noheader)
                .await
                .is_empty());
        }
    }

    #[tokio::test]
    async fn extract_coords_zp_peleng_vorony_odina_mgrs_format() {
        let body = "Пост Shark 4\n447.450   \nр-н. Шевченка   \n36T VS 89904 14667 \n01.07.2026 03:07:42";
        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36TVS8990414667");
    }

    #[tokio::test]
    async fn extract_coords_zp_peleng_vorony_odina_sk42_format() {
        let body = "Пост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert!(coords[0].capture.contains("x:51-29637"));
        assert!(coords[0].capture.contains("y:65-01850"));
    }

    #[tokio::test]
    async fn extract_coords_keeps_explicit_mgrs_coordinates() {
        let body = r#"Пост: КВАНТ
19:11:49   27.06.2026
143.545 - УКХ р/м НВ підрозділу
СС: 4
ID➡️: НВ
ID(CG)⬅️: НВ
Напрямок: Сх. Дворічна
Координати (MGRS): 37U DR 05997 22279
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UDR0599722279");
    }

    #[tokio::test]
    async fn extract_coords_keeps_report_125_bot_mgrs_coordinates() {
        let body = r#"16.07.2026 11:34:32
Назва: А-50 (А-50У) РЛС з РТК «Шмєль-М»;
Умовні координати для бота: MGRS 37U DR 32515 05505;
Кут: 79.6;
Частота: 3330;
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UDR3251505505");
    }

    #[tokio::test]
    async fn extract_coords_keeps_standalone_mgrs_after_dmr_headers() {
        let body = r#"27.06.2026 21:28:40 F=139.5660(МГц)
УКХ р/м 122 мсп 68 мсд 6 А 🔑 (ГОЛУБІВКА-КАЛИНОВЕ) СС: 1️⃣5️⃣ 📟📣 139.566
СС:15
ID➡️: 66044
ID(CG)⬅️: 34655

37U DR 01354 12034
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UDR0135412034");
    }

    #[tokio::test]
    async fn extract_coords_keeps_antenna_mgrs_coordinates() {
        let body = r#"Тип: Антена
Назва: 141.715 МГц
24.06.2026 17:32
Ворожий
Координати: 36U XB 66512 50880
Пост: 4431
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_coords_keeps_plain_decimal_coordinates() {
        let body = "145.5524\n47.392477\n36.056984\n10-11";

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_standard_coordinate_header() {
        let body = "01.07.2026, 02:55:19\n155.0250\nКоординати: 36U XB 66512 50880\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_crlf_standard_coordinate_header() {
        let body = "01.07.2026, 02:55:19\r\n155.0250\r\nКоординати: 36U XB 66512 50880\r\nУКХ р/м\r\n\r\nНВ\r\n— репліка";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        assert_eq!(body_noheader.body, "НВ\n— репліка");
        assert!(body_noheader.start > 0);

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_mgrs_coordinate_after_datetime() {
        let body = "01.07.2026, 02:55:19\n155.0250\nКоординати:\n36U XB 66512 50880\nУКХ р/м\n\n— репліка";
        let body_noheader = no_headers_body_at(body, "— репліка");

        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_decimal_coordinate_after_datetime(
    ) {
        let body = "01.07.2026, 02:55:19\n155.0250\nКоординати:\n47.392477\n36.056984\nУКХ р/м\n\n— репліка";
        let body_noheader = no_headers_body_at(body, "— репліка");

        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_inbox_coords_reprocess_keeps_standard_coordinate_header() {
        let body = "01.07.2026, 02:55:19\n155.0250\nКоординати: 36U XB 66512 50880\nУКХ р/м\n\n— репліка";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_buran_coordinate_before_datetime() {
        let body = r#"Частота: 442.585(МГц)
Локація: Новобахмутівка
Підрозділ: УКХ р/ м не визначеного підрозділу
Координати: 37U CP 97168 42114

Зміст:
1:
2:


Дата 20.02.2025
Час 16:16:48"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_first_buran_coordinate_before_datetime()
    {
        let body = r#"Координати: 37U CP 97168 42114
Частота: 442.585(МГц)
Підрозділ: УКХ р/ м не визначеного підрозділу
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_only_inline_buran_coordinate_before_datetime(
    ) {
        let body = r#"Координати: 37U CP 97168 42114
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_inline_buran_coordinate_before_blank_datetime(
    ) {
        let body = r#"Координати: 37U CP 97168 42114

Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_buran_coordinate_before_datetime()
    {
        let body = r#"Координати:
37U CP 97168 42114
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_buran_coordinate_before_blank_datetime(
    ) {
        let body = r#"Координати:
37U CP 97168 42114

Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_decimal_coordinate_before_datetime(
    ) {
        let body = r#"Координати:
47.392477
36.056984
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_sk42_coordinate_before_datetime()
    {
        let body = r#"Координати:
x:51-29637
y:65-01850
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert!(coords[0].capture.contains("x:51-29637"));
        assert!(coords[0].capture.contains("y:65-01850"));
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_coordinate_top_comment_before_generic_datetime(
    ) {
        let body = r#"Координати:
37U CP 97168 42114
01.07.2026, 02:55:19
155.0250
УКХ р/м

— репліка"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_labeled_coordinate_top_comment_before_structured_header(
    ) {
        let body = r#"Координати: 37U CP 97168 42114
операторська примітка
Частота: 442.585(МГц)
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_coordinate_comment_marker_before_datetime(
    ) {
        let body = r#"Коментар:
Координати:
37U CP 97168 42114
Дата 20.02.2025
Час 16:16:48

Зміст:
1:
2:"#;
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UCP9716842114");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_top_comment_coordinates() {
        let body = "36T VS 89904 14667\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36TVS8990414667");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_top_comment_decimal_coordinates() {
        let body = "47.392477, 36.056984\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_top_comment_labeled_coordinates() {
        for coordinate_line in
            ["Координати: 36U XB 66512 50880", "MGRS: 36U XB 66512 50880"]
        {
            let body = format!(
                "{coordinate_line}\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка"
            );
            let body_noheader =
                crate::sigint::parser::extract_text_without_top_comment(&body)
                    .unwrap();

            assert_eq!(body_noheader.body, "— репліка");
            let coords = extract_inbox_coords(&body, &body_noheader).await;
            assert_eq!(coords.len(), 1, "{coordinate_line}");
            assert_eq!(coords[0].mgrs, "36UXB6651250880");
        }
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_comment_marker_labeled_coordinates() {
        let body = "Коментар:\nКоординати: 36U XB 66512 50880\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_mid_body_comment_coordinates() {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— перша репліка\nКоментар:\nКоординати: 36U XB 66512 50880\n— друга репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(body_noheader.body.contains("— перша репліка"));
        assert!(body_noheader.body.contains("— друга репліка"));
        assert!(!body_noheader.body.contains("Координати"));

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_footer_comment_labeled_coordinates() {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка\n\nКоментар: примітка\nКоординати: 36U XB 66512 50880";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert!(body_noheader.body.contains("— репліка"));
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_structured_post_footer_peleng() {
        let body = r#"Отримано з поста "Malva 4.0"
--------------------------------------
30.07.2026, 08:51:09
442.4150
ЦПФ70 УКХ р/м 2 мінбатр 2 кулб 69 обрп (Зх.околиці н.п.Воскресенка)
НВ
НВ
— Пеленг позиції.
Коментар: пеленг позицій
37T CP 20036 12147"#;
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        let coords = extract_inbox_coords(body, &body_noheader).await;

        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37TCP2003612147");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_unmarked_footer_coordinates() {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка\n\nКоординати: 36U XB 66512 50880";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_empty_body_footer_comment_coordinates()
    {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\nКоментар: примітка\nКоординати: 36U XB 66512 50880";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert!(body_noheader.body.is_empty());
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_decimal_coords_after_spaced_time_date()
    {
        let body = "16:41  25.02.2026\n139.450\n47.392477, 36.056984\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_decimal_coords_without_datetime_header()
    {
        let body = "139.450\n47.392477, 36.056984\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_labeled_coords_without_datetime_header()
    {
        let body =
            "139.450\nКоординати: 36U XB 66512 50880\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert_eq!(body_noheader.body, "— репліка");

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_body_datetime_for_header_detection() {
        let body = "139.450\nКоординати: 36U XB 66512 50880\nУКХ р/м\n\n— репліка\n01.07.2026, 02:55:19";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_kraken_preamble_comment_coordinates() {
        let body =
            "36T VS 89904 14667\n audio | 2026-07-01_14-47-03\nПерехоплення";
        let kraken_audio =
            crate::rer_importer::meow_format::parse_kraken_audio(body).unwrap();

        assert!(kraken_audio.body_noheader.body.contains("36T VS"));

        let body_noheader =
            body_noheader_for_inbox_coords(body, Some(&kraken_audio)).unwrap();
        assert_eq!(body_noheader.body, "Перехоплення");
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36TVS8990414667");
    }

    #[test]
    fn body_noheader_for_reprocess_coords_keeps_regular_meow_body() {
        let body =
            "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення\nрядок 2";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        assert_eq!(body_noheader.body, "Перехоплення\nрядок 2");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_meow_footer_comment_coordinates() {
        let body = "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення\n\nКоментар: примітка\nКоординати: 36U XB 66512 50880";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        assert!(body_noheader.body.contains("Координати"));
        assert!(!extract_coords(&body_noheader.body).await.is_empty());
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_bare_coordinate_comment_continuation() {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\nКоментар:\n36U XB 66512 50880\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert!(body_noheader.body.contains("36U XB 66512 50880"));
        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_keeps_split_header_coordinate_repeated_in_comment(
    ) {
        let body = "01.07.2026, 02:55:19\n155.0250\nКоординати:\n36U XB 66512 50880\nУКХ р/м\n\nКоментар:\n36U XB 66512 50880\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        let coords = extract_inbox_coords(body, &body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_unit_description_coordinates() {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м 123 мсп 36U XB 66512 50880\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert_eq!(body_noheader.body, "— репліка");
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
    }

    #[tokio::test]
    async fn extract_coords_keeps_echo_zp2_xy_footer_after_header_stripping() {
        let body = r#"27.06.2026, 07:25:53
403.4250
УКХ р/м НВ підрозділу, р-н н.п. Пшеничне, 403.425 (МГц) ЦФП62
1-НВ
2-ГРАЧ

1— Грач притормози, на западе стреляют
2— Да, принял.
1— Грач, давай.
2— Грач да.


x:52-49185
y:67-14255"#;

        let body_noheader =
            crate::rer_importer::body_noheader::extract_text(body)
                .unwrap()
                .body;
        assert!(body_noheader.contains("x:52-49185"));
        assert!(body_noheader.contains("y:67-14255"));

        let coords = extract_coords(&body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert!(coords[0].capture.contains("x:52-49185"));
        assert!(coords[0].capture.contains("y:67-14255"));
    }
}

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
    // Coordinate extraction has its own input rules: comments are not pelengs,
    // but regular meow messages need the meow body splitter because their time
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
    // Do not scan the raw message as one blob: operator comments and
    // unit/network headers often contain reference locations that must not
    // create pelengs. Use the parsed body, then add back only standard
    // coordinate metadata rows stripped by body_noheader for display/search.
    let body = prepare_inbox_body_for_coords(body, body_noheader);
    extract_coords(&body).await
}

pub async fn extract_coords(body: &str) -> Vec<Coords> {
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
    let mut parts = standard_coordinate_metadata_lines(body, body_noheader);
    let body_noheader = strip_marker_comment_blocks(&body_noheader.body);
    if !body_noheader.trim().is_empty() {
        parts.push(body_noheader);
    }
    parts.join("\n")
}

fn standard_coordinate_metadata_lines(
    body: &str,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> Vec<String> {
    let mut parser = CoordinateMetadataParser::new(body);
    let mut skip_comment_metadata = false;
    let mut line_start = 0;
    for raw_line in body.split_inclusive('\n') {
        let line = trim_line_end(raw_line).trim();
        if crate::rer_importer::body_noheader::is_datetime_header_line(line) {
            parser.accept_datetime_header(line);
            skip_comment_metadata = false;
            line_start += raw_line.chars().count();
            continue;
        }
        if line.is_empty() {
            parser.accept_empty_line();
            skip_comment_metadata = false;
            line_start += raw_line.chars().count();
            continue;
        }
        let after_body_noheader =
            is_after_body_noheader(line_start, body_noheader);
        if body_noheader
            .body
            .lines()
            .any(|body_line| body_line.trim() == line)
        {
            line_start += raw_line.chars().count();
            continue;
        }
        if skip_comment_metadata && !is_dialog_line(line) {
            line_start += raw_line.chars().count();
            continue;
        }
        if skip_comment_metadata {
            skip_comment_metadata = false;
        }
        if (body_noheader.body.trim().is_empty() || after_body_noheader)
            && parser.accepts_metadata_lines()
            && is_comment_marker_line(line)
        {
            skip_comment_metadata = true;
            line_start += raw_line.chars().count();
            continue;
        }
        parser.accept_line(line);
        line_start += raw_line.chars().count();
    }
    parser.into_lines()
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
    fn new(body: &str) -> Self {
        Self {
            has_datetime_header: body.lines().map(str::trim).any(
                crate::rer_importer::body_noheader::is_datetime_header_line,
            ),
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
}

impl PendingSplitCoordinate {
    fn start(&mut self) {
        self.waiting_for_value = true;
        self.single_decimal_coordinate_lines.clear();
    }

    fn reset(&mut self) {
        self.waiting_for_value = false;
        self.single_decimal_coordinate_lines.clear();
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
        self.reset();
        SplitCoordinateResult::NotMatched
    }
}

enum SplitCoordinateResult {
    Complete(Vec<String>),
    Pending,
    NotMatched,
}

fn strip_marker_comment_blocks(body: &str) -> String {
    let mut lines = Vec::new();
    let mut skip_comment_block = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if is_comment_marker_line(trimmed) {
            skip_comment_block = true;
            continue;
        }
        if skip_comment_block {
            if trimmed.is_empty() || is_dialog_line(trimmed) {
                skip_comment_block = false;
                lines.push(line.to_string());
            }
            continue;
        }
        lines.push(line.to_string());
    }
    lines.join("\n")
}

fn trim_line_end(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn is_after_body_noheader(
    line_start: usize,
    body_noheader: &crate::rer_importer::body_noheader::NoHeadersBody,
) -> bool {
    !body_noheader.body.trim().is_empty() && line_start >= body_noheader.end
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

fn is_comment_marker_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_COMMENT_MARKER: Regex = Regex::new(
            r#"(?i)^\s*(?:коментар|коментарій|комментарий|комментар|comment)\s*[:\-—]"#
        )
        .unwrap();
    }

    RE_COMMENT_MARKER.is_match(line)
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
    async fn extract_inbox_coords_ignores_split_coordinate_top_comment_before_generic_datetime(
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
        assert!(coords.is_empty());
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_labeled_coordinate_top_comment_before_structured_header(
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
        assert!(coords.is_empty());
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_split_coordinate_comment_marker_before_datetime(
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
        assert!(coords.is_empty());
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_top_comment_coordinates() {
        let body = "36T VS 89904 14667\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_top_comment_decimal_coordinates() {
        let body = "47.392477, 36.056984\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_top_comment_labeled_coordinates() {
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
            assert!(
                extract_inbox_coords(&body, &body_noheader).await.is_empty(),
                "{coordinate_line}"
            );
        }
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_comment_marker_labeled_coordinates() {
        let body = "Коментар:\nКоординати: 36U XB 66512 50880\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert_eq!(body_noheader.body, "— репліка");
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_footer_comment_labeled_coordinates() {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка\n\nКоментар: примітка\nКоординати: 36U XB 66512 50880";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert!(body_noheader.body.contains("— репліка"));
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
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
    async fn extract_inbox_coords_ignores_empty_body_footer_comment_coordinates(
    ) {
        let body = "01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\nКоментар: примітка\nКоординати: 36U XB 66512 50880";
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(body)
                .unwrap();

        assert!(!extract_coords(body).await.is_empty());
        assert!(body_noheader.body.is_empty());
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
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
    async fn extract_inbox_coords_ignores_kraken_preamble_comment() {
        let body =
            "36T VS 89904 14667\n audio | 2026-07-01_14-47-03\nПерехоплення";
        let kraken_audio =
            crate::rer_importer::meow_format::parse_kraken_audio(body).unwrap();

        assert!(kraken_audio.body_noheader.body.contains("36T VS"));

        let body_noheader =
            body_noheader_for_inbox_coords(body, Some(&kraken_audio)).unwrap();
        assert_eq!(body_noheader.body, "Перехоплення");
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
    }

    #[test]
    fn body_noheader_for_reprocess_coords_keeps_regular_meow_body() {
        let body =
            "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення\nрядок 2";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        assert_eq!(body_noheader.body, "Перехоплення\nрядок 2");
    }

    #[tokio::test]
    async fn extract_inbox_coords_ignores_meow_footer_comment_coordinates() {
        let body = "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення\n\nКоментар: примітка\nКоординати: 36U XB 66512 50880";
        let body_noheader = body_noheader_for_reprocess_coords(body).unwrap();

        assert!(body_noheader.body.contains("Координати"));
        assert!(!extract_coords(&body_noheader.body).await.is_empty());
        assert!(extract_inbox_coords(body, &body_noheader).await.is_empty());
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

use crate::rer_importer::body_noheader::{
    is_datetime_header_line, is_header_line,
};
use lazy_static::lazy_static;
use regex::Regex;

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct ParsedComments {
    pub top: Option<String>,
    pub bottom: Option<String>,
}

impl ParsedComments {
    pub fn is_empty(&self) -> bool {
        self.top.is_none() && self.bottom.is_none()
    }
}

lazy_static! {
    static ref COMMENT_MARKER: Regex = Regex::new(
        r"^(?:Коментар|Коментарій|Комментарий|Комментар|Comment)\s*[:\-—]\s*(?P<rest>.*)$"
    )
    .unwrap();

    static ref DIALOG_LINE: Regex = Regex::new(
        r"^([—–―‒\-]|\d+\s*[\.\)\-:]|\d+\s+[—–―‒\-])"
    )
    .unwrap();

    static ref COORDS_ONLY: Regex = Regex::new(
        r"^-?\d{1,3}[.,]\d+\s*[, ]\s*-?\d{1,3}[.,]\d+\s*$"
    )
    .unwrap();
}

fn is_dialog_line(line: &str) -> bool {
    DIALOG_LINE.is_match(line.trim())
}

fn clean(text: &str) -> String {
    let mut t = text.trim().to_string();
    loop {
        let before = t.len();
        while t.ends_with(';') || t.ends_with('.') {
            t = t[..t.len() - 1].trim_end().to_string();
        }
        for (open, close) in [('"', '"'), ('«', '»'), ('(', ')')] {
            if t.starts_with(open)
                && t.ends_with(close)
                && t.chars().count() > 1
            {
                t = t[open.len_utf8()..t.len() - close.len_utf8()]
                    .trim()
                    .to_string();
            }
        }
        if t.len() == before {
            break;
        }
    }
    t
}

fn join_block(lines: &[&str]) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut blank_run = false;
    for l in lines {
        let l = l.trim();
        if l.is_empty() {
            if !out.is_empty() {
                blank_run = true;
            }
            continue;
        }
        if blank_run {
            out.push(String::new());
            blank_run = false;
        }
        out.push(l.to_string());
    }
    if out.is_empty() {
        return None;
    }
    let joined = clean(&out.join("\n"));
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

pub fn parse_comments(body: &str) -> ParsedComments {
    let lines: Vec<&str> = body.lines().collect();

    let marker_bottom = scan_marker_comment(&lines);

    let anchor = lines.iter().position(|l| is_datetime_header_line(l));

    let top = anchor.and_then(|a| parse_top(&lines[..a]));
    let bottom = marker_bottom
        .or_else(|| anchor.and_then(|a| parse_tail_comment(&lines[a..])));

    ParsedComments { top, bottom }
}

fn scan_marker_comment(lines: &[&str]) -> Option<String> {
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = COMMENT_MARKER.captures(line.trim()) {
            let mut block: Vec<&str> = Vec::new();
            let rest = caps.name("rest").map(|m| m.as_str()).unwrap_or("");
            if !rest.trim().is_empty() {
                block.push(rest);
            }
            for l in &lines[i + 1..] {
                if is_marker_comment_boundary(l) {
                    break;
                }
                block.push(l);
            }
            if let Some(c) = join_block(&block) {
                return Some(c);
            }
        }
    }
    None
}

fn is_marker_comment_boundary(line: &str) -> bool {
    let line = line.trim();
    line.is_empty()
        || is_header_line(line)
        || is_datetime_header_line(line)
        || is_dialog_line(line)
}

fn parse_top(pre: &[&str]) -> Option<String> {
    let kept: Vec<&str> =
        pre.iter().filter(|l| !is_header_line(l)).copied().collect();
    join_block(&kept)
}

fn parse_tail_comment(post: &[&str]) -> Option<String> {
    let mut idx = 0;
    while idx < post.len() && !post[idx].trim().is_empty() {
        idx += 1;
    }
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for l in &post[idx..] {
        if l.trim().is_empty() {
            if !cur.is_empty() {
                blocks.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(l);
        }
    }
    if !cur.is_empty() {
        blocks.push(cur);
    }
    if blocks.len() < 2 {
        return None;
    }

    let last_dialog = blocks
        .iter()
        .rposition(|b| b.iter().any(|l| is_dialog_line(l)))?;
    let tail = &blocks[last_dialog + 1..];
    if tail.is_empty() {
        return None;
    }
    let candidate: Vec<&str> = tail.concat();
    let is_comment = !candidate.iter().any(|l| {
        is_dialog_line(l)
            || is_header_line(l)
            || is_datetime_header_line(l)
            || COORDS_ONLY.is_match(l.trim())
    });
    if !is_comment {
        return None;
    }
    join_block(&candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Variant 1: top comment ─────────────────────────────────────

    #[test]
    fn top_single_line() {
        let body = "Запит на зв'язок між підрозділами\n\n24.07.2025, 08:05:21\n149.7300\nУКХ р/м 60 омсб\nТРАКТОР\nНВ\n\n— Депутат, Депутат Трактору.\n— Да, все живы.";
        let res = parse_comments(body);
        assert_eq!(
            res.top.as_deref(),
            Some("Запит на зв'язок між підрозділами")
        );
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_multiline() {
        let body = "Перша строка комментарія\nдруга строка\n\n13.11, 21:37:12\n446.0375\nУКХ НВ\nНВ\n\n— текст діалогу";
        let res = parse_comments(body);
        assert_eq!(
            res.top.as_deref(),
            Some("Перша строка комментарія\nдруга строка")
        );
    }

    #[test]
    fn top_ignores_otrymano_and_divider() {
        let body = "Отримано з поста \".\"\n--------------------------------------\n20.11.2025, 12:29:18\n157.8750\nУКХ р/м НВ\nНВ\nНВ\n\n— Первый раунд 4, Шапка 1.";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_with_otrymano_then_real_comment() {
        let body = "Отримано з поста \"Альфа\"\n--------------------\nважливий коментар оператора\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("важливий коментар оператора"));
    }

    // ── Variant 2: bottom comment ──────────────────────────────────────

    #[test]
    fn bottom_plain_block() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ р/м 60 омсб\nТРАКТОР\nНВ\n\n— Депутат, Депутат Трактору.\n— Да, все живы, машине пизда.\n\nпротивник готує наступ";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom.as_deref(), Some("противник готує наступ"));
    }

    #[test]
    fn bottom_explicit_marker() {
        let body = "20.11.2025, 16:53:04\n446.000\nУКХ ймовірно, 344 мсп\nНВ\nНВ\n\n– Да, давай синьки.\n\nКоментар: T2";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("T2"));
    }

    #[test]
    fn bottom_parenthesized() {
        let body = "13.11, 19:15:00\n455.2750\nУКХ радіомережа\n\n- Я говорю коробочку запустили?\n- Надо\n- Плюс\n\n(запит чи треба відвозити о/с)";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("запит чи треба відвозити о/с"));
    }

    #[test]
    fn bottom_marker_multiline() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу\n\nКоментар: перший рядок\nдругий рядок";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("перший рядок\nдругий рядок"));
    }

    #[test]
    fn yyyy_mm_dd_comma_time_is_anchor() {
        let body = "2025-03-08, 10:20\n422.500\nЛозуватське, УКХ р/м\nЛУЧНИК\nПИРОЖЕК\n\n— ПИРОЖЕК я ЛУЧНИК: ФПВ к нам идет\n\nКоментар: БПЛА СОУ";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("БПЛА СОУ"));
    }

    #[test]
    fn crlf_yyyy_mm_dd_comma_time_is_anchor() {
        let body = "2025-03-08, 10:20\r\n422.500\r\nЛозуватське, УКХ р/м\r\nЛУЧНИК\r\nПИРОЖЕК\r\n\r\n— ПИРОЖЕК я ЛУЧНИК: ФПВ к нам идет\r\n\r\nКоментар: БПЛА СОУ";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("БПЛА СОУ"));
    }

    #[test]
    fn buran_explicit_comment_marker() {
        let body = "Дата: 2024-02-21;\nЧастота: 408.500;\nЛокація: Авдіївка;\nПідрозділ: УКХ р/м;\nЧас: 17:28;\nХто: Змей;\nКому: Чёрный;\nТекст:\n- Чёрный я Змей ответь по керосину\n- 3 мсб? правильно?;\n.\nКоментар: ( запит на зв'язок );";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("запит на зв'язок"));
    }

    #[test]
    fn buran_empty_comment_marker_stops_at_header_fields() {
        let body = "Дата: 2024-02-21;\nЧастота: 408.500;\nКоментар:\nПост: Альфа\nКоординати: 48.123, 37.456\nТекст:\n- Чёрный я Змей ответь по керосину\n- 3 мсб? правильно?;";
        let res = parse_comments(body);
        assert!(res.is_empty());
    }

    #[test]
    fn buran_date_label_is_anchor() {
        let body = "Дата: 23.02.2024\nЧас: 16:47\nЧастота: 412.300\nРайон: Піски;\nПідрозділ: УКХ р/м;\n\n- выйди на мотор\n\nзапит на звязок";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("запит на звязок"));
    }

    // ── Variant 3: top and bottom comments ──────────────────────────────────────

    #[test]
    fn both_top_and_bottom() {
        let body = "верхній коментар\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n— ще репліка\n\nнижній коментар";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("верхній коментар"));
        assert_eq!(res.bottom.as_deref(), Some("нижній коментар"));
    }

    // ── Variant 4: Without comments ───────────────────────────────────────────────────

    #[test]
    fn no_comment_plain_message() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ р/м 60 омсб\nТРАКТОР\nНВ\n\n— Депутат, Депутат Трактору.\n— Да, все живы.";
        let res = parse_comments(body);
        assert!(res.is_empty());
    }

    #[test]
    fn no_anchor_no_marker_returns_empty() {
        let body = "просто якийсь текст\nбез дати і часу";
        let res = parse_comments(body);
        assert!(res.is_empty());
    }

    #[test]
    fn marker_without_anchor_still_extracted() {
        let body = "якийсь нестандартний заголовок\n\n- репліка\n\nКоментар: важлива примітка";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("важлива примітка"));
    }

    #[test]
    fn dialog_with_internal_blank_not_treated_as_comment() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— перша репліка\n\n— друга репліка після пустого рядка";
        let res = parse_comments(body);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn plus_marker_is_not_a_comment() {
        let body = "18.02.2024, 18:32:00\n432.0150\nУКХ радіомережа\n\n- Лопата прием я Филин\n- 5-ть минут да?\n- Плюс";
        let res = parse_comments(body);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn emoji_prefixed_date_is_anchor() {
        let body = "коментар зверху\n\n⚠️20.12, 13:45:21\n430.000\nУКХ р/м\nНВ\nНВ\n\n1 - Батарейки заряжені?";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("коментар зверху"));
    }
}

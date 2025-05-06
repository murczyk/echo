/// Utils mostly for Vec-of-chars string representation
use crate::error::AppError;
use crate::types::*;
use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

pub fn cline_len(inp: &str) -> usize {
    inp.chars().collect::<Vec<char>>().len()
}

/// Searches for words, returns char-indices
pub fn cline_word_indices(inp: &str, xword: &str) -> Vec<usize> {
    let mut res = vec![];
    let mut pos = 0;
    for word in inp.split_word_bounds() {
        if word == xword {
            res.push(pos);
        }
        pos += cline_len(word);
    }
    res
}

pub fn byte_to_char_index(inp: &str, b_index: usize) -> usize {
    let mut pos = 0;
    let mut chars = 0;
    for c in inp.chars() {
        if pos >= b_index {
            return chars;
        }
        pos += c.to_string().len();
        chars += 1;
    }
    return chars;
}

/// Use in pair with functions like String::match_index to get the resulting substring
pub fn byte_substr(
    inp: &str,
    begin: usize,
    end: usize,
) -> Result<String, AppError> {
    Ok(String::from_utf8(
        inp.as_bytes()
            .get(begin..end)
            .ok_or(AppError::BL {
                msg: format!("byte_substr error: {} {} {}", inp, begin, end),
            })?
            .to_vec(),
    )
    .context(h!())?)
}

pub fn str_to_mstr(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Some("") => None
/// Some("   ") => None
pub fn m_str_trim(s: &Option<String>) -> Option<String> {
    match s {
        None => None,
        Some(v) => {
            if v.trim().len() == 0 {
                None
            } else {
                Some(v.to_string())
            }
        }
    }
}

pub fn split_keep<'a>(r: &Regex, text: &'a str) -> Vec<&'a str> {
    let mut result = Vec::new();
    let mut last = 0;
    for (index, matched) in text.match_indices(r) {
        if last != index {
            result.push(&text[last..index]);
        }
        result.push(matched);
        last = index + matched.len();
    }
    if last < text.len() {
        result.push(&text[last..]);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use substring::Substring;

    #[test]
    fn test_cline_len_01() {
        assert_eq!(cline_len("УКРАЇНА"), 7);
        assert_eq!("УКРАЇНА".substring(4, 6), "ЇН");
    }

    #[test]
    fn test_cline_word_indices_01() {
        assert_eq!(
            cline_word_indices("русні пизда повна пизда остаточна", "пизда"),
            vec![6, 18]
        );
    }

    #[test]
    fn test_byte_to_char_index_01() {
        assert_eq!(byte_to_char_index("русні пизда", 4), 2);
        assert_eq!(byte_to_char_index("русні пизда", 11), 6);
    }
}

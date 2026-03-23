/// Utils mostly for Vec-of-chars string representation
use crate::error::AppError;
use crate::types::*;
use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

pub fn cline_len(inp: &str) -> usize {
    inp.chars().count()
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
        pos += c.len_utf8();
        chars += 1;
    }
    chars
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
                msg: format!("byte_substr error: {inp} {begin} {end}"),
            })?
            .to_vec(),
    )
    .c(h!())?)
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
            if v.trim().is_empty() {
                None
            } else {
                Some(v.to_string())
            }
        }
    }
}

pub fn normalize_optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

pub fn normalize_trimmed_or_default(
    value: String,
    default_value: &str,
) -> String {
    let value = value.trim().to_string();
    if value.is_empty() {
        default_value.to_string()
    } else {
        value
    }
}

pub fn split_keep<'a>(r: &Regex, text: &'a str) -> Vec<&'a str> {
    let mut result = Vec::new();
    let mut last = 0;
    for matched in r.find_iter(text) {
        let index = matched.start();
        if last != index {
            result.push(&text[last..index]);
        }
        result.push(matched.as_str());
        last = matched.end();
    }
    if last < text.len() {
        result.push(&text[last..]);
    }
    result
}

/// Shorten master key to SQL `LIKE`-friendly string like:
///
/// - `120363194806689869@g.us` to `1203%69@g.us`
/// - `group.NWFyOHoraXQwak5wQXN6bVh6V3RBMTNpeTg2VHp3aFhPajFPMmVkQXo4ND0=` to `grou%Xo4ND0=`
///
///
pub fn master_key_shortcut(master_key: &str) -> String {
    let max_len = 11;
    if master_key.len() <= max_len {
        return master_key.to_string();
    }
    let half_len = (max_len - 3) / 2;
    format!(
        "{}%{}",
        &master_key[..half_len],
        &master_key[master_key.len() - half_len..]
    )
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

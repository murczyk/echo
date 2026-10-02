//! Position names: a variant-insensitive key and grounding in the source.

/// A letter run or a digit run with its char offsets.
#[derive(Debug, Clone, PartialEq)]
struct Token {
    key: String,
    begin: usize,
    end: usize,
    digits: bool,
}

/// Case endings a Ukrainian or Russian noun may add in the text («Циркона»,
/// «Цирконі»), so an inflected occurrence still grounds the name.
const INFLECTIONS: [&str; 21] = [
    "а", "у", "і", "ї", "е", "ю", "я", "ом", "ою", "ові", "ем", "ів", "ах",
    "ям", "ях", "ами", "ями", "ой", "ы", "ам", "ей",
];
const MIN_INFLECTED_STEM_CHARS: usize = 4;

fn fold_char(c: char) -> char {
    // Latin letters that look Cyrillic in position names typed on a mixed
    // keyboard («Циpкoн»).
    match c {
        'a' => 'а',
        'c' => 'с',
        'e' => 'е',
        'i' => 'і',
        'o' => 'о',
        'p' => 'р',
        'x' => 'х',
        'y' => 'у',
        'k' => 'к',
        'm' => 'м',
        't' => 'т',
        'h' => 'н',
        'b' => 'в',
        'ё' => 'е',
        other => other,
    }
}

fn tokens(text: &str) -> Vec<Token> {
    let mut result: Vec<Token> = Vec::new();
    for (index, c) in text.chars().enumerate() {
        let digits = c.is_ascii_digit();
        if !c.is_alphanumeric() {
            continue;
        }
        let folded: String = c.to_lowercase().map(fold_char).collect();
        match result.last_mut() {
            Some(last) if last.end == index && last.digits == digits => {
                last.key.push_str(&folded);
                last.end = index + 1;
            }
            _ => result.push(Token {
                key: folded,
                begin: index,
                end: index + 1,
                digits,
            }),
        }
    }
    result
}

/// «ЦИРКОН-9», «Циркон 9», «"циркон9"» and «Циpкoн 9» share «циркон 9».
pub fn position_key(name: &str) -> String {
    tokens(name)
        .into_iter()
        .map(|token| token.key)
        .collect::<Vec<_>>()
        .join(" ")
}

fn token_matches(name: &Token, body: &Token) -> bool {
    if name.digits || body.digits {
        return name.key == body.key;
    }
    name.key == body.key
        || (name.key.chars().count() >= MIN_INFLECTED_STEM_CHARS
            && body
                .key
                .strip_prefix(&name.key)
                .is_some_and(|ending| INFLECTIONS.contains(&ending)))
}

/// Char spans of every occurrence of `name` in `text`. Empty when the name
/// does not occur, which drops names the model invented.
pub fn ground(text: &str, name: &str) -> Vec<(usize, usize)> {
    let name_tokens = tokens(name);
    if !name_tokens.iter().any(|token| !token.digits) {
        return Vec::new();
    }
    let body_tokens = tokens(text);
    let chars: Vec<char> = text.chars().collect();
    let mut spans = Vec::new();
    for start in 0..body_tokens.len() {
        let window = &body_tokens[start..];
        if window.len() < name_tokens.len() {
            break;
        }
        let matches =
            name_tokens
                .iter()
                .zip(window)
                .all(|(name_token, body_token)| {
                    token_matches(name_token, body_token)
                });
        // Tokens must be separated only by spaces, dashes, quotes and the
        // like, not by a line break or a sentence.
        let adjacent = window
            .windows(2)
            .take(name_tokens.len().saturating_sub(1))
            .all(|pair| {
                chars[pair[0].end..pair[1].begin].iter().all(|c| {
                    matches!(
                        c,
                        ' ' | '-'
                            | '–'
                            | '_'
                            | '"'
                            | '«'
                            | '»'
                            | '\''
                            | '№'
                            | '#'
                    )
                }) && pair[1].begin - pair[0].end <= 3
            });
        if matches && adjacent {
            spans.push((window[0].begin, window[name_tokens.len() - 1].end));
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::{ground, position_key};

    #[test]
    fn variants_share_a_key() {
        for name in [
            "ЦИРКОН-9",
            "Циркон 9",
            "\"циркон9\"",
            "Циpкoн 9",
            "Циркон_9",
        ] {
            assert_eq!(position_key(name), "циркон 9", "{name}");
        }
    }

    #[test]
    fn grounds_every_variant_occurrence() {
        let text = "Переміщення всл \"Гудок\" до \"Циркон 9\" (36T XT 75734 68963)\nНа ЦИРКОН-9 тихо, Циркона 9 не чути";
        let spans = ground(text, "Циркон 9");
        let found: Vec<String> = spans
            .iter()
            .map(|(begin, end)| {
                text.chars().skip(*begin).take(end - begin).collect()
            })
            .collect();
        assert_eq!(found, vec!["Циркон 9", "ЦИРКОН-9", "Циркона 9"]);
    }

    #[test]
    fn does_not_match_other_numbers_or_words() {
        assert!(ground("на Циркон 91", "Циркон 9").is_empty());
        assert!(ground("Цирконій 9", "Циркон 9").is_empty());
        assert!(ground("Циркон.\n9 осіб", "Циркон 9").is_empty());
        assert!(ground("9 і 9", "9").is_empty());
        assert!(ground("Береза", "Сокіл").is_empty());
    }
}

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
/// Post-type abbreviations written before a position's name («ОП Лиман-2»).
const TYPE_PREFIXES: [&str; 5] = ["оп", "вп", "сп", "нп", "кп"];

/// Generic objects («дамба», «міст», «посадка») that small models return as
/// positions; with a number or code («Дамба-3») they are names.
const GENERIC_OBJECTS: [&str; 22] = [
    "дамба",
    "мост",
    "міст",
    "посадка",
    "лісосмуга",
    "лесополоса",
    "елеватор",
    "элеватор",
    "точка",
    "позиція",
    "позиция",
    "бліндаж",
    "блиндаж",
    "окоп",
    "траншея",
    "перехрестя",
    "перекресток",
    "висота",
    "высота",
    "ферма",
    "блокпост",
    "укриття",
];

/// A single generic word in any case form («дамбу», «мосту»), not a name:
/// longer words that merely start alike («Мостовой», «Фермер») are names.
pub fn is_generic_object(key: &str) -> bool {
    if key.contains(' ') || key.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    GENERIC_OBJECTS.iter().any(|word| {
        key == *word
            || [Some(*word), vowel_stem(word)].into_iter().flatten().any(
                |stem| {
                    key.strip_prefix(stem)
                        .is_some_and(|ending| INFLECTIONS.contains(&ending))
                },
            )
    })
}

/// «ОП Лиман-2» and «Лиман-2» are one position.
pub fn position_key(name: &str) -> String {
    let keys: Vec<String> =
        tokens(name).into_iter().map(|token| token.key).collect();
    let keys = match keys.split_first() {
        Some((first, rest))
            if rest
                .iter()
                .any(|key| !key.chars().all(|c| c.is_ascii_digit()))
                && TYPE_PREFIXES.contains(&first.as_str()) =>
        {
            rest
        }
        _ => &keys[..],
    };
    keys.join(" ")
}

fn token_matches(name: &Token, body: &Token) -> bool {
    if name.digits || body.digits {
        return name.key == body.key;
    }
    if name.key == body.key {
        return true;
    }
    // «Циркон» → «Цирконі»; «Береза» → «Березі» (stem without the final
    // vowel, then a case ending).
    let stems = [Some(name.key.as_str()), vowel_stem(&name.key)];
    stems.into_iter().flatten().any(|stem| {
        stem.chars().count() >= MIN_INFLECTED_STEM_CHARS
            && body
                .key
                .strip_prefix(stem)
                .is_some_and(|ending| INFLECTIONS.contains(&ending))
    })
}

/// The name without a final vowel or soft sign, which declension replaces.
pub(crate) fn vowel_stem(key: &str) -> Option<&str> {
    let last = key.chars().last()?;
    "аяоеєиіїйьу"
        .contains(last)
        .then(|| &key[..key.len() - last.len_utf8()])
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

/// Whether the span is a spreadsheet cell label (`E5:` in text flattened from
/// a table), which names the cell, not the position held in its value.
pub fn is_cell_label(chars: &[char], begin: usize, end: usize) -> bool {
    let Some(label) = chars.get(begin..end) else {
        return false;
    };
    let letters = label.iter().take_while(|c| c.is_ascii_alphabetic()).count();
    let digits = label.len() - letters;
    let is_cell = (1..=3).contains(&letters)
        && (1..=7).contains(&digits)
        && label[letters..].iter().all(char::is_ascii_digit);
    let at_cell_start = begin == 0
        || matches!(chars[begin - 1], '\n' | '\r')
        || (begin >= 2 && chars[begin - 2..begin] == ['|', ' ']);
    is_cell && at_cell_start && chars.get(end) == Some(&':')
}

#[cfg(test)]
mod tests {
    use super::{ground, is_cell_label, position_key};

    fn span_is_label(text: &str, needle: &str, nth: usize) -> bool {
        let chars: Vec<char> = text.chars().collect();
        let (begin, _) = text
            .match_indices(needle)
            .nth(nth)
            .map(|(byte, found)| (text[..byte].chars().count(), found))
            .unwrap();
        is_cell_label(&chars, begin, begin + needle.chars().count())
    }

    #[test]
    fn spots_spreadsheet_cell_labels() {
        let text = "[sheet Лист1; row 5]\nC5: ОП73 | D5: 07.00 | E5: Береза";
        assert!(span_is_label(text, "C5", 0));
        assert!(span_is_label(text, "E5", 0));
        // The cell value is not a label.
        assert!(!span_is_label(text, "ОП73", 0));
        // A label-like word in prose is not a label.
        assert!(!span_is_label("Рух на E5: далі", "E5", 0));
        assert!(!span_is_label("C5 зайнято", "C5", 0));
    }

    #[test]
    fn recognises_generic_objects() {
        use super::is_generic_object;
        assert!(is_generic_object(&position_key("дамбу")));
        assert!(is_generic_object(&position_key("Посадка")));
        assert!(!is_generic_object(&position_key("Дамба-3")));
        assert!(!is_generic_object(&position_key("Висота 120")));
        assert!(!is_generic_object(&position_key("Циркон")));
        assert!(is_generic_object(&position_key("мосту")));
        assert!(!is_generic_object(&position_key("Мостовой")));
        assert!(!is_generic_object(&position_key("Фермер")));
        assert!(!is_generic_object(&position_key("ОП Містик")));
    }

    #[test]
    fn variants_share_a_key() {
        assert_eq!(position_key("ОП Лиман-2"), position_key("Лиман-2"));
        assert_eq!(position_key("ОП 5"), "оп 5");
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
        let text = "Передали Березі 3 і березою 3";
        assert_eq!(ground(text, "Береза 3").len(), 2);
        assert!(ground("Березень 3", "Береза 3").is_empty());
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

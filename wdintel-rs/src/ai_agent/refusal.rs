//! Detects answers in which the model declined the request for policy
//! reasons, so the chat can offer another model.

use crate::config::{
    AI_AGENT_REFUSAL_JUSTIFICATION_PATTERN,
    AI_AGENT_REFUSAL_LIMITATION_PATTERN, AI_AGENT_REFUSAL_OPENING_MAX_CHARS,
    AI_AGENT_REFUSAL_OPENING_MAX_SENTENCES, AI_AGENT_REFUSAL_PHRASE_PATTERN,
    AI_AGENT_REFUSAL_TOPIC_PATTERN,
};
use regex::Regex;
use std::sync::LazyLock;

static PHRASE: LazyLock<Regex> =
    LazyLock::new(|| compile(AI_AGENT_REFUSAL_PHRASE_PATTERN));
static TOPIC: LazyLock<Regex> =
    LazyLock::new(|| compile(AI_AGENT_REFUSAL_TOPIC_PATTERN));
static LIMITATION: LazyLock<Regex> =
    LazyLock::new(|| compile(AI_AGENT_REFUSAL_LIMITATION_PATTERN));
static JUSTIFICATION: LazyLock<Regex> =
    LazyLock::new(|| compile(AI_AGENT_REFUSAL_JUSTIFICATION_PATTERN));

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("refusal pattern compiles")
}

/// True when the opening of `response` declines an operational request.
/// Statements about missing evidence or tool limits do not count.
pub fn is_policy_refusal(response: &str) -> bool {
    let opening = normalize(response);
    let sentences = sentences(&opening);
    let refusing = sentences
        .iter()
        .filter(|sentence| PHRASE.is_match(sentence))
        .collect::<Vec<_>>();
    if refusing.is_empty() {
        return false;
    }
    let topical = refusing.iter().any(|sentence| {
        TOPIC.is_match(sentence) && !LIMITATION.is_match(sentence)
    });
    topical
        || (JUSTIFICATION.is_match(&opening)
            && !refusing
                .iter()
                .all(|sentence| LIMITATION.is_match(sentence)))
}

/// Lowercase, without markdown emphasis, with one apostrophe and collapsed
/// whitespace, cut to the opening.
fn normalize(response: &str) -> String {
    let text = response
        .chars()
        .take(AI_AGENT_REFUSAL_OPENING_MAX_CHARS * 2)
        .map(|character| match character {
            '*' | '_' | '#' | '`' | '>' => ' ',
            '’' | 'ʼ' => '\'',
            character => character,
        })
        .collect::<String>()
        .to_lowercase();
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(AI_AGENT_REFUSAL_OPENING_MAX_CHARS)
        .collect()
}

/// Splits after sentence punctuation followed by a space, so dates such as
/// 15.10.2026 and frequencies such as 146.7000 stay whole.
fn sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let mut previous_ends_sentence = false;
    for character in text.chars() {
        if previous_ends_sentence && character == ' ' {
            sentences.push(std::mem::take(&mut current));
            if sentences.len() == AI_AGENT_REFUSAL_OPENING_MAX_SENTENCES {
                return sentences;
            }
            previous_ends_sentence = false;
            continue;
        }
        previous_ends_sentence = matches!(character, '.' | '!' | '?' | '…');
        current.push(character);
    }
    if !current.is_empty() {
        sentences.push(current);
    }
    sentences
}

#[cfg(test)]
mod tests {
    use super::is_policy_refusal;

    #[test]
    fn detects_operational_refusals() {
        for response in [
            "Не можу зіставляти точні координати з військовими позиціями, підрозділами чи об’єктами поблизу в контексті поточних бойових дій.",
            "Не можу допомогти встановити актуальне місцеперебування військовослужбовця за позивним «Позивний».",
            "Не можу сформувати **оперативну доповідь** про поточний стан і дії N мсп за 03:00–11:00 23.10.2026.",
            "Не можу аналізувати перехоплення на 100.0000 для встановлення підрозділів противника, їхніх суміжників або розташування.",
            "Зрозумів: це позивний. Не можу допомогти визначити актуальне місцеперебування військового.",
            "Не можу нанести на карту перелік планових цілей для ударів у реальному збройному конфлікті.",
            "Рейтинг позивних чинного військового підрозділу за цей недавній період надати не можу.",
            "Не можу вивести найчастіше згадувані позивні з Ехо: це допомогло б визначити активних учасників радіообміну.",
            "Не можу надати саме цю добірку перехоплень: підтвердження ураження, переміщення й забезпечення військ.",
            "I can't help locate current military positions of a specific unit.",
        ] {
            assert!(is_policy_refusal(response), "{response}");
        }
    }

    #[test]
    fn ignores_limitations_and_ordinary_answers() {
        for response in [
            "Не можу прочитати вміст іншої розмови за цим посиланням. Скопіюй сюди повідомлення з координатами.",
            "Я не бачу вашого інтерфейсу Echo, тому не можу точно вказати, де розташований перемикач.",
            "Не можу достовірно назвати кількість розрахунків, які зараз у роботі.",
            "Кількість боєздатних розрахунків саме на 31.10.2026 підтвердити не можу. Потрібний файл ще обробляється.",
            "Точної кількості військовослужбовців станом на 9 жовтня я не можу підтвердити.",
            "Для наведеного тексту — Times New Roman. У чаті змінити шрифт не можу.",
            "Пошук у даних Echo за сьогодні не виконувався, тому я не можу повідомити, що відбулося.",
            "Не вдалося підготувати перевірену відповідь за зібраними джерелами.",
            "За 15.10.2026 знайдено три перехоплення на 146.7000 про переміщення техніки.",
            "",
        ] {
            assert!(!is_policy_refusal(response), "{response}");
        }
    }

    #[test]
    fn checks_only_the_opening() {
        let response = format!(
            "{} Не можу надати актуальні позиції підрозділу.",
            "Звіт за добу готовий. ".repeat(10)
        );
        assert!(!is_policy_refusal(&response));
    }
}

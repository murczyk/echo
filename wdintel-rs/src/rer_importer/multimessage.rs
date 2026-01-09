use crate::entities::signal_message;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use chrono::{DateTime, Local};
use chrono_tz::Tz;
use log::{error, warn};
use sea_orm::*;

const SPLITTABLE_MESSAGE_SIZE: usize = 5000;
const MAX_MESSAGE_SIZE: usize = 20000;

pub fn should_try_split_message(body: &str) -> bool {
    // if message is too long - try splitting it
    let chars = body.chars().count();
    chars > SPLITTABLE_MESSAGE_SIZE
}

pub fn check_message_length_is_valid(body: &str) -> bool {
    // if the message length is >20k + it cannot be split - mark as deleted
    let chars = body.chars().count();
    chars <= MAX_MESSAGE_SIZE
}

pub async fn spawn_multiple_messages<'a, 'async_trait, C>(
    txn: &'a C,
    message: &signal_message::Model,
    body: &str,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut models = vec![];
    let is_src_valid = check_message_length_is_valid(body);
    let tz = crate::config::get_tz();
    let lnow = Local::now().with_timezone(&tz);
    let new_messages: Vec<String> = slice_message(lnow, body);
    if new_messages.len() == 1 && is_src_valid {
        return Ok(models);
    }
    let id = message.id;
    let mut model = message.clone().into_active_model();
    model.deleted = Set(true);
    model.update(txn).await.c(h!())?;

    if new_messages.len() > 1 {
        warn!(
            "signal_message#{id}: invalid message size, too long. splitting..."
        );
        for body in new_messages {
            let deleted = !check_message_length_is_valid(&body);
            let mut model = message.clone().into_active_model();
            model.id = NotSet;
            model.created_at = NotSet;
            model.body = Set(Some(body));
            model.deleted = Set(deleted);
            let result = model.save(txn).await;
            if let Some(id) = result.c(h!())?.id.take() {
                models.push(id)
            }
        }
    } else {
        error!(
            "signal_message#{id}: invalid message size, too long. removing..."
        );
    }
    Ok(models)
}

fn slice_message(lnow: DateTime<Tz>, signal_message: &str) -> Vec<String> {
    let mut rows = signal_message
        .split('\n')
        .collect::<Vec<&str>>()
        .into_iter();
    let mut result = vec![];
    let mut container = vec![];
    loop {
        let Some(row) = rows.next() else {
            break;
        };
        container.push(row);
        for _ in 1..4 {
            let Some(row) = rows.next() else {
                break;
            };
            container.push(row);
        }
        let mut is_a_header = false;
        while !is_a_header {
            let Some(row) = rows.next() else {
                break;
            };
            if is_header(lnow, row) {
                is_a_header = true;
                result.push(container.join("\n"));
                container = vec![];
            }
            container.push(row);
        }
    }
    if !container.is_empty() {
        result.push(container.join("\n"));
    }
    result
}

fn is_header(lnow: DateTime<Tz>, row: &str) -> bool {
    let m_ts = super::datetime::extract_datetime(lnow, row).ok().flatten();
    if m_ts.is_some() {
        return true;
    }
    let m_post = crate::rer_importer::post::extract_post(row).ok().flatten();
    if m_post.is_some() {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // #[cfg_attr(debug_assertions, ignore)]
    // #[tokio::test]
    // async fn test_multi_message() {
    //     let tz = crate::config::get_tz();
    //     let lnow = Local::now().with_timezone(&tz);
    //     let messages50 =
    //         std::fs::read_to_string("data/test_multi_message.txt").unwrap();
    //     let messages = slice_message(lnow, &messages50);
    //     assert_eq!(messages.len(), 50);
    //     assert!(should_try_split_message(&messages50));
    //     for m in messages {
    //         assert!(check_message_length_is_valid(&m));
    //     }
    // }
    //
    // #[cfg_attr(debug_assertions, ignore)]
    // #[tokio::test]
    // async fn test_multi_message2() {
    //     let tz = crate::config::get_tz();
    //     let lnow = Local::now().with_timezone(&tz);
    //     let messages_real =
    //         std::fs::read_to_string("data/test_multi_message2.txt").unwrap();
    //     assert!(should_try_split_message(&messages_real));
    //     let messages = slice_message(lnow, &messages_real);
    //     assert_eq!(messages.len(), 84);
    //     for m in messages {
    //         assert!(check_message_length_is_valid(&m));
    //     }
    // }

    #[cfg_attr(debug_assertions, ignore)]
    #[tokio::test]
    async fn test_multi_message3() {
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let text = r#"Отримано з поста "Khartiia"
--------------------------------------
03.04, 05:45:53
147.5500
УКХ р/м 3 мсб 7 омсп (р-н УДАВ - ПИЛЬНА) (16.03.2025)᛭
НВ
ГИД

1 — Гид, Гид, Гид.
1 — Гид, Гид, Гид.
г — На приеме Гид, на приеме.
1 — Гид, отправь все свои (нрзб) Йогурт (нрзб)
г — Повтори не прошел, не прошел.
1 — Гид, Гид, как принял? Йогурта, Йогурта, сейчас отправим.
1 — В 7:30 будь здесь с упаковочкой для Грача
г — Не, не понял, последнее не понял.
1 — Упаковочка для Грача
г — Принял тебя."#;
        assert!(!should_try_split_message(text));
        let messages = slice_message(lnow, text);
        assert_eq!(messages.len(), 2);
    }
}

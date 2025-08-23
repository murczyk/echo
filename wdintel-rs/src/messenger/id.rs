use crate::config::Config;
use crate::entities::signal_message;
use crate::error::AppError;
use crate::h;
use crate::types::Mode;
use anyhow::Context;
use chrono::*;
use echo_migration::Expr;
use itertools::Itertools;
use lazy_static::lazy_static;
use log::*;
use sea_orm::*;
use std::collections::HashMap;

// The base-36 alphabet: 0-9 followed by a-z. The length of this alphabet is 36.
const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const BASE: u64 = ALPHABET.len() as u64;

pub struct MessageMeta {
    pub id: i64,
    pub datetime: NaiveDateTime,
}

/// makes message id in format 'XXXX-XXXX-XXXX'.
/// X is either a lowercase latin number or a digit.
/// first 10 symbols is encoded timestamp, please refer to encode_datetime_to_base36.
/// remaining 2 symbols are encoded message_id and server_id.
pub fn generate_message_id(
    message: MessageMeta,
    config: &Config,
) -> anyhow::Result<String> {
    let timestamp = message.datetime;
    let id_head = encode_datetime_to_base36(timestamp).context(h!())?;
    let (id_mid, id_tail) = id_head.split_at(4);
    let (id_head, id_tail) = id_tail.split_at(4);

    let server_id = match &config.server_id {
        Some(id) => *id,
        None => {
            error!("server id is missing!");
            1
        }
    };

    // id_tail_decimal is decimal number, first 5 bytes are message_id mod 32, other 5 bytes are server_id mod 32.
    // basically we don't expect to have over 32 servers => server_id mod 32 == server_id
    // let id_tail_decimal = combine_into_base36_len2(
    //     message.datasource_id.unsigned_abs(),
    //     server_id,
    // );
    let id_tail_decimal = combine_into_base36_len2(
        message.id.unsigned_abs(),
        // message.datasource_id.unsigned_abs(),
        server_id,
    );
    // so id_tail_decimal is in range 1..1024, and we can encode it with 2 symbols, because 36 ^ 2 = 1296.
    let id_extra =
        encode_num_to_base36(id_tail_decimal as i64, 2).context(h!())?;
    Ok(format!("{id_head}-{id_mid}-{id_extra}{id_tail}"))
}

pub async fn update_message_with_uid<'a, 'async_trait, C>(
    txn: &'a C,
    config: &Config,
    signal_message: signal_message::Model,
) -> anyhow::Result<signal_message::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    let message_uid = generate_message_id(
        MessageMeta {
            id: signal_message.id,
            datetime: signal_message.created_at,
        },
        config,
    )
    .context(h!())?;
    let mut model = signal_message.into_active_model();
    model.message_uid = Set(Some(message_uid));
    model.update(txn).await.context(h!())
}

pub async fn oneoff_assign_message_ids(
    mode: Mode,
    dry_run: bool,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let cutoff = if dry_run {
        NaiveDateTime::new(
            NaiveDate::from_ymd_opt(2014, 1, 1).context(h!())?,
            NaiveTime::MIN,
        )
    } else {
        Utc::now().naive_utc() - Duration::days(20)
    };
    info!("oneoff_assign_message_ids dry_run={dry_run}");
    if dry_run {
        info!(" > running in dry run mode, no changes applied. to apply changes re-run with --dry-run=false");
    }
    let mut offset = 0;
    let mut id_set = HashMap::new();
    let mut collisions = vec![];
    let mut ids_to_insert = HashMap::new();
    loop {
        let records = signal_message::Entity::find()
            .select_only()
            .column(signal_message::Column::Id)
            .column(signal_message::Column::CreatedAt)
            .column(signal_message::Column::MessageUid)
            .filter(signal_message::Column::CreatedAt.gte(cutoff))
            .order_by_asc(signal_message::Column::CreatedAt)
            .limit(20000)
            .offset(offset)
            .into_tuple::<(i64, NaiveDateTime, Option<String>)>()
            .all(&dbx)
            .await
            .context(h!())?;
        if records.is_empty() {
            break;
        }
        offset += records.len() as u64;
        for (id, datetime, m_uid) in records {
            let meta = MessageMeta { id, datetime };
            let mid = generate_message_id(meta, &config).context(h!())?;
            if let Some((id2, _dt2)) = id_set.remove(&mid) {
                collisions.push((id, id2));
            }
            id_set.insert(mid.clone(), (id, datetime));
            match m_uid {
                None => {
                    ids_to_insert.insert(id, mid);
                }
                Some(muid) => {
                    if muid != mid {
                        debug!("issue occurred on generating ID; expected ID to be {mid}, but present in db: {muid}")
                    }
                }
            }
        }
    }
    if collisions.is_empty() {
        info!("no collisions occurred")
    } else {
        let message_ids = collisions
            .iter()
            .flat_map(|(x, y)| vec![*x, *y].into_iter())
            .collect_vec()
            .chunks(20000)
            .map(|slice| slice.to_vec())
            .collect_vec();
        let mut messages_map = HashMap::new();
        let mut actual_collisions_num = 1;
        for message_ids in message_ids {
            signal_message::Entity::find()
                .filter(signal_message::Column::Id.is_in(message_ids))
                .all(&dbx)
                .await
                .context(h!())?
                .into_iter()
                .map(|m| (m.id, m))
                .for_each(|(id, m)| {
                    messages_map.insert(id, m);
                });
        }
        let mut errors = vec![];
        for (x, y) in collisions {
            let m1 = messages_map.get(&x).context(h!())?;
            let m2 = messages_map.get(&y).context(h!())?;
            let err_msg = format!(
                "collision #{actual_collisions_num} occurred: \n{m1:?}\n{m2:?}"
            );
            let same_group = m1.group_master_key.eq(&m2.group_master_key);
            let same_body = m1.body.eq(&m2.body);
            let same_sender = m1.sender.eq(&m2.sender);
            let same_datasource = m1.datasource_id.eq(&m2.datasource_id);
            if same_group && same_sender && same_body && same_datasource {
                if dry_run {
                    warn!("duplicated messages occurred: id{x}, id{y}");
                }
                continue;
            }
            errors.push(err_msg);
            actual_collisions_num += 1;
        }
        if !errors.is_empty() {
            let msg = format!("Collisions occurred: {}", errors.len());
            error!("{msg}");
            for e in errors {
                error!("{e}");
            }
            if dry_run {
                return Err(AppError::BL { msg });
            }
        }
    }
    if !dry_run {
        info!("inserting generated IDs to db...");
        let mut percentage: u32 = 0;
        let mut counter: u32 = 0;
        let total = ids_to_insert.len() as u32;
        info!("...{percentage}%");
        for (id, uid) in ids_to_insert {
            signal_message::Entity::update_many()
                .filter(signal_message::Column::Id.eq(id))
                .col_expr(signal_message::Column::MessageUid, Expr::value(uid))
                .exec(&dbx)
                .await
                .context(h!())?;
            counter += 1;
            let current_percentage = counter * 100 / total;
            if current_percentage > percentage {
                percentage = current_percentage;
                info!("{percentage}%...")
            }
        }
    }
    info!("done!");
    Ok(())
}

/// this function accepts date, converts it to seconds since 2022-01-01, and encodes to XXXXXXXXXX.
/// X is either a lowercase latin number or a digit.
fn encode_datetime_to_base36(dt: NaiveDateTime) -> anyhow::Result<String> {
    lazy_static! {
    // Define the custom epoch as a NaiveDateTime, this way we support dates since 2022 till 2071.
    // We create a UTC DateTime and then convert to NaiveDateTime to ensure consistent epoch.
        static ref EPOCH_START: NaiveDateTime = Utc.with_ymd_and_hms(2022, 1, 1, 0, 0, 0).unwrap().naive_utc();
    }

    // Calculate the duration in seconds from the epoch to the given datetime.
    let duration = dt.signed_duration_since(*EPOCH_START);
    let seconds = duration.num_milliseconds();

    // Ensure the timestamp is not before the epoch.
    if seconds < 0 {
        anyhow::bail!(
            "Timestamp cannot be before the epoch (2022-01-01 00:00:00 UTC)"
        );
    }
    encode_num_to_base36(seconds, 10)
}

pub fn combine_into_base36_len2(a: u64, b: u32) -> u32 {
    let x = a % 64;
    let y = b % 16;
    let combined_x = (x << 4) as u32;
    combined_x | y
}

fn encode_num_to_base36(num: i64, len: usize) -> anyhow::Result<String> {
    let mut result_chars: Vec<u8> = Vec::with_capacity(len);
    let mut temp_seconds = num as u64;

    // Perform base-36 conversion.
    // We generate characters from right to left (least significant to most significant).
    for _ in 0..len {
        let remainder = (temp_seconds % BASE) as usize;
        result_chars.push(ALPHABET[remainder]);
        temp_seconds /= BASE;
    }

    // The characters were pushed in reverse order, so we need to reverse the vector
    // to get the correct chronological order of symbols.
    result_chars.reverse();

    // Convert the vector of bytes to a String. This is safe because ALPHABET contains only valid UTF-8 ASCII characters.
    String::from_utf8(result_chars).context(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn test_combine_simple() {
        assert_eq!(combine_into_base36_len2(5, 10), 90);
    }

    #[test]
    fn test_combine_with_modulo() {
        assert_eq!(combine_into_base36_len2(17, 65), 273);
    }

    #[test]
    fn test_combine_max_values() {
        // combined: 1111_111111 = 1023 (max for 10 bits)
        assert_eq!(combine_into_base36_len2(15, 63), 255);
    }

    #[test]
    fn test_combine_zero_values() {
        // x = 0 (0000)
        // y = 0 (000000)
        // combined: 0000_000000 = 0
        assert_eq!(combine_into_base36_len2(0, 0), 0);
    }

    #[test]
    fn test_combine_large_inputs() {
        // Ensure modulo works as expected with large inputs
        // a = 100, x = 100 % 16 = 4 (0100)
        // b = 200, y = 200 % 64 = 8 (001000)
        // combined: 0100_001000 = (4 << 6) | 8 = 256 | 8 = 264
        assert_eq!(combine_into_base36_len2(100, 200), 584);
    }

    // Test case for the epoch start date itself
    #[test]
    fn test_encode_epoch_start() {
        let dt = NaiveDate::from_ymd_opt(2022, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        assert_eq!(encode_datetime_to_base36(dt).unwrap(), "0000000000");
    }

    // Test case for a known future date (Jan 1, 2023)
    #[test]
    fn test_encode_future_date() {
        let dt = NaiveDate::from_ymd_opt(2023, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        // Seconds from 2022-01-01 to 2023-01-01 is 31,536,000.
        // 31,536,000 in base 36 is "irxc00".
        assert_eq!(encode_datetime_to_base36(dt).unwrap(), "000ehjpxc0");
    }

    // Test case for the maximum representable date
    #[test]
    fn test_encode_max_date() {
        // This date corresponds to 2,176,782,335 seconds from the epoch.
        // Which is the highest value (36^6 - 1) that can be represented by 6 base-36 characters.
        let dt = NaiveDate::from_ymd_opt(2090, 12, 24)
            .unwrap()
            .and_hms_opt(5, 45, 35)
            .unwrap();
        // The base-36 representation of the maximum value will be "zzzzzz".
        assert_eq!(encode_datetime_to_base36(dt).unwrap(), "00rrzzzz88");
    }

    // Test case to ensure the function panics for dates before the epoch
    #[test]
    #[should_panic(
        expected = "Timestamp cannot be before the epoch (2022-01-01 00:00:00 UTC)"
    )]
    fn test_encode_before_epoch() {
        let dt = NaiveDate::from_ymd_opt(2021, 12, 31)
            .unwrap()
            .and_hms_opt(23, 59, 59)
            .unwrap();
        encode_datetime_to_base36(dt).unwrap();
    }
    #[test]
    fn test_gen_id() {
        let id = 891461;
        let date = NaiveDate::from_ymd_opt(2026, 7, 29).unwrap();
        let time = NaiveTime::from_hms_nano_opt(23, 56, 47, 469647552).unwrap();
        let datetime = NaiveDateTime::new(date, time);

        let config = crate::config::read_config(Mode::Test).unwrap();
        let id =
            generate_message_id(MessageMeta { id, datetime }, &config).unwrap();
        assert_eq!(id, "boob-001u-2dfx");
    }

    #[test]
    fn test_gen_id2() {
        let id = 1745892;
        let date = NaiveDate::from_ymd_opt(2026, 10, 19).unwrap();
        let time = NaiveTime::from_hms_nano_opt(22, 18, 55, 782204129).unwrap();
        let datetime = NaiveDateTime::new(date, time);

        let config = crate::config::read_config(Mode::Test).unwrap();
        let id =
            generate_message_id(MessageMeta { id, datetime }, &config).unwrap();
        assert_eq!(id, "krab-001x-g5hi");
    }

    #[test]
    fn test_gen_id3() {
        let id = 2499063;
        let date = NaiveDate::from_ymd_opt(2026, 7, 22).unwrap();
        let time = NaiveTime::from_hms_nano_opt(14, 26, 43, 718991805).unwrap();
        let datetime = NaiveDateTime::new(date, time);

        let config = crate::config::read_config(Mode::Test).unwrap();
        let id =
            generate_message_id(MessageMeta { id, datetime }, &config).unwrap();
        assert_eq!(id, "1488-001u-olzq");
    }
}

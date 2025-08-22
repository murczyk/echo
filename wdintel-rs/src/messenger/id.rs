use crate::config::Config;
use crate::entities::signal_message;
use crate::error::AppError;
use crate::h;
use crate::types::Mode;
use anyhow::Context;
use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use lazy_static::lazy_static;
use log::{error, info};
use sea_orm::*;
use std::collections::HashMap;

// The base-36 alphabet: 0-9 followed by a-z. The length of this alphabet is 36.
const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const BASE: u64 = ALPHABET.len() as u64;
const DATE_ENCODED_LENGTH: usize = 6;

pub struct MessageMeta {
    pub id: i64,
    pub datetime: NaiveDateTime,
}

/// makes message id in format 'XXXX-XXXX'.
/// X is either a lowercase latin number or a digit.
/// first 6 symbols is encoded timestamp, please refer to encode_datetime_to_base36.
/// remaining 2 symbols are encoded message_id and server_id.
pub fn generate_message_id(
    message: MessageMeta,
    config: &Config,
) -> anyhow::Result<String> {
    let timestamp = message.datetime;
    let id_head = encode_datetime_to_base36(timestamp).context(h!())?;
    let (id_head, id_tail) = id_head.split_at(4);

    let server_id = match &config.server_id {
        Some(id) => *id,
        None => {
            error!("server id is missing!");
            1
        }
    };

    // id_tail_decimal is decimal number, first 5 bytes are message_id mod 32, other 5 bytes are server_id mod 32.
    // basically we don't expect to have over 32 servers => server_id mod 32 == server_id
    let id_tail_decimal =
        combine_into_base36_len2(message.id.unsigned_abs(), server_id);
    // so id_tail_decimal is in range 1..1024, and we can encode it with 2 symbols, because 36 ^ 2 = 1296.
    let id_mid =
        encode_num_to_base36(id_tail_decimal as i64, 2).context(h!())?;
    Ok(format!("{id_head}-{id_mid}{id_tail}"))
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
        Utc::now().naive_utc() - Duration::days(90)
    };
    info!("oneoff_assign_message_ids dry_run={dry_run}");
    if dry_run {
        info!(" > running in dry run mode, no changes applied. to apply changes re-run with --dry-run=false");
    } else {
        return Err(AppError::BL {
            msg: "not implemented yet".to_string(),
        });
    }
    let mut offset = 0;
    let mut id_set = HashMap::new();
    let mut collisions = vec![];
    loop {
        let records = signal_message::Entity::find()
            .select_only()
            .column(signal_message::Column::Id)
            .column(signal_message::Column::Timestamp)
            .filter(signal_message::Column::Timestamp.is_not_null())
            .filter(signal_message::Column::CreatedAt.gte(cutoff))
            .order_by_asc(signal_message::Column::CreatedAt)
            .limit(20000)
            .offset(offset)
            .into_tuple::<(i64, NaiveDateTime)>()
            .all(&dbx)
            .await
            .context(h!())?;
        if records.is_empty() {
            break;
        }
        offset += records.len() as u64;
        for (id, datetime) in records {
            let meta = MessageMeta { id, datetime };
            let mid = generate_message_id(meta, &config).context(h!())?;
            if let Some(id2) = id_set.remove(&mid) {
                println!("collision occurred: {id} vs {id2}");
                collisions.push((id, id2));
            }
            id_set.insert(mid, id);
            //todo update MESSAGE with id=id with message_id=mid
        }
    }
    println!("Collisions occurred: {}", collisions.len());
    Ok(())
}

/// this function accepts date, converts it to seconds since 2022-01-01, and encodes to XXXXXX.
/// X is either a lowercase latin number or a digit.
fn encode_datetime_to_base36(dt: NaiveDateTime) -> anyhow::Result<String> {
    lazy_static! {
    // Define the custom epoch as a NaiveDateTime, this way we support dates since 2022 till 2071.
    // We create a UTC DateTime and then convert to NaiveDateTime to ensure consistent epoch.
        static ref EPOCH_START: NaiveDateTime = Utc.with_ymd_and_hms(2022, 1, 1, 0, 0, 0).unwrap().naive_utc();
    }

    // Calculate the duration in seconds from the epoch to the given datetime.
    let duration = dt.signed_duration_since(*EPOCH_START);
    let seconds = duration.num_seconds();

    // Ensure the timestamp is not before the epoch.
    if seconds < 0 {
        anyhow::bail!(
            "Timestamp cannot be before the epoch (2022-01-01 00:00:00 UTC)"
        );
    }

    // The target length of the encoded string is 6 symbols.
    let len = DATE_ENCODED_LENGTH;

    encode_num_to_base36(seconds, len)
}

fn combine_into_base36_len2(a: u64, b: u32) -> u32 {
    // Calculate x: the lower 5 bits of 'a'.
    // The modulo operation by 32 effectively masks 'a' to its last 5 bits.
    // (e.g., 33 % 32 = 1, which is 00001 in binary)
    let x = a % 32; // x will be in the range [0, 31], requiring 5 bits.

    // Calculate y: the lower 5 bits of 'b'.
    // The modulo operation by 32 effectively masks 'b' to its last 5 bits.
    // (e.g., 35 % 32 = 3, which is 00011 in binary)
    let y = b % 32; // y will be in the range [0, 31], requiring 5 bits.

    // To combine x (5 bits) and y (5 bits) into a 10-bit number where
    // x forms the most significant bits, we shift x left by 5 positions.
    // This creates space for y in the lower 5 bits.
    // Example: if x = 00101 (binary 5) and y = 01010 (binary 10)
    // x << 5 becomes 00101_00000
    let combined_x = (x << 5) as u32;

    // Now, use a bitwise OR operation to place y into the lower 5 bits.
    // (e.g., 00101_00000 | 00000_01010 becomes 00101_01010)
    // The result is already the decimal representation of the 10-bit binary number.
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
        // x = 5 (0101), y = 10 (001010) -> combined: 0101_001010 = 330
        assert_eq!(combine_into_base36_len2(5, 10), 330);
    }

    #[test]
    fn test_combine_with_modulo() {
        // a = 17, x = 17 % 16 = 1 (0001)
        // b = 65, y = 65 % 64 = 1 (000001)
        // combined: 0001_000001 = 65
        assert_eq!(combine_into_base36_len2(17, 65), 65);
    }

    #[test]
    fn test_combine_max_values() {
        // a = 15, x = 15 (1111)
        // b = 63, y = 63 (111111)
        // combined: 1111_111111 = 1023 (max for 10 bits)
        assert_eq!(combine_into_base36_len2(15, 63), 1023);
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
        assert_eq!(combine_into_base36_len2(100, 200), 264);
    }

    // Test case for the epoch start date itself
    #[test]
    fn test_encode_epoch_start() {
        let dt = NaiveDate::from_ymd_opt(2022, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        assert_eq!(encode_datetime_to_base36(dt).unwrap(), "000000");
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
        assert_eq!(encode_datetime_to_base36(dt).unwrap(), "irxc00");
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
        assert_eq!(encode_datetime_to_base36(dt).unwrap(), "zzzzzz");
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
        let id = 12648009;
        let datetime = NaiveDate::from_ymd_opt(2035, 12, 24)
            .unwrap()
            .and_hms_opt(5, 45, 35)
            .unwrap();
        let config = crate::config::read_config(Mode::Test).unwrap();
        let id =
            generate_message_id(MessageMeta { id, datetime }, &config).unwrap();
        assert_eq!(id, "7am5-85bz");
    }
}

use crate::entities::signal_message;
use crate::error::AppError;
use crate::h;
use crate::types::Mode;
use anyhow::Context;
use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use log::info;
use sea_orm::*;
use std::collections::HashMap;

const FNV_PRIME: u64 = 1_099_511_628_211;
const FNV_OFFSET_BASIS: u64 = 14_695_981_039_346_656_037;

pub struct MessageMeta {
    pub id: i64,
    pub group_id: u64,
    pub user_id: u64,
}

pub fn generate_message_id(message: MessageMeta) -> String {
    let user_id_mod = message.user_id % 99;
    let group_id_mod = message.group_id % 99;
    let id_mod = message.id.abs() as u64 % 9999999;

    // A simple, predictable hash combining a, b, and c
    let mut hash: u64 =
        group_id_mod * 10000000 + user_id_mod * 1000000000 + id_mod;

    // Map the hash to letters and numbers
    let letters = "abcdefghijklmnopqrstuvwxyz";

    let mut part1 = String::with_capacity(4);
    for _ in 0..4 {
        let index = (hash % 26) as usize;
        part1.push(letters.chars().nth(index).unwrap());
        hash /= 26;
    }

    // Part 2: Second 4 letters
    let mut part2 = String::with_capacity(4);
    for _ in 0..4 {
        let index = (hash % 26) as usize;
        part2.push(letters.chars().nth(index).unwrap());
        hash /= 26;
    }
    format!("{}-{}", part1, part2)
}

fn fnv1a_hash(input: &str) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in input.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}
pub async fn oneoff_assign_message_ids(
    mode: Mode,
    dry_run: bool,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
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
            .column(signal_message::Column::GroupMasterKey)
            .column(signal_message::Column::Sender)
            .filter(signal_message::Column::CreatedAt.gte(cutoff))
            .order_by_asc(signal_message::Column::CreatedAt)
            .limit(20000)
            .offset(offset)
            .into_tuple::<(i64, Option<String>, Option<String>)>()
            .all(&dbx)
            .await
            .context(h!())?;
        if records.is_empty() {
            break;
        }
        offset += records.len() as u64;
        for (id, group_id, user_id) in records {
            let group_id = match group_id {
                None => 1,
                Some(id) => fnv1a_hash(id.as_str()),
            };
            let user_id = match user_id {
                None => 1,
                Some(id) => fnv1a_hash(id.as_str()),
            };
            let meta = MessageMeta {
                id,
                group_id,
                user_id,
            };
            let mid = generate_message_id(meta);
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

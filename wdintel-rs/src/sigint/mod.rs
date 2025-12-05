use crate::config::{
    FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT, REDIS_MGS_ID_TTL,
};
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::messenger::id;
use crate::messenger::media::{self, MediaUploadInput};
use crate::types::*;
use crate::utils::pop_vector;
use crate::OneoffReprocessCoordsPs;
use base64::engine::general_purpose;
use base64::Engine;
use calamine::Reader;
use chrono::prelude::*;
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use lazy_static::lazy_static;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use regex::Regex;
use sea_orm::sea_query::Expr;
use sea_orm::*;
use std::collections::BTreeSet;
use uuid::Uuid;

pub mod aor;
pub mod callsign;
pub mod etalonka;
pub mod freq;
pub(crate) mod import;
pub mod network;
pub mod post;
pub mod restapi;
pub mod sender;
pub mod signal;
pub mod source;
pub mod types;
pub mod unit;
pub mod worker;
pub mod zone;

pub const SYNC_SECS: u64 = 60;

pub async fn update_message_group_uid<'a, 'async_trait, C>(
    txn: &'a C,
    message_id: i64,
    message_uid: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    signal_message_group::Entity::update_many()
        .col_expr(
            signal_message_group::Column::MessageUid,
            Expr::value(message_uid.to_string()),
        )
        .filter(signal_message_group::Column::SignalMessageId.eq(message_id))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

/// State to be synced periodically with our db
#[derive(Eq, Ord, PartialEq, PartialOrd, Debug, Clone)]
pub struct SyncState {
    pub groups: BTreeSet<SyncStateGroup>,
    pub senders: BTreeSet<SyncStateSender>,
}

#[derive(Eq, Ord, PartialEq, PartialOrd, Debug, Clone)]
pub struct SyncStateGroup {
    pub master_key: String,
    pub name: String,
}

#[derive(Eq, Ord, PartialEq, PartialOrd, Debug, Clone)]
pub struct SyncStateSender {
    pub uuid: Uuid,
    pub name: Option<String>,
}

pub fn base64(bs: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(bs)
}

pub fn from_base64(s: &str) -> Result<Vec<u8>, AppError> {
    Ok(base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(s)
        .c(h!())?)
}

pub async fn oneoff_reprocess_coords(
    mode: Mode,
    ps: &OneoffReprocessCoordsPs,
) -> Result<(), AppError> {
    println!("> oneoff_reprocess_coords {ps:?}");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let cutoff_ts =
        Utc::now().naive_utc() - chrono::TimeDelta::try_days(30).c(h!())?;
    let condition_1 = sigint_inbox_item::Column::Coords
        .is_null()
        .or(sigint_inbox_item::Column::Coords.eq(""));
    let condition_2 = sigint_inbox_item::Column::Coords
        .is_not_null()
        .and(sigint_inbox_item::Column::Datetime.gte(cutoff_ts));
    let mut q = SignalMessage::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(condition_1.or(condition_2));
    if let Some(days) = ps.clone().days {
        let ts = Utc::now() - chrono::TimeDelta::try_days(days).c(h!())?;
        q = q.filter(sigint_inbox_item::Column::Datetime.gte(ts.naive_utc()));
    }
    let count = q.clone().count(&dbx).await.c(h!())?;
    let mut rows = q.stream(&dbx).await.c(h!())?;
    let pb = ProgressBar::new(count);
    let mut found = 0;
    while let Some(message) = rows.try_next().await.c(h!())? {
        pb.inc(1);
        let item_id = message.id;
        let m_item = sigint_inbox_item::Entity::find_by_id(item_id)
            .one(&dbx)
            .await
            .c(h!())?;
        if m_item.is_none() {
            continue;
        }
        let inbox_item: sigint_inbox_item::Model =
            m_item.ok_or("not found 92737")?;
        let ts = inbox_item
            .datetime
            .or(message.timestamp)
            .unwrap_or(message.created_at);
        let mut inbox_item: sigint_inbox_item::ActiveModel = inbox_item.into();
        let Some(ref body) = message.body else {
            continue;
        };
        let mut coords_vec =
            milgeo_rs::coordinates::rer_extract_coords(body).await;
        if !coords_vec.is_empty() {
            found += coords_vec.len();
        }
        crate::location::peleng::delete_inbox_pelengs(item_id, &dbx)
            .await
            .c(h!())?;
        crate::location::peleng::insert_pelengs(
            coords_vec.clone(),
            item_id,
            ts,
            &dbx,
        )
        .await
        .c(h!())?;
        let Some(coords) = pop_vector(&mut coords_vec) else {
            continue;
        };

        inbox_item.coords = Set(Some(coords.text.clone()));
        inbox_item.lat = Set(Some(coords.lat));
        inbox_item.lng = Set(Some(coords.lng));
        inbox_item.update(&dbx).await.c(h!())?;
    }
    println!("> done! filled {found} new coords");
    Ok(())
}

pub async fn find_duplicate_of(
    txn: &DatabaseTransaction,
    body_for_dedupe: &str,
    m_timestamp: Option<NaiveDateTime>,
    db_message_id: i64,
    manager: &mut ConnectionManager,
) -> Result<Option<(signal_message::Model, datasource_group::Model)>, AppError>
{
    let body_base64 =
        general_purpose::STANDARD.encode(body_for_dedupe.as_bytes());
    let key = format!("signal_message:{body_base64}");
    let new_value = format!("{db_message_id}");
    redis::cmd("SET")
        .arg(key.clone())
        .arg(new_value)
        .arg("NX")
        .arg("EX") // Add the Expire option
        .arg(REDIS_MGS_ID_TTL)
        .query_async::<()>(manager)
        .await
        .c(h!())?;

    let original_id: String = manager.get(key).await.c(h!())?;
    let original_id: i64 = original_id.parse().c(h!())?;

    if original_id != db_message_id {
        let mut retry_count = 3;
        let mut original;
        loop {
            original = signal_message::Entity::find()
                .find_with_related(datasource_group::Entity)
                .filter(signal_message::Column::Id.eq(original_id))
                .all(txn)
                .await
                .c(h!())?
                .into_iter()
                .next()
                .and_then(|(m, groups)| {
                    groups.into_iter().next().map(|g| (m, g))
                });
            if original.is_some() {
                break;
            }
            if retry_count < 1 {
                error!("unexpected error: {db_message_id} is duplicate of {original_id}, but {original_id} is missing in db");
                break;
            }
            let sleep_time_ms = 100 + 1000 * (3 - retry_count); // 0.1s 1st time, 1.1s 2nd time, 2.1s 3rd time
            tokio::time::sleep(tokio::time::Duration::from_millis(
                sleep_time_ms,
            ))
            .await;
            retry_count -= 1;
        }
        if let Some(original) = original {
            info!("{db_message_id} is duplicate of {original_id}");
            return Ok(Some(original));
        }
    }
    info!("{db_message_id} is not a duplicate, with body {body_for_dedupe}");

    // find duplicate created N mins ago or later
    let created_recently = signal_message::Column::CreatedAt
        .gte(Utc::now() - chrono::Duration::minutes(30));
    let time_filter = if let Some(timestamp) = m_timestamp {
        signal_message::Column::Timestamp
            .eq(timestamp)
            .or(created_recently)
    } else {
        created_recently
    };

    let mut chars = body_for_dedupe.chars();
    chars.next_back();
    let alt_body = chars.as_str().to_string();

    let m_duplicate = signal_message::Entity::find()
        .find_with_related(datasource_group::Entity)
        .filter(time_filter)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message::Column::Body
                .eq(body_for_dedupe)
                .or(signal_message::Column::Body.eq(alt_body)),
        )
        .order_by_asc(signal_message::Column::CreatedAt)
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .flat_map(|(m, groups)| groups.into_iter().next().map(|g| (m, g)))
        .next();
    Ok(m_duplicate)
}

pub async fn save_attachment_restapi(
    config: &crate::config::Config,
    dbx: &DatabaseConnection,
    s3: &Option<opendal::Operator>,
    attachment: &restapi::Attachment,
    m_db_message_id: Option<i64>,
) -> Result<(), AppError> {
    if let Some(db_message_id) = m_db_message_id {
        if let Some(ref attachment_id) = attachment.id {
            let file_path = crate::config::signal_api_attachment_path(config)?
                .join(attachment_id);
            let path_str = file_path.display().to_string();
            let uploads = [MediaUploadInput {
                path: path_str,
                name: attachment.filename.clone(),
                content_type: Some(attachment.content_type.clone()),
            }];
            media::store_media_attachments(
                &uploads,
                db_message_id,
                config,
                s3,
                dbx,
                config
                    .feature_delete_uploaded_attachment
                    .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT),
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

pub async fn oneoff_sigint_import_mouse(
    mode: Mode,
    ps: &crate::OneoffSigintImportMousePs,
) -> Result<(), AppError> {
    println!("> Starting oneoff_sigint_import_mouse");

    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut redis = crate::new_redis(&config).await.c(h!())?;
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(
            crate::config::RQ_TIMEOUT_SIGNAL_API,
        ))
        .build()
        .c(h!())?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(
            config.settlement_paths().unwrap(),
            mode,
        )
        .unwrap(),
    ));

    let mut workbook: calamine::Xlsx<_> =
        calamine::open_workbook(ps.input.clone()).c(h!())?;
    let mut cur_network: String = "".to_string();
    let mut cur_freq: String = "".to_string();
    let mut cur_date: String = "".to_string();
    let mut cur_time: String = "".to_string();
    let mut cur_from: String;
    let mut cur_to: String;
    if let Ok(r) = workbook.worksheet_range("Sheet1") {
        for row in r.rows() {
            let row: &[calamine::Data] = row;
            // println!("row={:?}, row[0]={:?}", row, row[0]);
            let Some(calamine::Data::String(row0)) = row.first() else {
                continue;
            };
            if let Some(network_name) = extract_network_name(row0)? {
                cur_network = network_name.clone();
                println!("> network: {network_name}");
                continue;
            }
            if let Some(freq) =
                crate::rer_importer::frequency::extract_freq(row0)?
            {
                let freq = crate::rer_importer::frequency::etalon(&freq);
                cur_freq = freq.clone();
            }
            if let Some(calamine::Data::DateTime(row1)) = row.get(1) {
                let dt: NaiveDateTime = NaiveDate::from_ymd_opt(1899, 12, 30)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    + chrono::Duration::days(row1.as_f64() as i64);
                // date as string in format "2023-08-30"
                cur_date = dt.format("%Y-%m-%d").to_string();
            };
            if let Some(calamine::Data::DateTime(row2)) = row.get(2) {
                let full_secs =
                    ((60.0 * 60.0 * 24.0) * row2.as_f64()).round() as i64;
                // println!("> full_secs: {}", full_secs);
                let time = NaiveTime::from_num_seconds_from_midnight_opt(
                    full_secs as u32,
                    0,
                )
                .unwrap();
                cur_time = time.format("%H:%M").to_string();
            };
            if let Some(calamine::Data::String(row3)) = row.get(3) {
                cur_from = row3.trim().to_string();
            } else {
                cur_from = "".to_string();
            }
            if let Some(calamine::Data::String(row4)) = row.get(4) {
                cur_to = row4.trim().to_string();
            } else {
                cur_to = "".to_string();
            }
            if let Some(calamine::Data::String(row5)) = row.get(5) {
                let msg = row5.trim();
                if !cur_freq.is_empty()
                    && !cur_date.is_empty()
                    && !cur_time.is_empty()
                    && !msg.is_empty()
                {
                    // println!("[network:{cur_network}]\n[freq:{cur_freq}]\t[date:{cur_date}]\t[time:{cur_time}]\t[from:{cur_from}]\t[to:{cur_to}]\n{msg}\n");
                    xlsx_import_process_one(
                        settlements.clone(),
                        ps,
                        &dbx,
                        &mut redis,
                        &rq,
                        &cur_network,
                        &cur_freq,
                        &cur_date,
                        &cur_time,
                        &cur_from,
                        &cur_to,
                        msg,
                        &config,
                    )
                    .await
                    .c(h!())?;
                }
            };
        }
    }

    Ok(())
}

/// See process_incoming_message_restapi for inspiration
async fn xlsx_import_process_one(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    ps: &crate::OneoffSigintImportMousePs,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    rq: &reqwest::Client,
    network: &str,
    freq: &str,
    date: &str,
    time: &str,
    from: &str,
    to: &str,
    msg: &str,
    config: &crate::config::Config,
) -> Result<(), AppError> {
    let timestamp = NaiveDateTime::parse_from_str(
        &format!("{date} {time}"),
        "%Y-%m-%d %H:%M",
    )
    .c(h!())?;
    // like this:
    // 31.08.2023_14:13 F=404,1350(МГц) П52
    // УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А (КОПАНІ);
    // ФИЗРУК
    // НВ (НВ)
    // "- (НВ) ФИЗРУКУ
    // -  На приёме
    // -  Ты на месте или в отходе , в отъезде?
    // -  Через 10-ть малых буду у с/тебя!
    // -  Я понял!"
    let date_f = timestamp.format("%d.%m.%Y").to_string();
    let body = format!(
        "{}_{} F={}(МГц)\n{}\n{}\n{}\n\"{}\"",
        date_f,
        time,
        freq.replace(".", ","),
        network,
        if from.is_empty() { "НВ" } else { from },
        if to.is_empty() { "НВ" } else { to },
        crate::utils::trim_lines(&msg.replace("//", "\n")),
    );
    let group_id = ps.signal_group_id.clone();
    let sender_uuid = ps.signal_sender_uuid.clone();
    // choose datasource for this group based on datasource_group mapping
    let datasource_id = datasource_group::Entity::find()
        .filter(datasource_group::Column::GroupMasterKey.eq(group_id.clone()))
        .order_by_desc(datasource_group::Column::CreatedAt)
        .one(dbx)
        .await
        .map(|m| m.map(|dg| dg.datasource_id))
        .unwrap_or(None)
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID);
    // Normalize body
    let body = body.replace("\r\n", "\n");

    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            dbx,
            group_id.to_string(),
            datasource_id,
        )
        .await
        .c(h!())?;

    let message = signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(body.clone())),
        created_at: NotSet,
        datasource_group_id: Set(Some(datasource_group_id)),
        timestamp: Set(Some(timestamp)),
        sender: Set(Some(sender_uuid.to_string())),
        format: Set(Some(2)),
        deleted: Set(false),
        external_id: NotSet,
        message_uid: NotSet,
        duplicate_of: NotSet,
    }
    .insert(dbx)
    .await
    .c(h!())?;
    let db_message_id = message.id;

    signal_message_group::ActiveModel {
        id: NotSet,
        signal_message_id: Set(message.id),
        group_master_key: Set(Some(group_id.clone())),
        sender: Set(message.sender.clone()),
        message_uid: Set(message.message_uid.clone()),
        datasource_group_id: Set(message.datasource_group_id),
        created_at: Set(message.created_at),
    }
    .insert(dbx)
    .await
    .c(h!())?;

    id::update_message_with_uid(dbx, config, message)
        .await
        .c(h!())?;
    crate::rer_importer::bgworker::process_message_to_inbox_nofail(
        settlements.clone(),
        dbx,
        rq,
        config,
        redis,
        db_message_id,
        None,
    )
    .await;

    worker::incoming_message_after_insert(dbx, db_message_id)
        .await
        .c(h!())?;

    Ok(())
}

/// Extracts "Радіомережа №043,0250, УКХ р/м гсадн зі складу ТГр 292 сап 19 мсд 58 А Робочі частоти: 446.000 МГц" into "УКХ р/м гсадн зі складу ТГр 292 сап 19 мсд 58 А"
/// Or "Радіомережа №404,1350, УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А (КОПАНІ); Робочі частоти: 404.135 МГц" into "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А (КОПАНІ)"
fn extract_network_name(s: &str) -> Result<Option<String>, AppError> {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r"Радіомережа №\d+,\d+, (.*) Робочі частоти:").unwrap();
    }

    let caps = RE.captures(s);
    if let Some(caps) = caps {
        let Some(name) = caps.get(1) else {
            return Ok(None);
        };
        let name = name.as_str().to_string();
        let bad_symbol = |c| c == ';' || c == '-';
        let name = name.trim_end_matches(bad_symbol);
        let name = name.trim().to_string();
        let name = if name.is_empty() {
            "НВ".to_string()
        } else {
            name
        };
        Ok(Some(name))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::string::*;

    fn message_to_many_str(body: &str) -> Result<Vec<String>, AppError> {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"⚡⚡⚡ \d\d+[\.,]\d\d\d\d*.*").unwrap();
        }

        if !body.contains("⚡⚡⚡") {
            return Ok(vec![body.to_string()]);
        }

        let mut bodies = vec![];
        let items = split_keep(&RE, body);
        let mut iter = items.into_iter();
        if iter.len() == 1 {
            return Ok(vec![body.to_string()]);
        }
        while let Some(header) = iter.next() {
            let Some(rest) = iter.next() else { continue };
            let rest = rest.trim();
            if rest.is_empty() {
                continue;
            }
            bodies.push(format!("{header}\n\n{rest}"));
        }
        Ok(bodies)
    }

    #[test]
    fn test_base64_01() {
        let bytes: Vec<u8> = vec![1, 2, 3];
        assert_eq!(bytes.clone(), from_base64(&base64(&bytes)).unwrap());
    }

    #[test]
    fn test_extract_network_name_01() {
        let s = "Радіомережа №043,0250, УКХ р/м гсадн зі складу ТГр 292 сап 19 мсд 58 А Робочі частоти: 446.000 МГц";
        assert_eq!(
            Some("УКХ р/м гсадн зі складу ТГр 292 сап 19 мсд 58 А".to_string()),
            extract_network_name(s).unwrap()
        );
    }

    #[test]
    fn test_extract_network_name_02() {
        let s = "Радіомережа №404,1350, УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А (КОПАНІ); Робочі частоти: 404.135 МГц";
        assert_eq!(
            Some(
                "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А (КОПАНІ)"
                    .to_string()
            ),
            extract_network_name(s).unwrap()
        );
    }

    #[test]
    fn test_message_to_many_str_01() {
        let s = r#"⚡⚡⚡ 424.499

Час: 09:47:24
1. Надо группу эвакуации направить, например, если надо было за, за, евакуировать, я вот не понимаю, сколько тебе времени надо, почему ты не подготовил своих людей, и осколко ещё объяснить, что вот щас спустился сильный туман, блять,...

Час: 09:39:50
1. я Псих 1 приём. Один человек потихоньку идёт к тебе, ранение руки и ранение бок. Он пошёл к тебе на встречу


⚡⚡⚡ 435.599

Час: 09:45:01
1. Кольцо 88, авиационная опасность, кольцо 88, я Казань, авиационная опасность, всем в укрытие


⚡⚡⚡ 402.000

Час: 09:40:33
1. Фестиваль Мыш приготовить РПГ-30 и РПГ-7 к работе, максимальная бдительносить


⚡⚡⚡ 405.060

Час: 09:26:38
1. Чугу щас отправляй к Скобе, прям щас отправляй к Скобе, мы его переправим на другую точку, там дадим ему птицу, блять, прям щас его отправляй, как меня понял, приём?"#;
        let res = message_to_many_str(s).unwrap();
        assert_eq!(4, res.len());
        assert_eq!(
            res[0],
            r#"⚡⚡⚡ 424.499

Час: 09:47:24
1. Надо группу эвакуации направить, например, если надо было за, за, евакуировать, я вот не понимаю, сколько тебе времени надо, почему ты не подготовил своих людей, и осколко ещё объяснить, что вот щас спустился сильный туман, блять,...

Час: 09:39:50
1. я Псих 1 приём. Один человек потихоньку идёт к тебе, ранение руки и ранение бок. Он пошёл к тебе на встречу"#
        );
    }

    #[test]
    fn test_message_to_many_str_02() {
        let s = r#"⚡⚡⚡ Надо группу эвакуации направить

например

если надо было"#;
        let res = message_to_many_str(s).unwrap();
        assert_eq!(1, res.len());
        assert_eq!(res[0], s);
    }

    #[test]
    fn test_message_to_many_str_03() {
        let s = r#"⚡⚡⚡ 442,535 УКХ р/м управління 108 дшп 7 дшд р-н НОВОМИХАЙЛІВКА-ОЧЕРЕТУВАТЕ/

Час: 20:01:22
1. Да, в 6 30 солиста, и это, старший Сокол просил, чтоб вы всё равно, ямало там, пытались искать через всех подряд, чтобы он на связь туда вышел

Час: 20:01:37
1. Ждал пока вы идите на связь, вы просто не выходили, всё равно куда-то убыло, куда пока неизвестно

Час: 20:01:44
1. Так чё ж, да, вы как выйдите, ну блять, щас должны вы выйти, ну всё равно попытайтесь его найти, да, вот, чтобы он из нашего сокола вышел

⚡⚡⚡ 443,762 УКХ р/м підрозділів йм. 2 дшб 108 дшп, йм. р-н Вербове  /

Час: 19:56:52
1. Ворон пятьдесят, завтра с утра по серому нужен будет проводник, сюда поедет коробка, но дороги не знает на КНП, нужен будет проводник, кто-то из вас, сможет кто-то поехать?

Час: 19:57:14
1. Да, я понял, позывной Сват будет, позывной Сват
"#;
        let res = message_to_many_str(s).unwrap();
        assert_eq!(2, res.len());
        assert_eq!(
            res[0],
            r#"⚡⚡⚡ 442,535 УКХ р/м управління 108 дшп 7 дшд р-н НОВОМИХАЙЛІВКА-ОЧЕРЕТУВАТЕ/

Час: 20:01:22
1. Да, в 6 30 солиста, и это, старший Сокол просил, чтоб вы всё равно, ямало там, пытались искать через всех подряд, чтобы он на связь туда вышел

Час: 20:01:37
1. Ждал пока вы идите на связь, вы просто не выходили, всё равно куда-то убыло, куда пока неизвестно

Час: 20:01:44
1. Так чё ж, да, вы как выйдите, ну блять, щас должны вы выйти, ну всё равно попытайтесь его найти, да, вот, чтобы он из нашего сокола вышел"#
        );
        assert_eq!(
            res[1],
            r#"⚡⚡⚡ 443,762 УКХ р/м підрозділів йм. 2 дшб 108 дшп, йм. р-н Вербове  /

Час: 19:56:52
1. Ворон пятьдесят, завтра с утра по серому нужен будет проводник, сюда поедет коробка, но дороги не знает на КНП, нужен будет проводник, кто-то из вас, сможет кто-то поехать?

Час: 19:57:14
1. Да, я понял, позывной Сват будет, позывной Сват"#
        );
    }
}

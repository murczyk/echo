use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use sea_orm::*;
use std::io::Write;
use std::path::PathBuf;
use unicode_segmentation::UnicodeSegmentation;

async fn format_f2(
    dbx: &sea_orm::DatabaseConnection,
    body: &str,
    callsigns: &Vec<String>,
) -> Result<String, AppError> {
    let callsign_lexemes = CallsignLexeme::find()
        .filter(callsign_lexeme::Column::Callsign.eq_any(callsigns.clone()))
        .all(dbx)
        .await
        .c(h!())?;
    let bounds: Vec<String> = body
        .to_string()
        .split_word_bounds()
        .map(|x| x.to_string())
        .collect::<Vec<String>>();
    let mut annotation = "".to_string();
    for bound in bounds {
        let bound_l = bound.to_lowercase();
        let m_callsign = callsign_lexemes
            .iter()
            .find(|x| x.lexeme == bound_l)
            .map(|x| x.callsign.clone());
        let is_callsign = m_callsign.is_some();
        if is_callsign {
            annotation.push_str(&format!("{bound} /C "));
        } else {
            annotation.push_str(&format!("{bound} /X "));
        }
    }
    Ok(format!(
        "{body}\nannotation: {annotation}\n================"
    ))
}

pub async fn oneoff_gen_dataset_callsigns(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;

    let now = Utc::now();
    let outfile_p = PathBuf::from(config.storage_dir.clone()).join(format!(
        "callsigns-{}.txt",
        now.naive_utc().format("%Y-%m-%dT%H:%M:%S")
    ));
    let outfile_p_f2 = PathBuf::from(config.storage_dir.clone()).join(format!(
        "callsigns-f2-{}.txt",
        now.naive_utc().format("%Y-%m-%dT%H:%M:%S")
    ));
    println!(
        "> Writing results to: {0} and {1}",
        outfile_p.display(),
        outfile_p_f2.display()
    );
    let mut outfile = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(outfile_p)?;
    let mut outfile_f2 = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(outfile_p_f2)?;

    let q = SignalMessage::find()
        .find_also_related(SigintInboxItem)
        .filter(sigint_inbox_item::Column::Checked.eq(true))
        .filter(signal_message::Column::Deleted.eq(false))
        .order_by_asc(signal_message::Column::Id);
    let msgs_count: u64 = q.clone().count(&dbx).await.c(h!())?;
    let mut msgs = q.stream(&dbx).await.c(h!())?.try_chunks(500);

    let pb = ProgressBar::new(msgs_count);
    while let Some(batch) = msgs.try_next().await.c(h!())? {
        let inbox_ids = batch
            .iter()
            .filter_map(|(_, inbox)| inbox.as_ref().map(|inbox| inbox.id))
            .collect::<Vec<_>>();
        let callsigns_by_item_id =
            crate::inbox::callsigns::load_by_item_ids(&dbx, &inbox_ids).await?;
        for (message, m_inbox) in batch {
            pb.inc(1);
            let Some(inbox) = m_inbox else { continue };
            let Some(body) = message.body else { continue };
            let callsigns = callsigns_by_item_id
                .get(&inbox.id)
                .cloned()
                .unwrap_or_default()
                .effective();
            let callsigns_s = callsigns.join(", ");
            writeln!(
                outfile,
                "{body}\ncallsigns: {callsigns_s}\n================"
            )?;

            writeln!(
                outfile_f2,
                "{}",
                format_f2(&dbx, &body, &callsigns).await.c(h!())?
            )?;
        }
    }
    pb.finish_with_message("done");

    Ok(())
}

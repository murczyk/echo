use std::time::Duration;

use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::worker_watch;
use echo_migration::OnConflict;
use lazy_static::lazy_static;
use log::{info, warn};
use regex::Regex;
use sea_orm::prelude::*;
use sea_orm::*;

pub async fn palitra_highlight_worker_nofail(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) {
    loop {
        if let Err(e) = palitra_highlight_worker_impl(rq, dbx, redis).await {
            log::error!("palitra_highlight_worker error: {e}");
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn palitra_highlight_worker_impl(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> anyhow::Result<()> {
    Ok(())
}

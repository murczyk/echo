use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use serde::Serialize;

pub async fn discord_notify(
    config: &crate::config::Config,
    content: &str,
) -> Result<(), AppError> {
    if config.skip_discord_notifications == Some(true) {
        return Ok(());
    }
    #[derive(Serialize)]
    struct DiscordReq {
        content: String,
    }
    let rq = reqwest::Client::new();

    rq.post(crate::config::DISCORD_WEBHOOK)
        .header("content-type", "application/json")
        .json(&DiscordReq {
            content: content.to_string(),
        })
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;
    Ok(())
}

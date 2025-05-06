use crate::error::AppError;
use serde::Serialize;

pub async fn discord_notify(content: &str) -> Result<(), AppError> {
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
        .await?;
    Ok(())
}

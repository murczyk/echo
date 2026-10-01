use super::types::DirectSubmitParseRsp;
use crate::config::DIRECT_SUBMIT_AI_CALLSIGN_TIMEOUT_SECS;
use crate::types::{Env, ShortContext};
use crate::{h, types::warn};
use std::time::Duration;

pub(super) async fn enrich(
    env: &Env,
    body: &str,
    is_aviation_group: bool,
    parsed: &mut DirectSubmitParseRsp,
) {
    let result = tokio::time::timeout(
        Duration::from_secs(DIRECT_SUBMIT_AI_CALLSIGN_TIMEOUT_SECS),
        parse(env, body, is_aviation_group),
    )
    .await;
    match result {
        Ok(Ok(None)) => {}
        Ok(Ok(Some(callsigns))) => {
            parsed.to =
                crate::ai_callsign::worker::merge_current_and_ai_callsigns(
                    std::mem::take(&mut parsed.to),
                    callsigns,
                );
        }
        Ok(Err(error)) => {
            warn!("direct submit AI callsign parsing failed: {error:#}");
            parsed.ai_callsign_warning = Some(
                "Не вдалося розпізнати позивні за допомогою ШІ. Застосовано звичайний парсинг. Повідомлення можна зберегти."
                    .to_string(),
            );
        }
        Err(error) => {
            warn!("direct submit AI callsign parsing timed out: {error}");
            parsed.ai_callsign_warning = Some(format!(
                "ШІ не відповів за {DIRECT_SUBMIT_AI_CALLSIGN_TIMEOUT_SECS} секунд. Застосовано звичайний парсинг. Повідомлення можна зберегти."
            ));
        }
    }
}

async fn parse(
    env: &Env,
    body: &str,
    is_aviation_group: bool,
) -> anyhow::Result<Option<Vec<String>>> {
    let Some(config) = crate::ai_callsign::worker::load_worker_config(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    let callsigns = crate::ai_callsign::parse_with_feedback(
        &env.dbx,
        &env.rq,
        &config.ai_engine,
        &config.prompt,
        body,
        is_aviation_group,
    )
    .await
    .c(h!())?;
    Ok(Some(callsigns))
}

#[cfg(test)]
mod tests;

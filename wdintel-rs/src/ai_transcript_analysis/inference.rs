use crate::ai_engine::{request_structured_ai_response, AiEngineMessage};
use crate::config::*;
use crate::entities::ai_engine;
use crate::{h, types::ShortContext};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Decision {
    pub important: bool,
    pub description: String,
    pub quotes: Vec<String>,
}

pub(crate) fn parse_response(text: &str) -> anyhow::Result<Decision> {
    let decision = serde_json::from_str::<Decision>(text).c(h!())?;
    anyhow::ensure!(
        decision.description.chars().count()
            <= AI_TRANSCRIPT_ANALYSIS_DESCRIPTION_MAX_CHARS,
        "Опис ШІ перевищує ліміт символів"
    );
    anyhow::ensure!(
        decision.quotes.len() <= AI_TRANSCRIPT_ANALYSIS_QUOTES_MAX_COUNT
            && decision.quotes.iter().all(|quote| !quote.trim().is_empty()
                && quote.chars().count()
                    <= AI_TRANSCRIPT_ANALYSIS_QUOTE_MAX_CHARS),
        "Некоректний список цитат ШІ"
    );
    Ok(decision)
}

pub(crate) fn validate_quotes(
    decision: &Decision,
    transcript: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        decision
            .quotes
            .iter()
            .all(|quote| transcript.contains(quote)),
        "Цитата ШІ відсутня у транскрипції"
    );
    Ok(())
}

pub(crate) async fn request(
    client: &crate::ai_engine::AiEngineClient,
    engine: &ai_engine::Model,
    prompt: &str,
    transcript: &str,
) -> anyhow::Result<crate::ai_engine::AiEngineResponse> {
    anyhow::ensure!(
        transcript.chars().count() <= AI_TRANSCRIPT_ANALYSIS_MAX_CHARS,
        "Транскрипція перевищує ліміт символів"
    );
    let response = request_structured_ai_response(client, engine, vec![
        AiEngineMessage { role: AI_CHAT_ROLE_SYSTEM.to_string(), content: prompt.to_string() },
        AiEngineMessage { role: AI_CHAT_ROLE_USER.to_string(), content: transcript.to_string() },
    ], 0.0, AI_TRANSCRIPT_ANALYSIS_MAX_TOKENS, serde_json::json!({
        "type": "json_schema", "json_schema": {
            "name": "transcript_importance", "strict": true,
            "schema": {"type":"object", "properties":{
                "important":{"type":"boolean"},
                "description":{"type":"string","maxLength":AI_TRANSCRIPT_ANALYSIS_DESCRIPTION_MAX_CHARS,
                    "description":"Короткий опис українською мовою незалежно від мови транскрипції, звичайним текстом, без заголовків, підписів полів чи службових вступів."},
                "quotes":{"type":"array","maxItems":AI_TRANSCRIPT_ANALYSIS_QUOTES_MAX_COUNT,
                    "items":{"type":"string","minLength":1,"maxLength":AI_TRANSCRIPT_ANALYSIS_QUOTE_MAX_CHARS},
                    "description":"Цілісні дослівні фрагменти діалогу мовою оригіналу, без перекладу, на яких ґрунтується рішення. Кожен елемент об'єднує кілька взаємопов'язаних реплік, зокрема різних співрозмовників, і зберігає достатній контекст. Зберігай порядок реплік та внутрішні переноси рядків оригіналу; не розбивай кожну репліку на окрему цитату."}
            }, "required":["important","description","quotes"],"additionalProperties":false}
        }
    })).await.c(h!())?;
    Ok(response)
}

pub(crate) fn decision(
    response: &crate::ai_engine::AiEngineResponse,
    transcript: &str,
) -> anyhow::Result<Decision> {
    anyhow::ensure!(
        response.finish_reason.as_deref() == Some("stop"),
        "Незавершена відповідь ШІ: {:?}",
        response.finish_reason
    );
    let decision = parse_response(&response.content).c(h!())?;
    validate_quotes(&decision, transcript).c(h!())?;
    Ok(decision)
}

pub(crate) async fn analyze(
    client: &crate::ai_engine::AiEngineClient,
    engine: &ai_engine::Model,
    prompt: &str,
    transcript: &str,
) -> anyhow::Result<(Decision, String)> {
    let response = request(client, engine, prompt, transcript).await.c(h!())?;
    Ok((decision(&response, transcript).c(h!())?, response.content))
}

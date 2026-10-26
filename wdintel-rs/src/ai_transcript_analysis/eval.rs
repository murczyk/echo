use super::{inference, settings, store::*, text, types::*};
use crate::entities::ai_engine;
use crate::{
    h,
    types::{Env, ShortContext},
};
use futures::{stream, StreamExt};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(sea_orm::FromQueryResult)]
struct TestMessage {
    id: Uuid,
    message: String,
    version: Uuid,
}
#[derive(sea_orm::FromQueryResult)]
struct SavedResult {
    test_message_id: Uuid,
    ai_engine_id: Uuid,
    important: Option<bool>,
    response_text: String,
    error: Option<String>,
    updated_at: chrono::NaiveDateTime,
}

pub(super) async fn engines<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<Vec<AiTranscriptEngineItem>> {
    Ok(ai_engine::Entity::find()
        .filter(ai_engine::Column::Enabled.eq(true))
        .order_by_asc(ai_engine::Column::Name)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|engine| AiTranscriptEngineItem {
            id: engine.id.to_string(),
            name: engine.name,
            model_name: engine.model_name,
        })
        .collect())
}

pub(super) async fn messages<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<Vec<AiTranscriptTestMessage>> {
    let results = rows::<SavedResult, _>(
        db,
        "select * from ai_transcript_analysis_test_result",
        vec![],
    )
    .await
    .c(h!())?;
    Ok(rows::<TestMessage,_>(db, "select id,message,version from ai_transcript_analysis_test_message order by created_at,id", vec![]).await.c(h!())?
        .into_iter().map(|message| AiTranscriptTestMessage {
            id: message.id.to_string(), message: message.message, version: message.version.to_string(),
            results: results.iter().filter(|result| result.test_message_id == message.id).map(|result| AiTranscriptResult {
                test_message_id: result.test_message_id.to_string(), ai_engine_id: result.ai_engine_id.to_string(),
                important: result.important, response_text: result.response_text.clone(), error: result.error.clone(),
                updated_at: Some(result.updated_at.and_utc().timestamp_millis()),
            }).collect(),
        }).collect())
}

pub(super) async fn run(
    env: &Env,
    req: AiTranscriptRunReq,
) -> anyhow::Result<AiTranscriptRunRsp> {
    let prompt = text(req.prompt).c(h!())?;
    let ids: HashSet<Uuid> = req
        .ai_engine_ids
        .iter()
        .map(|id| Uuid::parse_str(id))
        .collect::<Result<_, _>>()
        .c(h!())?;
    anyhow::ensure!(!ids.is_empty(), "Оберіть ШІ движок");
    let mut engines = Vec::new();
    for id in ids {
        engines.push(settings::engine(&env.dbx, id, false).await.c(h!())?);
    }
    let messages = messages(&env.dbx).await.c(h!())?;
    let message_versions = messages
        .iter()
        .map(|message| AiTranscriptVersion {
            id: message.id.clone(),
            version: message.version.clone(),
        })
        .collect();
    let engine_versions = engines
        .iter()
        .map(|engine| AiTranscriptVersion {
            id: engine.id.to_string(),
            version: engine.updated_at.to_string(),
        })
        .collect();
    let jobs = engines.iter().flat_map(|engine| {
        messages.iter().map(|message| async {
            let response = inference::request(
                &env.ai_engine_client,
                engine,
                &prompt,
                &message.message,
            )
            .await;
            let (important, response_text, error) = match response {
                Ok(response) => {
                    match inference::decision(&response, &message.message) {
                        Ok(decision) => {
                            (Some(decision.important), response.content, None)
                        }
                        Err(error) => {
                            (None, response.content, Some(format!("{error:#}")))
                        }
                    }
                }
                Err(error) => (None, String::new(), Some(format!("{error:#}"))),
            };
            AiTranscriptResult {
                test_message_id: message.id.clone(),
                ai_engine_id: engine.id.to_string(),
                important,
                response_text,
                error,
                updated_at: None,
            }
        })
    });
    let results = stream::iter(jobs)
        .buffer_unordered(
            crate::config::AI_TRANSCRIPT_ANALYSIS_TEST_CONCURRENCY,
        )
        .collect()
        .await;
    Ok(AiTranscriptRunRsp {
        results,
        message_versions,
        engine_versions,
    })
}

async fn validate_versions(
    db: &sea_orm::DatabaseTransaction,
    req: &AiTranscriptSaveReq,
) -> anyhow::Result<()> {
    db.execute_unprepared(
        "lock table ai_transcript_analysis_test_message in share mode",
    )
    .await
    .c(h!())?;
    let current = rows::<TestMessage, _>(
        db,
        "select id,message,version from ai_transcript_analysis_test_message",
        vec![],
    )
    .await
    .c(h!())?;
    let expected: HashMap<_, _> = req
        .message_versions
        .iter()
        .map(|version| (version.id.as_str(), version.version.as_str()))
        .collect();
    anyhow::ensure!(
        expected.len() == req.message_versions.len()
            && current.len() == expected.len()
            && current
                .iter()
                .all(|message| expected.get(message.id.to_string().as_str())
                    == Some(&message.version.to_string().as_str())),
        "Тестові повідомлення змінилися; повторіть розрахунок"
    );
    let versions: HashMap<_, _> = req
        .engine_versions
        .iter()
        .map(|version| (version.id.as_str(), version.version.as_str()))
        .collect();
    anyhow::ensure!(
        versions.len() == req.engine_versions.len(),
        "Версії движків дублюються"
    );
    for version in &req.engine_versions {
        let engine =
            settings::engine(db, Uuid::parse_str(&version.id).c(h!())?, true)
                .await
                .c(h!())?;
        anyhow::ensure!(
            engine.updated_at.to_string() == version.version,
            "ШІ движок змінився; повторіть розрахунок"
        );
    }
    let mut pairs = HashSet::new();
    for result in &req.results {
        anyhow::ensure!(
            expected.contains_key(result.test_message_id.as_str())
                && versions.contains_key(result.ai_engine_id.as_str())
                && pairs
                    .insert((&result.test_message_id, &result.ai_engine_id)),
            "Некоректні або дубльовані результати"
        );
        if result.error.is_none() {
            let decision =
                inference::parse_response(&result.response_text).c(h!())?;
            let message = current
                .iter()
                .find(|message| {
                    message.id.to_string() == result.test_message_id
                })
                .c(h!())?;
            inference::validate_quotes(&decision, &message.message).c(h!())?;
            anyhow::ensure!(
                Some(decision.important) == result.important,
                "Рішення не відповідає JSON-відповіді"
            );
        } else {
            anyhow::ensure!(
                result.important.is_none(),
                "Помилка не може містити рішення"
            );
        }
    }
    Ok(())
}

pub(super) async fn save(
    db: &DatabaseConnection,
    req: AiTranscriptSaveReq,
) -> anyhow::Result<AiTranscriptRunRsp> {
    let prompt = text(req.prompt.clone()).c(h!())?;
    let transaction = db.begin().await.c(h!())?;
    if !req.results.is_empty() {
        validate_versions(&transaction, &req).await.c(h!())?;
    }
    settings::save_prompt(&transaction, &prompt).await.c(h!())?;
    let now = chrono::Utc::now().naive_utc();
    let mut results = req.results;
    for result in &mut results {
        execute(&transaction, "insert into ai_transcript_analysis_test_result(test_message_id,ai_engine_id,prompt,important,response_text,error,updated_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(test_message_id,ai_engine_id) do update set prompt=excluded.prompt,important=excluded.important,response_text=excluded.response_text,error=excluded.error,updated_at=excluded.updated_at",
            vec![Uuid::parse_str(&result.test_message_id).c(h!())?.into(), Uuid::parse_str(&result.ai_engine_id).c(h!())?.into(),prompt.clone().into(),result.important.into(),result.response_text.clone().into(),result.error.clone().into(),now.into()]).await.c(h!())?;
        result.updated_at = Some(now.and_utc().timestamp_millis());
    }
    transaction.commit().await.c(h!())?;
    Ok(AiTranscriptRunRsp {
        results,
        message_versions: req.message_versions,
        engine_versions: req.engine_versions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::cleanup_locked;
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn changed_corpus_cannot_save_old_decisions_or_replace_prompt_3646() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let before = settings::load(&env.dbx).await.unwrap();
        let id = Uuid::now_v7();
        let version = Uuid::now_v7();
        execute(&env.dbx, "insert into ai_transcript_analysis_test_message(id,message,version) values($1,'Новий текст',$2)", vec![id.into(),version.into()]).await.unwrap();
        let request = AiTranscriptSaveReq {
            prompt: "Застарілий промпт".into(),
            results: vec![AiTranscriptResult {
                test_message_id: id.to_string(),
                ai_engine_id: Uuid::now_v7().to_string(),
                important: Some(true),
                response_text:
                    r#"{"important":true,"description":"","quotes":[]}"#.into(),
                error: None,
                updated_at: None,
            }],
            message_versions: vec![AiTranscriptVersion {
                id: id.to_string(),
                version: Uuid::now_v7().to_string(),
            }],
            engine_versions: vec![],
        };
        let error = save(&env.dbx, request).await.unwrap_err();
        assert!(format!("{error:#}").contains("Тестові повідомлення змінилися"));
        assert_eq!(
            settings::load(&env.dbx).await.unwrap().revision,
            before.revision
        );
    }
}

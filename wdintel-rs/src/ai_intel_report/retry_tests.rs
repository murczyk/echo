// Regression coverage for https://github.com/echoua/echo/issues/3821.
use super::tests::{engine_record, read_json_request};
use super::{
    generate_quick_suggestion_with_review, load_settings,
    record_suggestion_attempt, SuggestionAttemptReview, SuggestionResult,
};
use crate::entities::{
    ai_intel_report_attempt, ai_intel_report_engine_budget, signal_message,
};
use crate::types::Env;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    IntoActiveModel, QueryFilter,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

struct InferenceServer {
    url: String,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for InferenceServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn inference_server(
    status: u16,
    response: serde_json::Value,
    delay: Duration,
) -> InferenceServer {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_json_request(&mut stream).await;
            captured.lock().unwrap().push(request);
            tokio::time::sleep(delay).await;
            let body = response.to_string();
            let headers = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(headers.as_bytes()).await;
        }
    });
    InferenceServer {
        url,
        requests,
        task,
    }
}

fn completion(reason: &str, content: Option<&str>) -> serde_json::Value {
    serde_json::json!({"choices": [{"finish_reason": reason, "message": {"content": content}}]})
}

async fn configure(
    env: &Env,
    primary: &InferenceServer,
    fallback: &InferenceServer,
    primary_timeout: i32,
    fallback_timeout: i32,
    total_timeout: i32,
) -> (Uuid, Uuid, Uuid, i64) {
    let login = crate::functest::tests::find_test_login(&env.dbx)
        .await
        .unwrap();
    let group = crate::functest::tests::find_test_datasource_group(&env.dbx)
        .await
        .unwrap();
    let source = crate::functest::tests::mk_signal_message(
        &env.dbx,
        signal_message::ActiveModel {
            body: Set(Some("Перевірка обладнання".into())),
            datasource_group_id: Set(Some(group.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let primary = engine_record(primary.url.clone())
        .into_active_model()
        .insert(&env.dbx)
        .await
        .unwrap();
    let fallback = engine_record(fallback.url.clone())
        .into_active_model()
        .insert(&env.dbx)
        .await
        .unwrap();
    ai_intel_report_engine_budget::Entity::insert_many([
        ai_intel_report_engine_budget::ActiveModel {
            ai_engine_id: Set(primary.id),
            max_tokens: Set(512),
        },
        ai_intel_report_engine_budget::ActiveModel {
            ai_engine_id: Set(fallback.id),
            max_tokens: Set(2048),
        },
    ])
    .exec(&env.dbx)
    .await
    .unwrap();
    let settings = load_settings(&env.dbx).await.unwrap();
    let mut settings = settings.into_active_model();
    settings.quick_suggestion_enabled = Set(true);
    settings.quick_ai_engine_id = Set(Some(primary.id));
    settings.fallback_ai_engine_id = Set(Some(fallback.id));
    settings.primary_timeout_secs = Set(Some(primary_timeout));
    settings.fallback_timeout_secs = Set(Some(fallback_timeout));
    settings.total_timeout_secs = Set(Some(total_timeout));
    settings.update(&env.dbx).await.unwrap();
    (primary.id, fallback.id, login.id, source.id)
}

async fn disable_fallback(env: &Env) {
    let mut settings =
        load_settings(&env.dbx).await.unwrap().into_active_model();
    settings.fallback_ai_engine_id = Set(None);
    settings.update(&env.dbx).await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn exhausted_primary_uses_fallback_budget_and_same_prompt_once() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for partial in [None, Some("{\"suggestions\":[\"незавершений")]
    {
        let primary = inference_server(
            200,
            completion("length", partial),
            Duration::ZERO,
        )
        .await;
        let fallback = inference_server(
            200,
            completion(
                "stop",
                Some(r#"{"suggestions":["Перевірка обладнання"]}"#),
            ),
            Duration::ZERO,
        )
        .await;
        let (_, fallback_id, login_id, source_id) =
            configure(&env, &primary, &fallback, 2, 2, 3).await;
        let mut review = SuggestionAttemptReview::default();
        let result = generate_quick_suggestion_with_review(
            &env,
            login_id,
            source_id,
            &mut review,
        )
        .await
        .unwrap();
        assert!(
            matches!(result, SuggestionResult::Suggestions(values) if values == ["Перевірка обладнання"])
        );
        assert_eq!(review.ai_engine_id, Some(fallback_id));
        let primary_requests = primary.requests.lock().unwrap();
        let fallback_requests = fallback.requests.lock().unwrap();
        assert_eq!(primary_requests.len(), 1);
        assert_eq!(fallback_requests.len(), 1);
        assert_eq!(primary_requests[0]["max_tokens"], 512);
        assert_eq!(fallback_requests[0]["max_tokens"], 2048);
        assert_eq!(
            primary_requests[0]["messages"],
            fallback_requests[0]["messages"]
        );
        assert_eq!(
            primary_requests[0]["response_format"],
            fallback_requests[0]["response_format"]
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn only_successful_primary_results_skip_fallback() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for (status, content, uses_fallback) in [
        (
            200,
            Some(r#"{"suggestions":["Перевірка обладнання"]}"#),
            false,
        ),
        (200, None, true),
        (200, Some("not json"), true),
        (
            200,
            Some(r#"{"suggestions":["Перевірка обладнання 123"]}"#),
            true,
        ),
        (500, Some("upstream error"), true),
    ] {
        for fallback_enabled in [true, false] {
            let primary = inference_server(
                status,
                completion("stop", content),
                Duration::ZERO,
            )
            .await;
            let fallback = inference_server(
                200,
                completion(
                    "stop",
                    Some(r#"{"suggestions":["Перевірка обладнання"]}"#),
                ),
                Duration::ZERO,
            )
            .await;
            let (primary_id, fallback_id, login_id, source_id) =
                configure(&env, &primary, &fallback, 2, 2, 3).await;
            if !fallback_enabled {
                disable_fallback(&env).await;
            }
            let mut review = SuggestionAttemptReview::default();
            let result = generate_quick_suggestion_with_review(
                &env,
                login_id,
                source_id,
                &mut review,
            )
            .await;
            assert_eq!(result.is_ok(), !uses_fallback || fallback_enabled);
            if let Ok(result) = result {
                assert!(
                    matches!(result, SuggestionResult::Suggestions(values) if values == ["Перевірка обладнання"])
                );
            }
            assert_eq!(
                review.ai_engine_id,
                Some(if uses_fallback && fallback_enabled {
                    fallback_id
                } else {
                    primary_id
                })
            );
            assert_eq!(primary.requests.lock().unwrap().len(), 1);
            assert_eq!(
                fallback.requests.lock().unwrap().len(),
                usize::from(uses_fallback && fallback_enabled)
            );
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn unreachable_primary_uses_fallback_only_when_configured() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for fallback_enabled in [true, false] {
        let mut primary =
            inference_server(200, completion("stop", None), Duration::ZERO)
                .await;
        let fallback = inference_server(
            200,
            completion(
                "stop",
                Some(r#"{"suggestions":["Перевірка обладнання"]}"#),
            ),
            Duration::ZERO,
        )
        .await;
        let (primary_id, fallback_id, login_id, source_id) =
            configure(&env, &primary, &fallback, 2, 2, 3).await;
        if !fallback_enabled {
            disable_fallback(&env).await;
        }
        primary.task.abort();
        assert!((&mut primary.task).await.unwrap_err().is_cancelled());
        let mut review = SuggestionAttemptReview::default();
        let result = generate_quick_suggestion_with_review(
            &env,
            login_id,
            source_id,
            &mut review,
        )
        .await;
        assert_eq!(result.is_ok(), fallback_enabled);
        assert_eq!(
            review.ai_engine_id,
            Some(if fallback_enabled {
                fallback_id
            } else {
                primary_id
            })
        );
        assert_eq!(
            fallback.requests.lock().unwrap().len(),
            usize::from(fallback_enabled)
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn fallback_exhaustion_fails_without_a_third_call() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for (status, reason, content, raw_response) in [
        (200, "length", None, Some("")),
        (200, "stop", Some("not json"), Some("not json")),
        (
            200,
            "stop",
            Some(r#"{"suggestions":["Перевірка обладнання 123"]}"#),
            Some(r#"{"suggestions":["Перевірка обладнання 123"]}"#),
        ),
        (200, "stop", None, None),
        (500, "stop", Some("upstream error"), None),
    ] {
        let primary = inference_server(
            200,
            completion("length", Some("primary partial response")),
            Duration::ZERO,
        )
        .await;
        let fallback = inference_server(
            status,
            completion(reason, content),
            Duration::ZERO,
        )
        .await;
        let (_, fallback_id, login_id, source_id) =
            configure(&env, &primary, &fallback, 2, 2, 3).await;
        let mut review = SuggestionAttemptReview::default();
        let result = generate_quick_suggestion_with_review(
            &env,
            login_id,
            source_id,
            &mut review,
        )
        .await
        .map_err(anyhow::Error::from);
        assert!(result.is_err());
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert_eq!(fallback.requests.lock().unwrap().len(), 1);
        record_suggestion_attempt(
            &env.dbx,
            login_id,
            source_id,
            Duration::ZERO,
            &review,
            &result,
        )
        .await
        .unwrap();
        let attempt = ai_intel_report_attempt::Entity::find()
            .filter(
                ai_intel_report_attempt::Column::SourceMessageId.eq(source_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attempt.ai_engine_id, Some(fallback_id));
        assert_eq!(attempt.raw_response.as_deref(), raw_response);
        assert_eq!(attempt.outcome, "failed");
        assert_eq!(attempt.suggestions, serde_json::json!([]));
        assert!(attempt.error.is_some());
    }
}

#[tokio::test]
#[serial_test::serial]
async fn attempt_timeouts_and_shared_deadline_bound_both_calls() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for (
        primary_delay,
        fallback_delay,
        primary_timeout,
        fallback_timeout,
        total_timeout,
        fallback_calls,
        total_expires,
        succeeds,
    ) in [
        (1200, 0, 1, 2, 3, 1, false, true),
        (0, 1200, 2, 1, 3, 1, false, false),
        (600, 1200, 2, 2, 1, 1, true, false),
        (1200, 0, 2, 2, 1, 0, true, false),
    ] {
        let primary = inference_server(
            200,
            completion("length", None),
            Duration::from_millis(primary_delay),
        )
        .await;
        let fallback = inference_server(
            200,
            completion(
                "stop",
                Some(r#"{"suggestions":["Перевірка обладнання"]}"#),
            ),
            Duration::from_millis(fallback_delay),
        )
        .await;
        let (_, _, login_id, source_id) = configure(
            &env,
            &primary,
            &fallback,
            primary_timeout,
            fallback_timeout,
            total_timeout,
        )
        .await;
        let started = Instant::now();
        let result = generate_quick_suggestion_with_review(
            &env,
            login_id,
            source_id,
            &mut SuggestionAttemptReview::default(),
        )
        .await;
        if succeeds {
            assert!(
                matches!(result.unwrap(), SuggestionResult::Suggestions(values) if values == ["Перевірка обладнання"])
            );
        } else {
            let error = result.err().expect("generation must time out");
            assert_eq!(
                format!("{error:?}").contains("загальний ліміт часу"),
                total_expires
            );
        }
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(fallback.requests.lock().unwrap().len(), fallback_calls);
    }
}

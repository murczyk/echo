pub mod types;

use crate::ai_engine::{
    request_structured_ai_response, AiEngineMessage, AiEngineResponse,
};
use crate::config::{
    AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER,
    AI_INTEL_REPORT_ADMIN_ATTEMPT_LIMIT,
    AI_INTEL_REPORT_ATTEMPT_ERROR_MAX_CHARS,
    AI_INTEL_REPORT_ATTEMPT_RAW_RESPONSE_MAX_CHARS,
    AI_INTEL_REPORT_BUCKET_CANDIDATE_LIMIT,
    AI_INTEL_REPORT_BUCKET_EXAMPLE_LIMIT, AI_INTEL_REPORT_EXAMPLE_LIMIT,
    AI_INTEL_REPORT_EXAMPLE_REPORT_MAX_CHARS,
    AI_INTEL_REPORT_EXAMPLE_SOURCE_MAX_CHARS, AI_INTEL_REPORT_HISTORY_DAYS,
    AI_INTEL_REPORT_OUTPUT_MAX_CHARS, AI_INTEL_REPORT_OUTPUT_MAX_TOKENS,
    AI_INTEL_REPORT_PROMPT, AI_INTEL_REPORT_PROMPT_MAX_CHARS,
    AI_INTEL_REPORT_SETTINGS_ID, AI_INTEL_REPORT_SOURCE_MATERIALS_MAX_CHARS,
    AI_INTEL_REPORT_SUGGESTION_LIMIT, AI_INTEL_REPORT_TIMEOUT_SECS,
    SYSTEM_LOGIN_NAME,
};
use crate::entities::{
    ai_engine, ai_intel_report_attempt, ai_intel_report_settings, login,
    media_summary, signal_message, signal_message_media,
};
use crate::error::AppError;
use crate::h;
use crate::sigint::direct_submit::query::{
    find_copyable_signal_messages_for_copy, message_has_copy_access,
};
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use crate::users::{ensure_admin, has_any_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{get, post, web::Json, HttpResponse};
use chrono::{Duration, Utc};
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseBackend, DatabaseConnection, EntityTrait, FromQueryResult,
    IntoActiveModel, QueryFilter, QueryOrder, Statement,
};
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use types::{
    AiIntelReportAttemptItem, AiIntelReportAttemptListRsp,
    AiIntelReportSettingsItem, QuickIntelReportSuggestionReq,
    QuickIntelReportSuggestionRsp, SaveAiIntelReportSettingsReq,
};
use uuid::Uuid;

lazy_static! {
    static ref NUMERIC_TOKEN_RE: Regex =
        Regex::new(r#"(?u)[\p{L}\p{N}]+(?:[.,:/°'\"-][\p{L}\p{N}]+)*"#)
            .unwrap();
}

#[derive(Debug, FromQueryResult)]
struct ExampleCandidate {
    bucket: i32,
    signal_message_id: i64,
    source: String,
    report: String,
    exact_source_match: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct StyleExample {
    source: String,
    report: String,
    exact_source_match: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct SuggestionInput {
    source_materials: Vec<String>,
    style_examples: Vec<StyleExample>,
}

#[derive(Debug, Deserialize)]
struct SuggestionOutput {
    suggestions: Vec<String>,
}

enum SuggestionResult {
    Disabled,
    Suggestions(Vec<String>),
}

#[derive(Default)]
struct SuggestionAttemptReview {
    ai_engine_id: Option<Uuid>,
    raw_response: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct SuggestionAttemptRow {
    id: Uuid,
    login_id: Uuid,
    login: String,
    ai_engine_id: Option<Uuid>,
    ai_engine_name: Option<String>,
    source_message_id: i64,
    outcome: String,
    suggestions: serde_json::Value,
    raw_response: Option<String>,
    error: Option<String>,
    duration_ms: i64,
    created_at: chrono::NaiveDateTime,
}

#[get("/api/admin/ai-intel-report/settings")]
pub async fn get_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiIntelReportSettingsItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(load_settings_item(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-intel-report/settings")]
pub async fn save_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiIntelReportSettingsReq>,
) -> Result<Json<AiIntelReportSettingsItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let quick_ai_engine_id = req
        .quick_ai_engine_id
        .as_deref()
        .map(parse_uuid)
        .transpose()
        .c(h!())?;
    if req.quick_suggestion_enabled && quick_ai_engine_id.is_none() {
        return Err(AppError::BL {
            msg: "Оберіть ШІ движок для швидких розвіддонесень".to_string(),
        });
    }
    if let Some(ai_engine_id) = quick_ai_engine_id {
        ensure_engine_eligible(&env.dbx, ai_engine_id)
            .await
            .c(h!())?;
    }
    let settings = load_settings(&env.dbx).await.c(h!())?;
    let mut settings = settings.into_active_model();
    settings.quick_suggestion_enabled = Set(req.quick_suggestion_enabled);
    settings.quick_ai_engine_id = Set(quick_ai_engine_id);
    settings.updated_at = Set(Utc::now().naive_utc());
    settings.update(&env.dbx).await.c(h!())?;
    Ok(Json(load_settings_item(&env.dbx).await.c(h!())?))
}

#[get("/api/admin/ai-intel-report/attempts")]
pub async fn list_attempts(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiIntelReportAttemptListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let sql = r#"
select
    attempt.id,
    attempt.login_id,
    actor.login,
    attempt.ai_engine_id,
    engine.name as ai_engine_name,
    attempt.source_message_id,
    attempt.outcome,
    attempt.suggestions,
    attempt.raw_response,
    attempt.error,
    attempt.duration_ms,
    attempt.created_at
from ai_intel_report_attempt attempt
inner join login actor on actor.id = attempt.login_id
left join ai_engine engine on engine.id = attempt.ai_engine_id
order by attempt.created_at desc, attempt.id desc
limit $1
"#;
    let rows = SuggestionAttemptRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![(AI_INTEL_REPORT_ADMIN_ATTEMPT_LIMIT as i64).into()],
        ),
    )
    .all(&env.dbx)
    .await
    .c(h!())?;
    let items = rows
        .into_iter()
        .map(suggestion_attempt_item)
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    Ok(Json(AiIntelReportAttemptListRsp { items }))
}

#[post("/api/1.1/intelligence-reports/quick-suggestion")]
pub async fn quick_suggestion(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<QuickIntelReportSuggestionReq>,
) -> Result<HttpResponse, AppError> {
    let login_id = login_id_from_identity(&user).c(h!())?;
    ensure_quick_suggestion_role(&env.dbx, &login_id)
        .await
        .c(h!())?;
    let started_at = Instant::now();
    let mut review = SuggestionAttemptReview::default();
    let result = generate_quick_suggestion_with_review(
        &env,
        login_id,
        req.message_id,
        &mut review,
    )
    .await
    .c(h!());
    let duration = started_at.elapsed();
    if let Err(error) = &result {
        log::warn!(
            "Quick intelligence-report suggestion failed: source_message_id={}, duration_ms={}: {:?}",
            req.message_id,
            duration.as_millis(),
            error,
        );
    }
    if let Err(error) = record_suggestion_attempt(
        &env.dbx,
        login_id,
        req.message_id,
        duration,
        &review,
        &result,
    )
    .await
    {
        log::error!(
            "Failed to record quick intelligence-report attempt: source_message_id={}: {:?}",
            req.message_id,
            error
        );
    }
    let outcome = match &result {
        Ok(SuggestionResult::Disabled) => "disabled",
        Ok(SuggestionResult::Suggestions(_)) => "success",
        Err(_) => "failed",
    };
    if let Some(metrics) = &env.metrics {
        metrics.record_ai_intel_report_suggestion(outcome, duration);
    }
    match result? {
        SuggestionResult::Disabled => Ok(HttpResponse::NoContent().finish()),
        SuggestionResult::Suggestions(suggestions) => Ok(HttpResponse::Ok()
            .json(QuickIntelReportSuggestionRsp { suggestions })),
    }
}

async fn ensure_quick_suggestion_role(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> Result<(), AppError> {
    has_any_role(dbx, login_id, vec!["Rer", "Cyber"]).await
}

pub(crate) async fn ensure_engine_not_used<C>(
    dbx: &C,
    ai_engine_id: Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let is_used = ai_intel_report_settings::Entity::find()
        .filter(
            ai_intel_report_settings::Column::QuickSuggestionEnabled.eq(true),
        )
        .filter(
            ai_intel_report_settings::Column::QuickAiEngineId.eq(ai_engine_id),
        )
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_used {
        return Err(AppError::BL {
            msg: "ШІ движок використовується швидкими розвіддонесеннями. Спочатку вимкніть пропозиції або виберіть інший движок.".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
async fn generate_quick_suggestion(
    env: &Env,
    login_id: Uuid,
    signal_message_id: i64,
) -> Result<SuggestionResult, AppError> {
    generate_quick_suggestion_with_review(
        env,
        login_id,
        signal_message_id,
        &mut SuggestionAttemptReview::default(),
    )
    .await
}

async fn generate_quick_suggestion_with_review(
    env: &Env,
    login_id: Uuid,
    signal_message_id: i64,
    review: &mut SuggestionAttemptReview,
) -> Result<SuggestionResult, AppError> {
    let settings = load_settings(&env.dbx).await.c(h!())?;
    if !settings.quick_suggestion_enabled {
        return Ok(SuggestionResult::Disabled);
    }
    let ai_engine_id = settings.quick_ai_engine_id.c(h!())?;
    review.ai_engine_id = Some(ai_engine_id);
    let ai_engine =
        find_eligible_engine(&env.dbx, ai_engine_id).await.c(h!())?;
    let allowed_groups = crate::messenger::group::get_identity_sigint_groups(
        &env.dbx, &login_id,
    )
    .await
    .c(h!())?;
    let organism_logins =
        crate::users::get_organism_login_ids_by_id(&env.dbx, &login_id)
            .await
            .c(h!())?;
    let mut sources = find_copyable_signal_messages_for_copy(
        &env.dbx,
        &[signal_message_id],
        &allowed_groups,
        &login_id,
        &organism_logins,
    )
    .await
    .c(h!())?;
    let source = sources.pop().c(h!())?;
    let source_materials =
        load_source_materials(&env.dbx, &source).await.c(h!())?;
    let style_examples = load_style_examples(
        &env.dbx,
        &source,
        &allowed_groups,
        &login_id,
        &organism_logins,
    )
    .await
    .c(h!())?;
    let user_prompt =
        build_user_prompt(source_materials.clone(), style_examples).c(h!())?;
    let response = request_suggestion(&ai_engine, user_prompt).await.c(h!())?;
    review.raw_response = Some(truncate_chars(
        &response.content,
        AI_INTEL_REPORT_ATTEMPT_RAW_RESPONSE_MAX_CHARS,
    ));
    let suggestions =
        validate_suggestion_response(&response, &source_materials).c(h!())?;
    Ok(SuggestionResult::Suggestions(suggestions))
}

async fn request_suggestion(
    ai_engine: &ai_engine::Model,
    user_prompt: String,
) -> Result<AiEngineResponse, AppError> {
    request_suggestion_with_timeout(
        ai_engine,
        user_prompt,
        std::time::Duration::from_secs(AI_INTEL_REPORT_TIMEOUT_SECS),
    )
    .await
}

async fn request_suggestion_with_timeout(
    ai_engine: &ai_engine::Model,
    user_prompt: String,
    timeout: std::time::Duration,
) -> Result<AiEngineResponse, AppError> {
    let messages = vec![
        AiEngineMessage {
            role: AI_CHAT_ROLE_SYSTEM.to_string(),
            content: AI_INTEL_REPORT_PROMPT.to_string(),
        },
        AiEngineMessage {
            role: AI_CHAT_ROLE_USER.to_string(),
            content: user_prompt,
        },
    ];
    let response_format = serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "quick_intelligence_report_suggestion",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "suggestions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": AI_INTEL_REPORT_SUGGESTION_LIMIT,
                        "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": AI_INTEL_REPORT_OUTPUT_MAX_CHARS
                        }
                    }
                },
                "required": ["suggestions"],
                "additionalProperties": false
            }
        }
    });
    match tokio::time::timeout(
        timeout,
        request_structured_ai_response(
            ai_engine,
            messages,
            0.0,
            AI_INTEL_REPORT_OUTPUT_MAX_TOKENS,
            response_format,
        ),
    )
    .await
    {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(AppError::ServiceUnavailable {
            msg: "Швидке формування розвіддонесення перевищило ліміт часу"
                .to_string(),
            retry_after_secs: 1,
        }),
    }
}

async fn load_source_materials(
    dbx: &DatabaseConnection,
    source: &signal_message::Model,
) -> Result<Vec<String>, AppError> {
    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(source.id))
        .order_by_asc(signal_message_media::Column::CreatedAt)
        .order_by_asc(signal_message_media::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let media_ids = media.iter().map(|item| item.id).collect::<Vec<_>>();
    let transcriptions =
        crate::transcriber::completed_transcriptions(dbx, &media_ids)
            .await
            .c(h!())?;
    let summaries = media_summary::Entity::find()
        .filter(media_summary::Column::MediaId.is_in(media_ids))
        .filter(media_summary::Column::State.eq("completed"))
        .filter(media_summary::Column::Summary.is_not_null())
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|summary| {
            summary.summary.map(|text| (summary.media_id, text))
        })
        .collect::<HashMap<_, _>>();
    let mut candidates = Vec::new();
    if let Some(body) = source.body.as_deref().map(str::trim) {
        if !body.is_empty() {
            candidates.push(format!("Текст повідомлення:\n{body}"));
        }
    }
    for item in media {
        if let Some(transcription) = transcriptions.get(&item.id) {
            let transcription = transcription.trim();
            if !transcription.is_empty() {
                candidates.push(format!("Розшифровка аудіо:\n{transcription}"));
            }
        }
        if let Some(summary) = summaries.get(&item.id) {
            let summary = summary.trim();
            if !summary.is_empty() {
                candidates.push(format!("Стислий опис документа:\n{summary}"));
            }
        }
    }
    let source_materials =
        bound_strings(candidates, AI_INTEL_REPORT_SOURCE_MATERIALS_MAX_CHARS);
    if source_materials.is_empty() {
        return Err(AppError::BL {
            msg: "Повідомлення не містить готових текстових матеріалів"
                .to_string(),
        });
    }
    Ok(source_materials)
}

async fn load_style_examples(
    dbx: &DatabaseConnection,
    source: &signal_message::Model,
    allowed_groups: &[String],
    login_id: &Uuid,
    organism_logins: &[Uuid],
) -> Result<Vec<StyleExample>, AppError> {
    if allowed_groups.is_empty() {
        return Ok(Vec::new());
    }
    let login = login::Entity::find_by_id(*login_id)
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let target_at = source.created_at;
    let since = target_at - Duration::days(AI_INTEL_REPORT_HISTORY_DAYS);
    let exact_sources = exact_source_variants(source.body.as_deref());
    let sql = r#"
with linked_products as (
    select
        ip.source_message_id as signal_message_id,
        coalesce(parent_sii.body_noheader->>'body', parent_sm.body, '') as source,
        trim(report_sm.body) as report,
        ip.created_at,
        author.id as login_id,
        author.organism_id
    from intel_product ip
    inner join signal_message parent_sm
        on parent_sm.id = ip.source_message_id
    inner join signal_message report_sm
        on report_sm.id = ip.intel_message_id
    inner join login author
        on report_sm.login_id = author.id
        or (
            report_sm.login_id is null
            and (
                report_sm.sender = author.id::text
                or report_sm.sender = author.login
            )
        )
    left join sigint_inbox_item parent_sii on parent_sii.id = parent_sm.id
    left join datasource_group dg
        on dg.id = parent_sm.datasource_group_id
       and dg.group_master_key = any($3::text[])
    left join lateral (
        select smg.group_master_key
        from signal_message_group smg
        where smg.signal_message_id = parent_sm.id
          and smg.group_master_key = any($3::text[])
        order by smg.group_master_key
        limit 1
    ) ag on true
    where ip.relation_kind = 'report'
      and ip.created_at >= $2
      and ip.created_at < $1
      and parent_sm.created_at < $1
      and report_sm.created_at < $1
      and parent_sm.id <> $10
      and author.login <> $7
      and not author.deleted
      and not author.deleted_permanently
      and not parent_sm.deleted
      and not report_sm.deleted
      and coalesce(dg.group_master_key, ag.group_master_key) is not null
      and char_length(trim(report_sm.body)) between 1 and $8
      and trim(report_sm.body) !~ '[0-9]'
), comment_products as (
    select
        c.signal_message_id,
        coalesce(sii.body_noheader->>'body', sm.body, '') as source,
        trim(c.comment) as report,
        c.created_at,
        c.login_id,
        author.organism_id
    from sigint_comment c
    inner join login author on author.id = c.login_id
    inner join signal_message sm on sm.id = c.signal_message_id
    left join sigint_inbox_item sii on sii.id = sm.id
    left join datasource_group dg
        on dg.id = sm.datasource_group_id
       and dg.group_master_key = any($3::text[])
    left join lateral (
        select smg.group_master_key
        from signal_message_group smg
        where smg.signal_message_id = sm.id
          and smg.group_master_key = any($3::text[])
        order by smg.group_master_key
        limit 1
    ) ag on true
    where c.created_at >= $2
      and c.created_at < $1
      and sm.created_at < $1
      and sm.id <> $10
      and author.login <> $7
      and not author.deleted
      and not author.deleted_permanently
      and not sm.deleted
      and coalesce(dg.group_master_key, ag.group_master_key) is not null
      and char_length(trim(c.comment)) between 1 and $8
      and trim(c.comment) !~ '[0-9]'
), candidates as (
    select * from linked_products
    union all
    select * from comment_products
), classified as (
    select *,
        case
            when login_id = $4 then 1
            when organism_id = $5 then 2
            else 3
        end as bucket,
        trim(regexp_replace(source, '[[:space:]]+', ' ', 'g')) = any($9::text[])
            as exact_source_match
    from candidates
), ranked as (
    select *, row_number() over (
        partition by bucket
        order by exact_source_match desc, created_at desc, signal_message_id desc
    ) as bucket_rank
    from classified
    where bucket is not null
)
select bucket, signal_message_id, source, report, exact_source_match
from ranked
where bucket_rank <= $6
order by exact_source_match desc, bucket, created_at desc, signal_message_id desc
"#;
    let candidates =
        ExampleCandidate::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![
                target_at.into(),
                since.into(),
                allowed_groups.to_vec().into(),
                (*login_id).into(),
                login.organism_id.into(),
                (AI_INTEL_REPORT_BUCKET_CANDIDATE_LIMIT as i64).into(),
                SYSTEM_LOGIN_NAME.into(),
                (AI_INTEL_REPORT_EXAMPLE_REPORT_MAX_CHARS as i64).into(),
                exact_sources.into(),
                source.id.into(),
            ],
        ))
        .all(dbx)
        .await
        .c(h!())?;
    select_examples(dbx, candidates, allowed_groups, login_id, organism_logins)
        .await
}

async fn select_examples(
    dbx: &DatabaseConnection,
    candidates: Vec<ExampleCandidate>,
    allowed_groups: &[String],
    login_id: &Uuid,
    organism_logins: &[Uuid],
) -> Result<Vec<StyleExample>, AppError> {
    let mut examples = Vec::new();
    let mut bucket_counts = HashMap::<i32, usize>::new();
    let mut seen_messages = HashSet::new();
    let mut seen_reports = HashSet::new();
    for candidate in candidates {
        if examples.len() >= AI_INTEL_REPORT_EXAMPLE_LIMIT {
            break;
        }
        if bucket_counts
            .get(&candidate.bucket)
            .copied()
            .unwrap_or_default()
            >= AI_INTEL_REPORT_BUCKET_EXAMPLE_LIMIT
        {
            continue;
        }
        if candidate.report.chars().any(char::is_numeric)
            || candidate.report.chars().count()
                > AI_INTEL_REPORT_EXAMPLE_REPORT_MAX_CHARS
            || seen_messages.contains(&candidate.signal_message_id)
        {
            continue;
        }
        let normalized_report = normalize_whitespace(&candidate.report);
        if normalized_report.is_empty()
            || seen_reports.contains(&normalized_report)
        {
            continue;
        }
        let Some(source_message) =
            signal_message::Entity::find_by_id(candidate.signal_message_id)
                .filter(signal_message::Column::Deleted.eq(false))
                .one(dbx)
                .await
                .c(h!())?
        else {
            continue;
        };
        if !message_has_copy_access(
            dbx,
            &source_message,
            allowed_groups,
            login_id,
            organism_logins,
        )
        .await
        .c(h!())?
        {
            continue;
        }
        let source = sanitize_example_source(&candidate.source);
        if source.is_empty() {
            continue;
        }
        seen_messages.insert(candidate.signal_message_id);
        seen_reports.insert(normalized_report.clone());
        *bucket_counts.entry(candidate.bucket).or_default() += 1;
        examples.push(StyleExample {
            source,
            report: normalized_report,
            exact_source_match: candidate.exact_source_match,
        });
    }
    Ok(examples)
}

fn build_user_prompt(
    source_materials: Vec<String>,
    mut style_examples: Vec<StyleExample>,
) -> Result<String, AppError> {
    loop {
        let prompt = serde_json::to_string(&SuggestionInput {
            source_materials: source_materials.clone(),
            style_examples,
        })
        .c(h!())?;
        if AI_INTEL_REPORT_PROMPT.chars().count() + prompt.chars().count()
            <= AI_INTEL_REPORT_PROMPT_MAX_CHARS
        {
            return Ok(prompt);
        }
        let mut input: SuggestionInput =
            serde_json::from_str(&prompt).c(h!())?;
        if input.style_examples.pop().is_none() {
            return Err(AppError::BL {
                msg: "Текст повідомлення перевищує ліміт швидкого формування"
                    .to_string(),
            });
        }
        style_examples = input.style_examples;
    }
}

fn validate_suggestions(
    response: &str,
    source_materials: &[String],
) -> Result<Vec<String>, AppError> {
    let response: SuggestionOutput = serde_json::from_str(response)
        .map_err(|_| generation_error("malformed structured output"))
        .c(h!())?;
    if response.suggestions.is_empty() {
        return Err(generation_error("structured output has no variants"));
    }
    if response.suggestions.len() > AI_INTEL_REPORT_SUGGESTION_LIMIT {
        return Err(generation_error(
            "structured output exceeds variant limit",
        ));
    }
    let source = source_materials.join("\n");
    let source_tokens = numeric_tokens(&source);
    let mut suggestions = Vec::new();
    let mut seen = HashSet::new();
    let mut total_chars = 0;
    for suggestion in response.suggestions {
        let suggestion = suggestion.trim().to_string();
        let normalized = normalize_whitespace(&suggestion).to_lowercase();
        total_chars += suggestion.chars().count();
        if suggestion.is_empty() {
            return Err(generation_error(
                "structured output has empty variant",
            ));
        }
        if suggestion.chars().count() > AI_INTEL_REPORT_OUTPUT_MAX_CHARS
            || total_chars > AI_INTEL_REPORT_OUTPUT_MAX_CHARS
        {
            return Err(generation_error(
                "structured output exceeds character limit",
            ));
        }
        if suggestion.contains('\n') || suggestion.contains('\r') {
            return Err(generation_error(
                "structured output variant is not one paragraph",
            ));
        }
        if !seen.insert(normalized) {
            return Err(generation_error(
                "structured output contains duplicate variants",
            ));
        }
        if numeric_tokens(&suggestion)
            .iter()
            .any(|token| !source_tokens.contains(token))
        {
            return Err(generation_error(
                "structured output contains unsupported numeric token",
            ));
        }
        suggestions.push(suggestion);
    }
    Ok(suggestions)
}

fn validate_suggestion_response(
    response: &AiEngineResponse,
    source_materials: &[String],
) -> Result<Vec<String>, AppError> {
    if response.finish_reason.as_deref() == Some("length") {
        return Err(generation_error(
            "structured output was truncated at token limit",
        ));
    }
    validate_suggestions(&response.content, source_materials)
}

fn numeric_tokens(text: &str) -> HashSet<String> {
    NUMERIC_TOKEN_RE
        .find_iter(text)
        .map(|item| item.as_str())
        .filter(|item| item.chars().any(char::is_numeric))
        .map(str::to_string)
        .collect()
}

fn sanitize_example_source(source: &str) -> String {
    let source = crate::rer_importer::body_noheader::extract_text(source)
        .map(|body| body.body)
        .unwrap_or_else(|_| source.to_string());
    let source = source
        .split_whitespace()
        .map(|token| {
            if token.chars().any(char::is_numeric) {
                "[число]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&source, AI_INTEL_REPORT_EXAMPLE_SOURCE_MAX_CHARS)
}

fn exact_source_variants(source: Option<&str>) -> Vec<String> {
    let Some(source) = source else {
        return Vec::new();
    };
    let mut variants = vec![normalize_whitespace(source)];
    if let Ok(body) = crate::rer_importer::body_noheader::extract_text(source) {
        variants.push(normalize_whitespace(&body.body));
    }
    variants.retain(|variant| !variant.is_empty());
    variants.sort_unstable();
    variants.dedup();
    variants
}

fn bound_strings(values: Vec<String>, max_chars: usize) -> Vec<String> {
    let mut remaining = max_chars;
    let mut bounded = Vec::new();
    for value in values {
        if remaining == 0 {
            break;
        }
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let value = truncate_chars(value, remaining);
        remaining = remaining.saturating_sub(value.chars().count());
        bounded.push(value);
    }
    bounded
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn generation_error(reason: &'static str) -> AppError {
    log::warn!("Quick intelligence-report suggestion rejected: {reason}");
    AppError::BL {
        msg: format!(
            "Не вдалося сформувати безпечну пропозицію розвіддонесення: {reason}"
        ),
    }
}

async fn record_suggestion_attempt(
    dbx: &DatabaseConnection,
    login_id: Uuid,
    source_message_id: i64,
    duration: std::time::Duration,
    review: &SuggestionAttemptReview,
    result: &anyhow::Result<SuggestionResult>,
) -> anyhow::Result<()> {
    let (outcome, suggestions, error) = match result {
        Ok(SuggestionResult::Disabled) => ("disabled", Vec::new(), None),
        Ok(SuggestionResult::Suggestions(suggestions)) => {
            ("success", suggestions.clone(), None)
        }
        Err(error) => (
            "failed",
            Vec::new(),
            Some(truncate_chars(
                &format!("{error:?}"),
                AI_INTEL_REPORT_ATTEMPT_ERROR_MAX_CHARS,
            )),
        ),
    };
    ai_intel_report_attempt::ActiveModel {
        id: Set(Uuid::now_v7()),
        login_id: Set(login_id),
        ai_engine_id: Set(review.ai_engine_id),
        source_message_id: Set(source_message_id),
        outcome: Set(outcome.to_string()),
        suggestions: Set(serde_json::to_value(suggestions).c(h!())?),
        raw_response: Set(review.raw_response.clone()),
        error: Set(error),
        duration_ms: Set(
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        ),
        created_at: Set(Utc::now().naive_utc()),
    }
    .insert(dbx)
    .await
    .c(h!())?;
    Ok(())
}

fn suggestion_attempt_item(
    row: SuggestionAttemptRow,
) -> anyhow::Result<AiIntelReportAttemptItem> {
    Ok(AiIntelReportAttemptItem {
        id: row.id.to_string(),
        login_id: row.login_id.to_string(),
        login: row.login,
        ai_engine_id: row.ai_engine_id.map(|id| id.to_string()),
        ai_engine_name: row.ai_engine_name,
        source_message_id: row.source_message_id,
        outcome: row.outcome,
        suggestions: serde_json::from_value(row.suggestions).c(h!())?,
        raw_response: row.raw_response,
        error: row.error,
        duration_ms: row.duration_ms,
        created_at: row.created_at.and_utc().timestamp_millis(),
    })
}

async fn load_settings(
    dbx: &DatabaseConnection,
) -> Result<ai_intel_report_settings::Model, AppError> {
    Ok(ai_intel_report_settings::Entity::find_by_id(
        AI_INTEL_REPORT_SETTINGS_ID,
    )
    .one(dbx)
    .await
    .c(h!())?
    .c(h!())?)
}

async fn load_settings_item(
    dbx: &DatabaseConnection,
) -> Result<AiIntelReportSettingsItem, AppError> {
    let settings = load_settings(dbx).await.c(h!())?;
    Ok(AiIntelReportSettingsItem {
        quick_suggestion_enabled: settings.quick_suggestion_enabled,
        quick_ai_engine_id: settings
            .quick_ai_engine_id
            .map(|id| id.to_string()),
        legacy_comment_cutoff: settings
            .legacy_comment_cutoff
            .and_utc()
            .timestamp_millis(),
        updated_at: settings.updated_at.and_utc().timestamp_millis(),
    })
}

async fn ensure_engine_eligible(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
) -> Result<(), AppError> {
    find_eligible_engine(dbx, ai_engine_id).await.map(|_| ())
}

async fn find_eligible_engine(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
) -> Result<ai_engine::Model, AppError> {
    ai_engine::Entity::find_by_id(ai_engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "Обраний ШІ движок вимкнено або він не підтримує обробку розвіддонесень".to_string(),
        })
}

fn parse_uuid(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BL {
        msg: "Некоректний UUID ШІ движка".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_user_prompt, ensure_engine_not_used,
        ensure_quick_suggestion_role, find_eligible_engine,
        generate_quick_suggestion, load_settings, load_style_examples,
        numeric_tokens, record_suggestion_attempt,
        request_suggestion_with_timeout, sanitize_example_source,
        validate_suggestion_response, validate_suggestions,
        SuggestionAttemptReview, SuggestionInput, SuggestionResult,
    };
    use crate::ai_engine::AiEngineResponse;
    use crate::entities::{
        ai_engine, ai_intel_report_attempt, datasource_group, intel_product,
        sigint_comment, signal_group, signal_message,
    };
    use chrono::{Duration, Utc};
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
        QueryOrder,
    };
    use std::time::Duration as StdDuration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use uuid::Uuid;

    fn engine_record(url: String) -> ai_engine::Model {
        let now = Utc::now().naive_utc();
        ai_engine::Model {
            id: Uuid::now_v7(),
            name: format!("intelligence-report-test-{}", Uuid::now_v7()),
            url,
            token: None,
            model_name: "test-model".to_string(),
            created_at: now,
            updated_at: now,
            enabled: true,
            callsign_enabled: true,
            ocr_enabled: false,
            ocr_request_profile: "openai_vision".to_string(),
        }
    }

    async fn read_json_request(
        stream: &mut tokio::net::TcpStream,
    ) -> serde_json::Value {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let bytes_read = stream.read(&mut chunk).await.unwrap();
            assert_ne!(bytes_read, 0);
            request.extend_from_slice(&chunk[..bytes_read]);
            let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
            else {
                continue;
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                .unwrap();
            if request.len() >= header_end + content_length {
                return serde_json::from_slice(
                    &request[header_end..header_end + content_length],
                )
                .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn structured_request_uses_one_bounded_schema_call() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_json_request(&mut stream).await;
            assert_eq!(request["model"], "test-model");
            assert_eq!(request["temperature"], 0.0);
            assert_eq!(request["max_tokens"], 512);
            assert_eq!(request["messages"].as_array().unwrap().len(), 2);
            assert_eq!(
                request["messages"][0]["content"],
                super::AI_INTEL_REPORT_PROMPT
            );
            assert_eq!(request["response_format"]["type"], "json_schema");
            assert_eq!(
                request["response_format"]["json_schema"]["strict"],
                true
            );
            let response = serde_json::json!({
                "model": "served-test-model",
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": r#"{"suggestions":["Політ БпЛА."]}"#
                    }
                }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let ai_engine = engine_record(format!("http://{address}/v1"));

        let response = request_suggestion_with_timeout(
            &ai_engine,
            "{}".to_string(),
            StdDuration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(response.content, r#"{"suggestions":["Політ БпЛА."]}"#);
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.model_name.as_deref(), Some("served-test-model"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn structured_request_obeys_hard_timeout() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(StdDuration::from_secs(1)).await;
        });
        let ai_engine = engine_record(format!("http://{address}/v1"));

        let result = request_suggestion_with_timeout(
            &ai_engine,
            "{}".to_string(),
            StdDuration::from_millis(25),
        )
        .await;

        assert!(matches!(
            result,
            Err(crate::error::AppError::ServiceUnavailable { .. })
        ));
        server.abort();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn records_successful_and_failed_attempts_for_admin_review() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let login = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let review = SuggestionAttemptReview {
            ai_engine_id: None,
            raw_response: Some(
                r#"{"suggestions":["Облаштування позицій"]}"#.to_string(),
            ),
        };
        let success = Ok(SuggestionResult::Suggestions(vec![
            "Облаштування позицій".to_string(),
        ]));
        record_suggestion_attempt(
            &env.dbx,
            login.id,
            3128366,
            StdDuration::from_millis(1500),
            &review,
            &success,
        )
        .await
        .unwrap();
        let failure = Err(anyhow::anyhow!("malformed structured output"));
        record_suggestion_attempt(
            &env.dbx,
            login.id,
            i64::MAX,
            StdDuration::from_millis(25),
            &SuggestionAttemptReview::default(),
            &failure,
        )
        .await
        .unwrap();

        let attempts = ai_intel_report_attempt::Entity::find()
            .order_by_asc(ai_intel_report_attempt::Column::CreatedAt)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].outcome, "success");
        assert_eq!(attempts[0].duration_ms, 1500);
        assert_eq!(
            attempts[0].suggestions,
            serde_json::json!(["Облаштування позицій"])
        );
        assert_eq!(attempts[0].raw_response, review.raw_response);
        assert_eq!(attempts[1].outcome, "failed");
        assert_eq!(attempts[1].source_message_id, i64::MAX);
        assert!(attempts[1]
            .error
            .as_deref()
            .unwrap()
            .contains("malformed structured output"));
    }

    async fn insert_example(
        dbx: &sea_orm::DatabaseConnection,
        datasource_group_id: i64,
        login_id: Uuid,
        source: &str,
        report: &str,
        created_at: chrono::NaiveDateTime,
    ) {
        let message = crate::functest::tests::mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(source.to_string())),
                datasource_group_id: Set(Some(datasource_group_id)),
                timestamp: Set(Some(created_at)),
                created_at: Set(created_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_comment::ActiveModel {
            id: sea_orm::ActiveValue::NotSet,
            login_id: Set(login_id),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            comment: Set(report.to_string()),
            created_at: Set(created_at),
            sigint_post_id: Set(None),
            migrated_signal_message_id: Set(None),
            migrated_signal_message_uuid: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    async fn insert_linked_product_example(
        dbx: &sea_orm::DatabaseConnection,
        datasource_group_id: i64,
        login_id: Uuid,
        source: &str,
        report: &str,
        source_created_at: chrono::NaiveDateTime,
        product_created_at: chrono::NaiveDateTime,
    ) {
        let source = crate::functest::tests::mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(source.to_string())),
                datasource_group_id: Set(Some(datasource_group_id)),
                timestamp: Set(Some(source_created_at)),
                created_at: Set(source_created_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let report = crate::functest::tests::mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(report.to_string())),
                sender: Set(Some(login_id.to_string())),
                timestamp: Set(Some(product_created_at)),
                created_at: Set(product_created_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        intel_product::ActiveModel {
            intel_message_id: Set(report.id),
            intel_message_uuid: Set(report.id_uuid),
            source_message_id: Set(source.id),
            source_message_uuid: Set(source.id_uuid),
            relation_kind: Set(intel_product::RELATION_KIND_REPORT),
            created_at: Set(product_created_at),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn quick_suggestion_allows_rer_or_cyber_roles_only() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let test_login = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();

        assert!(ensure_quick_suggestion_role(&env.dbx, &test_login.id)
            .await
            .is_ok());
        let mut test_login = test_login.into_active_model();
        test_login.roles = Set(serde_json::json!(["Cyber"]));
        let test_login = test_login.update(&env.dbx).await.unwrap();
        assert!(ensure_quick_suggestion_role(&env.dbx, &test_login.id)
            .await
            .is_ok());
        let mut test_login = test_login.into_active_model();
        test_login.roles = Set(serde_json::json!(["Basic"]));
        let test_login = test_login.update(&env.dbx).await.unwrap();
        assert!(ensure_quick_suggestion_role(&env.dbx, &test_login.id)
            .await
            .is_err());
    }

    #[test]
    fn redacts_numbers_from_style_sources() {
        let source = sanitize_example_source(
            "Дата: 19.08.2026\nБорт-12 летить до точки 49.1,37.2",
        );
        assert!(!source.chars().any(char::is_numeric));
        assert!(source.contains("[число]"));
    }

    #[test]
    fn rejects_numbers_absent_from_current_source() {
        assert!(validate_suggestions(
            r#"{"suggestions":["Виявлено 3 БпЛА"]}"#,
            &["Виявлено БпЛА".to_string()],
        )
        .is_err());
        assert!(validate_suggestions(
            r#"{"suggestions":["Виявлено 3 БпЛА"]}"#,
            &["Виявлено 3 БпЛА".to_string()],
        )
        .is_ok());
    }

    #[test]
    fn reports_token_truncation_separately_from_malformed_json() {
        let error = validate_suggestion_response(
            &AiEngineResponse {
                content: r#"{"suggestions":["Облаштування""#.to_string(),
                finish_reason: Some("length".to_string()),
                model_name: None,
            },
            &[],
        )
        .unwrap_err();

        match error {
            crate::error::AppError::BL { msg } => {
                assert!(msg.contains("truncated at token limit"));
            }
            error => panic!("unexpected error: {error:?}"),
        }
    }

    #[test]
    fn numeric_tokens_keep_coordinates_and_callsign_numbers_exact() {
        let tokens = numeric_tokens("49.123, 37.456 та БОРТ-12");
        assert!(tokens.contains("49.123"));
        assert!(tokens.contains("37.456"));
        assert!(tokens.contains("БОРТ-12"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn disabled_feature_returns_without_loading_the_source() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let settings = load_settings(&env.dbx).await.unwrap();
        let mut settings = settings.into_active_model();
        settings.quick_suggestion_enabled = Set(false);
        settings.quick_ai_engine_id = Set(None);
        settings.update(&env.dbx).await.unwrap();

        assert!(matches!(
            generate_quick_suggestion(&env, Uuid::now_v7(), i64::MAX)
                .await
                .unwrap(),
            SuggestionResult::Disabled
        ));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn quick_suggestion_accepts_an_accessible_report_message() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let login = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let visible_group =
            crate::functest::tests::find_test_datasource_group(&env.dbx)
                .await
                .unwrap();
        let now = Utc::now().naive_utc();
        let parent = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("Вихідне повідомлення".to_string())),
                datasource_group_id: Set(Some(visible_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let report = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("Облаштування позицій противника".to_string())),
                datasource_group_id: Set(Some(visible_group.id)),
                sender: Set(Some(login.id.to_string())),
                timestamp: Set(Some(now)),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        intel_product::ActiveModel {
            intel_message_id: Set(report.id),
            intel_message_uuid: Set(report.id_uuid),
            source_message_id: Set(parent.id),
            source_message_uuid: Set(parent.id_uuid),
            relation_kind: Set(intel_product::RELATION_KIND_REPORT),
            created_at: Set(now),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_json_request(&mut stream).await;
            let response = serde_json::json!({
                "model": "served-test-model",
                "choices": [{
                    "message": {
                        "content": r#"{"suggestions":["Облаштування позицій противника"]}"#
                    }
                }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let ai_engine = engine_record(format!("http://{address}/v1"))
            .into_active_model()
            .insert(&env.dbx)
            .await
            .unwrap();
        let settings = load_settings(&env.dbx).await.unwrap();
        let mut settings = settings.into_active_model();
        settings.quick_suggestion_enabled = Set(true);
        settings.quick_ai_engine_id = Set(Some(ai_engine.id));
        settings.update(&env.dbx).await.unwrap();

        let result = generate_quick_suggestion(&env, login.id, report.id)
            .await
            .unwrap();

        assert!(matches!(
            result,
            SuggestionResult::Suggestions(suggestions)
                if suggestions == ["Облаштування позицій противника"]
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn engine_must_be_enabled_and_support_intelligence_reports() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let insert_engine =
            |enabled, callsign_enabled| ai_engine::ActiveModel {
                id: Set(Uuid::now_v7()),
                name: Set(format!("intel-report-engine-{}", Uuid::now_v7())),
                url: Set("http://127.0.0.1:8000/v1".to_string()),
                token: Set(None),
                model_name: Set("test-model".to_string()),
                created_at: Set(now),
                updated_at: Set(now),
                enabled: Set(enabled),
                callsign_enabled: Set(callsign_enabled),
                ocr_enabled: Set(false),
                ocr_request_profile: Set("openai_vision".to_string()),
            };
        let disabled =
            insert_engine(false, true).insert(&env.dbx).await.unwrap();
        let unsupported =
            insert_engine(true, false).insert(&env.dbx).await.unwrap();
        let eligible =
            insert_engine(true, true).insert(&env.dbx).await.unwrap();

        assert!(find_eligible_engine(&env.dbx, disabled.id).await.is_err());
        assert!(find_eligible_engine(&env.dbx, unsupported.id)
            .await
            .is_err());
        assert_eq!(
            find_eligible_engine(&env.dbx, eligible.id)
                .await
                .unwrap()
                .id,
            eligible.id
        );

        let settings = load_settings(&env.dbx).await.unwrap();
        let mut settings = settings.into_active_model();
        settings.quick_suggestion_enabled = Set(true);
        settings.quick_ai_engine_id = Set(Some(eligible.id));
        settings.update(&env.dbx).await.unwrap();
        assert!(ensure_engine_not_used(&env.dbx, eligible.id).await.is_err());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn explicit_linked_product_is_a_same_user_example_immediately() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let login = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let visible_group =
            crate::functest::tests::find_test_datasource_group(&env.dbx)
                .await
                .unwrap();
        let now = Utc::now().naive_utc();
        insert_linked_product_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Противник зайняв позиції на точці 12",
            "Облаштування позицій противника",
            now - Duration::seconds(73),
            now - Duration::seconds(27),
        )
        .await;
        insert_linked_product_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Противник зайняв позиції на точці 13",
            "Зайняття позицій противником",
            now - Duration::seconds(72),
            now - Duration::seconds(26),
        )
        .await;
        for (index, label) in [
            "Альфа",
            "Браво",
            "Вега",
            "Гамма",
            "Дельта",
            "Ехо",
            "Жасмин",
            "Зеніт",
            "Ірис",
            "Каппа",
            "Ламбда",
        ]
        .into_iter()
        .enumerate()
        {
            insert_linked_product_example(
                &env.dbx,
                visible_group.id,
                login.id,
                &format!("Інше джерело {label}"),
                &format!("Інша категорія {label}"),
                now - Duration::minutes(2),
                now - Duration::seconds(25 - index as i64),
            )
            .await;
        }
        let target = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(
                    "Противник зайняв позиції на точці 12".to_string(),
                )),
                datasource_group_id: Set(Some(visible_group.id)),
                timestamp: Set(Some(now - Duration::seconds(40))),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let examples = load_style_examples(
            &env.dbx,
            &target,
            &[visible_group.group_master_key],
            &login.id,
            &[login.id],
        )
        .await
        .unwrap();

        assert_eq!(examples[0].report, "Облаштування позицій противника");
        assert!(examples[0].exact_source_match);
        assert!(!examples[1].exact_source_match);
        let prompt = build_user_prompt(Vec::new(), examples).unwrap();
        let input: SuggestionInput = serde_json::from_str(&prompt).unwrap();
        assert!(input.style_examples[0].exact_source_match);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn examples_include_new_products_and_obey_access_history_deduplication_and_bucket_limit(
    ) {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let login = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let visible_group =
            crate::functest::tests::find_test_datasource_group(&env.dbx)
                .await
                .unwrap();
        let hidden_signal_group = crate::functest::tests::mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set("hidden-intel-report-group".to_string()),
                datasource_id: Set(Some(visible_group.datasource_id)),
                name: Set(Some("Hidden intelligence-report group".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let hidden_group = crate::functest::tests::mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(hidden_signal_group.master_key),
                name: Set("Hidden intelligence-report group".to_string()),
                datasource_id: Set(visible_group.datasource_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let now = Utc::now().naive_utc();
        let target = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("Поточне повідомлення".to_string())),
                datasource_group_id: Set(Some(visible_group.id)),
                timestamp: Set(Some(now)),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        insert_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Перше джерело",
            "Перша подія",
            now - Duration::minutes(40),
        )
        .await;
        insert_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Повторне джерело",
            "Перша подія",
            now - Duration::minutes(42),
        )
        .await;
        insert_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Друге джерело",
            "Друга подія",
            now - Duration::minutes(44),
        )
        .await;
        insert_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Третє джерело",
            "Третя подія",
            now - Duration::minutes(46),
        )
        .await;
        insert_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Нове джерело",
            "Після відсічення",
            now - Duration::minutes(10),
        )
        .await;
        insert_example(
            &env.dbx,
            visible_group.id,
            login.id,
            "Давнє джерело",
            "Застаріла подія",
            now - Duration::days(4),
        )
        .await;
        insert_example(
            &env.dbx,
            hidden_group.id,
            login.id,
            "Недоступне джерело",
            "Недоступна подія",
            now - Duration::minutes(41),
        )
        .await;
        let examples = load_style_examples(
            &env.dbx,
            &target,
            &[visible_group.group_master_key],
            &login.id,
            &[login.id],
        )
        .await
        .unwrap();

        assert_eq!(examples.len(), 2);
        assert_eq!(examples[0].report, "Після відсічення");
        assert_eq!(examples[1].report, "Перша подія");
    }
}

use crate::config::ModelsConfig;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::storage;
use crate::storage::S3Config;
use crate::types::*;
use crate::types::{info, warn};
use crate::utils::worker_watch;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use lazy_static::lazy_static;
use opendal::{EntryMode, ErrorKind};
use regex::Regex;
use sea_orm::prelude::*;
use sea_orm::*;
use tokio_util::sync::CancellationToken;

const KEYWORDS_REGEX_MODEL_NAME: &str = "bot-navara-v1";
const NLP_MODEL_NAME_PREFIX: &str = "bot-willys-v";
const DEFAULT_MODEL_DIR: &str = "/usr/share/wdintel-py/fasttext-models-v2";

#[derive(Default)]
pub struct ProcessMessagesResult {
    pub inserted_count: u64,
    pub message_ids_for_events: BTreeSet<i64>,
}

#[derive(FromQueryResult)]
pub struct SigintInboxItemText {
    pub id: i64,
    pub body_noheader: Json,
}

lazy_static! {
    static ref RE_TRIM_BODY_PREFIX: Regex = Regex::new(r"^[^—]*—\s*").unwrap();
}

pub async fn suggest_message_tags_worker(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
    cancel_token: CancellationToken,
) {
    loop {
        if cancel_token.is_cancelled() {
            info!("cancel token received, stopping suggest_new_tags_worker...");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("suggest_new_tags_worker");

        let mut do_sleep = true;
        match process_suggest_message_tags(
            rq,
            dbx,
            redis,
            tag_keyword_regex_cache,
        )
        .await
        {
            Ok(processed_a_message) => {
                if processed_a_message {
                    do_sleep = false;
                }
            }
            Err(e) => {
                println!("suggest_new_tags_worker error: {e:#?}");
            }
        }
        if do_sleep {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
}

async fn get_messages(txn: &DatabaseTransaction) -> Result<Vec<i64>, AppError> {
    let subquery = format!(
        r#"
        SELECT "sigint_inbox_item_id" FROM "tag_suggestion_worker_queue"
        ORDER BY "sigint_inbox_item_id"
        FOR UPDATE SKIP LOCKED
        LIMIT {TAG_SUGGEST_WORKER_BATCH_SIZE}"#
    );

    let expr = Expr::cust(format!("sigint_inbox_item_id IN ({subquery})"));

    let items = tag_suggestion_worker_queue::Entity::delete_many()
        .filter(expr)
        .exec_with_returning(txn)
        .await
        .c(h!())?
        .into_iter()
        .map(|item| item.sigint_inbox_item_id)
        .collect();

    Ok(items)
}

async fn process_suggest_message_tags(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<bool, AppError> {
    let txn = dbx.begin().await.c(h!())?;

    let message_ids = get_messages(&txn).await.c(h!())?;
    if message_ids.is_empty() {
        Ok(false)
    } else {
        let result =
            process_messages(message_ids, rq, &txn, tag_keyword_regex_cache)
                .await
                .c(h!())?;
        txn.commit().await.c(h!())?;
        if result.inserted_count > 0
            && !result.message_ids_for_events.is_empty()
        {
            let events: Vec<EventMsg> = result
                .message_ids_for_events
                .into_iter()
                .map(EventType::ETInboxChanged)
                .map(EventMsg::new)
                .collect();
            fanout_mult(redis, events).await.c(h!())?;
        }
        Ok(true)
    }
}

async fn get_tags_to_predict<C: ConnectionTrait>(
    dbx: &C,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<HashMap<String, i64>, AppError> {
    {
        let read_lock = tag_keyword_regex_cache.read().unwrap();
        if !read_lock.tags_to_predict.is_empty() {
            let tags_to_predict = read_lock.tags_to_predict.clone();
            return Ok(tags_to_predict);
        }
    }

    let tags_to_predict: HashMap<String, i64> = tag::Entity::find()
        .select_only()
        .column(tag::Column::Label)
        .column(tag::Column::Id)
        .filter(tag::Column::Enabled.eq(true))
        .filter(tag::Column::OwnerOrganismId.is_null())
        .into_tuple::<(String, i64)>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect();

    {
        let mut write_lock = tag_keyword_regex_cache.write().unwrap();
        write_lock.tags_to_predict = tags_to_predict.clone();
    }

    Ok(tags_to_predict)
}

pub async fn process_messages<C: ConnectionTrait>(
    message_ids: Vec<i64>,
    rq: &reqwest::Client,
    dbx: &C,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<ProcessMessagesResult, AppError> {
    let system_login_id = crate::users::system_login_id(dbx).await.c(h!())?;
    let tags_to_predict = get_tags_to_predict(dbx, tag_keyword_regex_cache)
        .await
        .c(h!())?;

    let inbox_items = sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.eq_any(message_ids))
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::BodyNoheader)
        .into_model::<SigintInboxItemText>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut texts: Vec<String> = Vec::with_capacity(inbox_items.len());
    for item in inbox_items.iter() {
        let parsed_body: NoHeadersBody =
            serde_json::from_value(item.body_noheader.clone()).c(h!())?;

        let text: String = RE_TRIM_BODY_PREFIX
            .replace(&parsed_body.body, "")
            .to_lowercase();
        texts.push(text);
    }

    let mut skip_nlp_tag_id_message_id: HashSet<(i64, i64)> = HashSet::new();

    let mut message_tags: Vec<sigint_inbox_item_tag::ActiveModel> = vec![];
    let mut message_ids_for_events: BTreeSet<i64> = BTreeSet::new();

    for &tag_id in tags_to_predict.values() {
        let cache_item =
            get_regex_sets_for_tag(tag_id, dbx, tag_keyword_regex_cache)
                .await
                .c(h!())?;

        for (index, text) in texts.iter().enumerate() {
            let message_id = inbox_items[index].id;

            if cache_item.regex_set_negative.is_match(text.as_str()) {
                skip_nlp_tag_id_message_id.insert((tag_id, message_id));
            } else if cache_item.regex_set_positive.is_match(text.as_str()) {
                skip_nlp_tag_id_message_id.insert((tag_id, message_id));
                let login = Some(system_login_id);
                let model = Some(KEYWORDS_REGEX_MODEL_NAME.to_owned());
                let model = sigint_inbox_item_tag::ActiveModel {
                    tag_id: Set(tag_id),
                    sigint_inbox_item_id: Set(message_id),
                    login_id: Set(login),
                    model: Set(model),
                    confidence: Set(TAG_SUGGEST_WORKER_REGEX_CONFIDENCE),
                    ..Default::default()
                };
                message_tags.push(model);
                message_ids_for_events.insert(message_id);
            }
        }
    }

    let response = crate::nlp::predict_tags(
        rq,
        texts,
        Some(tags_to_predict.keys().cloned().collect()),
    )
    .await
    .c(h!())?;

    for (index, result) in response.iter().enumerate() {
        let message_id = inbox_items[index].id;
        for (key, res) in &result.0 {
            let tag_id = tags_to_predict[key];
            if !skip_nlp_tag_id_message_id.contains(&(tag_id, message_id)) {
                let confidence: f64 = res.probability;
                let login = Some(system_login_id);
                let model =
                    format!("{}{}", NLP_MODEL_NAME_PREFIX, res.model_version);
                let model = sigint_inbox_item_tag::ActiveModel {
                    tag_id: Set(tag_id),
                    sigint_inbox_item_id: Set(message_id),
                    login_id: Set(login),
                    model: Set(Some(model)),
                    confidence: Set(confidence),
                    ..Default::default()
                };
                message_tags.push(model);
                message_ids_for_events.insert(message_id);
            }
        }
    }

    if message_tags.is_empty() {
        Ok(ProcessMessagesResult::default())
    } else {
        let suggestions_count = message_tags.len();
        let result = sigint_inbox_item_tag::Entity::insert_many(message_tags)
            .on_conflict_do_nothing_on([
                sigint_inbox_item_tag::Column::SigintInboxItemId,
                sigint_inbox_item_tag::Column::TagId,
                sigint_inbox_item_tag::Column::LoginId,
                sigint_inbox_item_tag::Column::Model,
            ])
            .exec_without_returning(dbx)
            .await
            .c(h!())?;

        let message_count = inbox_items.len();

        match result {
            TryInsertResult::Conflicted => {
                warn!(
                    "ignored {suggestions_count} conflicting tag suggestions for {message_count} messages"
                );
                Ok(ProcessMessagesResult::default())
            }
            TryInsertResult::Inserted(count) => Ok(ProcessMessagesResult {
                inserted_count: count,
                message_ids_for_events,
            }),
            TryInsertResult::Empty => Ok(ProcessMessagesResult::default()),
        }
    }
}

async fn get_regex_sets_for_tag<C: ConnectionTrait>(
    tag_id: i64,
    dbx: &C,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<TagKeywordRegexCacheItem, AppError> {
    {
        let lock = tag_keyword_regex_cache.read().unwrap();
        if let Some(item) = lock.keywords_regex_per_tag.get(&tag_id) {
            return Ok(item.clone());
        }
    }

    let keywords = tag_keyword::Entity::find()
        .filter(tag_keyword::Column::TagId.eq(tag_id))
        .all(dbx)
        .await
        .c(h!())?;

    let mut patterns_positive = vec![];
    let mut patterns_negative = vec![];
    for model in keywords {
        let tag_keyword::Model {
            is_regex,
            mut keyword_forms,
            mut keyword_negative_forms,
            ..
        } = model;

        if is_regex {
            patterns_positive.append(&mut keyword_forms);
        } else {
            for literal in keyword_forms {
                let escaped = regex::escape(&literal);
                patterns_positive.push(escaped);
            }
        }

        if is_regex {
            patterns_negative.append(&mut keyword_negative_forms);
        } else {
            for literal in keyword_negative_forms {
                let escaped = regex::escape(&literal);
                patterns_negative.push(escaped);
            }
        }
    }

    let item = TagKeywordRegexCacheItem {
        regex_set_positive: regex::RegexSetBuilder::new(patterns_positive)
            .build()
            .c(h!())?,
        regex_set_negative: regex::RegexSetBuilder::new(patterns_negative)
            .build()
            .c(h!())?,
    };

    {
        let mut lock = tag_keyword_regex_cache.write().unwrap();
        lock.keywords_regex_per_tag.insert(tag_id, item.clone());
    }

    let num_positive_patterns = item.regex_set_positive.len();
    let num_negative_patterns = item.regex_set_negative.len();
    info!(
        "created regex sets for tag_id {tag_id}, num_positive_patterns {num_positive_patterns}, num_negative_patterns {num_negative_patterns}"
    );
    Ok(item)
}

pub async fn refresh_models_worker_nofail(
    config: ModelsConfig,
    cancel_token: CancellationToken,
) {
    let s3_config = S3Config::with_prefix(&config.s3_config, config.prefix);

    let model_dir = config
        .directory
        .or_else(|| std::env::var("WD_FASTTEXT_MODELS").ok())
        .unwrap_or_else(|| DEFAULT_MODEL_DIR.to_string());

    info!("refresh_models_worker started...");
    loop {
        if cancel_token.is_cancelled() {
            info!("cancel token received, stopping refresh_models_worker...");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("refresh_models_worker");

        match do_refresh_models(&s3_config, &model_dir).await {
            Ok(updated) => {
                if updated {
                    if let Err(e) = crate::oneoff::restart_process("wdintel-py")
                    {
                        error!("failed to restart wdintel-py: {:#}", e);
                    };
                }
            }
            Err(e) => error!("failed to refresh models: {:#}", e),
        }

        tokio::time::sleep(std::time::Duration::from_mins(30)).await;
    }
}

pub async fn oneoff_refresh_models(mode: Mode) -> Result<(), AppError> {
    let config = read_config(mode).context(h!())?;
    let models_config = config
        .ai_models_config
        .expect("ai_models_config is missing");
    let s3_config =
        S3Config::with_prefix(&models_config.s3_config, models_config.prefix);

    let model_dir = models_config
        .directory
        .or_else(|| std::env::var("WD_FASTTEXT_MODELS").ok())
        .unwrap_or_else(|| DEFAULT_MODEL_DIR.to_string());

    let changed = do_refresh_models(&s3_config, &model_dir).await?;
    if changed {
        println!("downloaded new models");
    } else {
        println!("no changes to models detected");
    }

    Ok(())
}

async fn do_refresh_models(
    s3_config: &storage::S3Config,
    model_dir: &str,
) -> Result<bool, anyhow::Error> {
    let destination_path = PathBuf::from(model_dir);
    std::fs::create_dir_all(&destination_path)?;
    let destination = destination_path.to_str().unwrap();

    let mut temp_path = PathBuf::from(model_dir);
    temp_path.push(".tmp");
    std::fs::create_dir_all(&temp_path)?;
    let temp_dir = temp_path.to_str().unwrap();

    let remote_operator = storage::build_s3_operator(s3_config).c(h!())?;
    let fs_builder = opendal::services::Fs::default()
        .root(destination)
        .atomic_write_dir(temp_dir);

    let local_operator = opendal::Operator::new(fs_builder)?.finish();

    let items = remote_operator.list(&s3_config.prefix).await.c(h!())?;
    let mut updated = false;
    for item in items {
        if item.metadata().mode() == EntryMode::FILE {
            let remote_name = item.name();
            let mut if_modified_since: Option<DateTime<Utc>> = None;
            if let Ok(local_metadata) = local_operator.stat(remote_name).await {
                if_modified_since = local_metadata.last_modified()
            }

            let reader = if let Some(if_modified_since) = if_modified_since {
                let reader_result = remote_operator
                    .reader_with(item.path())
                    .if_modified_since(if_modified_since)
                    .await;

                match reader_result {
                    Ok(reader) => reader,
                    Err(e) if e.kind() == ErrorKind::ConditionNotMatch => {
                        info!(
                            "model file '{}' unchanged, skipping...",
                            remote_name
                        );
                        continue;
                    }
                    Err(e) => return Err(e.into()),
                }
            } else {
                remote_operator.reader(item.path()).await.c(h!())?
            };
            info!("downloading model file '{}'...", remote_name);

            let mut writer: Option<opendal::Writer> = None;
            let mut stream = reader.into_bytes_stream(..).await.c(h!())?;

            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) => {
                        if let Some(w) = &mut writer {
                            w.write(chunk).await.c(h!())?;
                        } else {
                            let mut w = local_operator
                                .writer(remote_name)
                                .await
                                .c(h!())?;
                            w.write(chunk).await.c(h!())?;
                            writer = Some(w);
                        }
                    }
                    Err(e) => match e.downcast::<opendal::Error>() {
                        Ok(not_match_error)
                            if not_match_error.kind()
                                == ErrorKind::ConditionNotMatch =>
                        {
                            info!(
                                "model file '{}' unchanged, skipping...",
                                remote_name
                            );
                            continue;
                        }
                        Ok(opendal_error) => return Err(opendal_error.into()),
                        Err(e) => return Err(e.into()),
                    },
                }
            }
            if let Some(w) = &mut writer {
                w.close().await.c(h!())?;
                updated = true;
                if let Some(modified) = item.metadata().last_modified() {
                    let local_path = destination_path.join(remote_name);
                    let file = std::fs::File::open(&local_path)?;
                    file.set_modified(modified.into())?;
                }
            }
        }
    }

    Ok(updated)
}

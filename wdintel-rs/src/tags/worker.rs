use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::worker_watch;
use echo_migration::OnConflict;
use lazy_static::lazy_static;
use log::{error, info};
use regex::Regex;
use sea_orm::prelude::*;
use sea_orm::*;
use tokio_util::sync::CancellationToken;

const KEYWORDS_REGEX_MODEL_NAME: &str = "bot-navara-v1";
const NLP_MODEL_NAME: &str = "bot-willys-v1";

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
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
    cancel_token: CancellationToken,
) {
    if let Ok(tags) = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .all(dbx)
        .await
    {
        loop {
            if cancel_token.is_cancelled() {
                info!("cancel token received, stopping suggest_new_tags_worker...");
                break;
            }
            let _loop_guard =
                worker_watch::loop_guard("suggest_new_tags_worker");

            let mut do_sleep = true;
            match process_suggest_message_tags(
                &tags,
                rq,
                dbx,
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
    } else {
        error!(
            "loading enabled tags failed, stopping suggest_new_tags_worker..."
        );
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
    tags: &[tag::Model],
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<bool, AppError> {
    let txn = dbx.begin().await.c(h!())?;

    let message_ids = get_messages(&txn).await.c(h!())?;
    if message_ids.is_empty() {
        Ok(false)
    } else {
        process_messages(message_ids, tags, rq, &txn, tag_keyword_regex_cache)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;
        Ok(true)
    }
}

pub async fn process_messages<C: ConnectionTrait>(
    message_ids: Vec<i64>,
    tags: &[tag::Model],
    rq: &reqwest::Client,
    dbx: &C,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<u64, AppError> {
    let inbox_items = sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.eq_any(message_ids))
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .select_only()
        .select_column(sigint_inbox_item::Column::Id)
        .select_column(sigint_inbox_item::Column::BodyNoheader)
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

    let mut regex_tags: HashSet<(i64, i64)> = HashSet::new();
    let mut message_tags: Vec<sigint_inbox_item_tag::ActiveModel> = vec![];

    let mut tags_to_predict: HashMap<String, i64> = HashMap::new();
    for tag in tags.iter() {
        let tag_id = tag.id;
        tags_to_predict.insert(tag.label.clone(), tag_id);

        let cache_item =
            get_regex_sets_for_tag(tag_id, dbx, tag_keyword_regex_cache)
                .await
                .c(h!())?;

        for (index, text) in texts.iter().enumerate() {
            let message_id = inbox_items[index].id;
            let tag_matches =
                !cache_item.regex_set_negative.is_match(text.as_str())
                    && cache_item.regex_set_positive.is_match(text.as_str());
            if tag_matches {
                regex_tags.insert((tag_id, message_id));
                let login = Some(SYSTEM_LOGIN_NAME.to_string());
                let model = Some(KEYWORDS_REGEX_MODEL_NAME.to_owned());
                let model = sigint_inbox_item_tag::ActiveModel {
                    tag_id: Set(tag_id),
                    sigint_inbox_item_id: Set(message_id),
                    login: Set(login),
                    model: Set(model),
                    ..Default::default()
                };
                message_tags.push(model);
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
        for (key, value) in &result.0 {
            let tag_id = tags_to_predict[key];
            if !regex_tags.contains(&(tag_id, message_id)) {
                let confidence: f64 = *value;
                let login = Some(SYSTEM_LOGIN_NAME.to_string());
                let model = Some(NLP_MODEL_NAME.to_owned());
                let model = sigint_inbox_item_tag::ActiveModel {
                    tag_id: Set(tag_id),
                    sigint_inbox_item_id: Set(message_id),
                    login: Set(login),
                    model: Set(model),
                    confidence: Set(confidence),
                    ..Default::default()
                };
                message_tags.push(model);
            }
        }
    }

    if message_tags.is_empty() {
        Ok(0)
    } else {
        let suggestions_count = message_tags.len();
        let result = sigint_inbox_item_tag::Entity::insert_many(message_tags)
            .on_conflict(
                OnConflict::columns([
                    sigint_inbox_item_tag::Column::SigintInboxItemId,
                    sigint_inbox_item_tag::Column::TagId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .do_nothing()
            .exec_without_returning(dbx)
            .await
            .c(h!())?;

        let message_count = inbox_items.len();

        match result {
            TryInsertResult::Conflicted => {
                warn!("ignored {suggestions_count} conflicting tag suggestions for {message_count} messages");
                Ok(0)
            }
            TryInsertResult::Inserted(count) => Ok(count),
            TryInsertResult::Empty => Ok(0),
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
        .order_by_asc(tag_keyword::Column::IsPositive)
        .all(dbx)
        .await
        .c(h!())?;

    let mut patterns_positive = vec![];
    let mut patterns_negative = vec![];
    for model in keywords {
        let tag_keyword::Model {
            is_positive,
            is_regex,
            mut keyword,
            mut keyword_forms,
            ..
        } = model;

        let patterns = match is_positive {
            true => &mut patterns_positive,
            false => &mut patterns_negative,
        };

        if keyword_forms.is_empty() {
            if !is_regex {
                keyword = regex::escape(&keyword);
            }
            patterns.push(keyword);
        } else if is_regex {
            patterns.append(&mut keyword_forms);
        } else {
            for literal in keyword_forms {
                let escaped = regex::escape(&literal);
                patterns.push(escaped);
            }
        }
    }

    let item = TagKeywordRegexCacheItem {
        regex_set_positive: regex::RegexSetBuilder::new(patterns_positive)
            .case_insensitive(true)
            .build()
            .c(h!())?,
        regex_set_negative: regex::RegexSetBuilder::new(patterns_negative)
            .case_insensitive(true)
            .build()
            .c(h!())?,
    };

    {
        let mut lock = tag_keyword_regex_cache.write().unwrap();
        lock.keywords_regex_per_tag.insert(tag_id, item.clone());
    }

    let num_positive_patterns = item.regex_set_positive.len();
    let num_negative_patterns = item.regex_set_negative.len();
    info!("created regex sets for tag_id {tag_id}, num_positive_patterns {num_positive_patterns}, num_negative_patterns {num_negative_patterns}");
    Ok(item)
}

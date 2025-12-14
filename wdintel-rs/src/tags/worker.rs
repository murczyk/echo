use crate::entities::*;
use crate::error::AppError;
use crate::config::SYSTEM_LOGIN_NAME;
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::types::*;
use crate::utils::worker_watch;
use echo_migration::OnConflict;
use lazy_static::lazy_static;
use log::{error, info};
use regex::Regex;
use sea_orm::prelude::*;
use sea_orm::*;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const KEYWORDS_REGEX_MODEL_NAME: &str = "keywords-and-regex 0.1.0";
const NLP_MODEL_NAME: &str = "nlp-fasttext 0.1.0";

#[derive(FromQueryResult)]
pub struct SigintInboxItemText {
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

async fn get_message(
    txn: &DatabaseTransaction,
) -> Result<Option<(i64, String)>, AppError> {
    let subquery = r#"
        SELECT "sigint_inbox_item_id" FROM "tag_suggestion_worker_queue"
        ORDER BY "sigint_inbox_item_id" 
        FOR UPDATE SKIP LOCKED 
        LIMIT 1"#;

    let expr = Expr::cust(format!("sigint_inbox_item_id = ({subquery})"));

    let mut items = tag_suggestion_worker_queue::Entity::delete_many()
        .filter(expr)
        .exec_with_returning(txn)
        .await
        .c(h!())?;

    if let Some(item) = items.pop() {
        let sigint_inbox_item_id = item.sigint_inbox_item_id;

        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
                .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
                .select_only()
                .select_column(sigint_inbox_item::Column::BodyNoheader)
                .into_model::<SigintInboxItemText>()
                .one(txn)
                .await
                .c(h!())?;

        if let Some(inner) = inbox_item {
            let parsed_body: NoHeadersBody =
                serde_json::from_value(inner.body_noheader).c(h!())?;

            let trimmed_lowercase_body: String = RE_TRIM_BODY_PREFIX
                .replace(&parsed_body.body, "")
                .to_lowercase();

            return Ok(Some((sigint_inbox_item_id, trimmed_lowercase_body)));
        }
    }

    Ok(None)
}

async fn process_suggest_message_tags(
    tags: &[tag::Model],
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<bool, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    if let Some((message_id, text)) = get_message(&txn).await.c(h!())? {
        let mut join_set = JoinSet::new();

        let text = Arc::new(text);

        let mut tags_to_predict: HashMap<String, i64> = HashMap::new();
        for (tag_index, tag) in tags.iter().enumerate() {
            let tag_id = tag.id;
            tags_to_predict.insert(tag.label.clone(), tag_id);
            join_set.spawn(verify_tag(
                text.clone(),
                tag_index,
                tag_id,
                dbx.clone(),
                tag_keyword_regex_cache.clone(),
            ));
        }

        let mut message_tags: Vec<sigint_inbox_item_tag::ActiveModel> = vec![];

        while let Some(join_result) = join_set.join_next().await {
            let verify_result = join_result.c(h!())?;
            let (tag_index, tag_id, tag_matches) = verify_result.c(h!())?;

            if tag_matches {
                let tag = &tags[tag_index];
                tags_to_predict.remove(&tag.label);

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

        if !tags_to_predict.is_empty() {
            let texts = vec![text.as_ref().clone()];
            let tags_filtered: HashSet<String> =
                tags_to_predict.keys().cloned().collect();

            let mut response =
                crate::nlp::predict_tags(rq, texts, Some(tags_filtered))
                    .await
                    .c(h!())?;
            if let Some(result) = response.pop() {
                for (key, value) in &result.0 {
                    let tag_id = tags_to_predict[key];
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

        sigint_inbox_item_tag::Entity::insert_many(message_tags)
            .on_conflict(
                OnConflict::columns([
                    sigint_inbox_item_tag::Column::SigintInboxItemId,
                    sigint_inbox_item_tag::Column::TagId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .do_nothing()
            .exec(dbx)
            .await
            .c(h!())?;

        txn.commit().await.c(h!())?;
        Ok(true)
    } else {
        Ok(false)
    }
}

async fn verify_tag(
    haystack: Arc<String>,
    tag_index: usize,
    tag_id: i64,
    dbx: DatabaseConnection,
    tag_keyword_regex_cache: Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<(usize, i64, bool), AppError> {
    let cache_item =
        get_regex_sets_for_tag(tag_id, &dbx, &tag_keyword_regex_cache)
            .await
            .c(h!())?;

    let tag_matches =
        !cache_item.regex_set_negative.is_match(haystack.as_str())
            && cache_item.regex_set_positive.is_match(haystack.as_str());

    Ok((tag_index, tag_id, tag_matches))
}

async fn get_regex_sets_for_tag(
    tag_id: i64,
    dbx: &DatabaseConnection,
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

use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::worker_watch;
use echo_migration::OnConflict;
use log::info;
use sea_orm::DatabaseConnection;
use sea_orm::*;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub async fn suggest_message_tags_worker(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
    cancel_token: CancellationToken,
) {
    loop {
        if cancel_token.is_cancelled() {
            info!("cancel token received, stopping suggest_new_tags_worker...");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("suggest_new_tags_worker");

        match process_suggest_message_tags(rq, dbx, tag_keyword_regex_cache)
            .await
        {
            Ok(_) => {}
            Err(e) => {
                println!("suggest_new_tags_worker error: {e:#?}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

async fn process_suggest_message_tags(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<(), AppError> {
    let tags = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .all(dbx)
        .await
        .c(h!())?;

    let mut join_set = JoinSet::new();

    let text = Arc::new("Выезжайте вам в водное деревне Бобрушовка, возле улицы Мичурина, в канале тонет человек, 2 метра от берега.".to_lowercase());
    for tag in tags {
        let tag_id = tag.id;
        join_set.spawn(verify_tag(
            text.clone(),
            tag_id,
            dbx.clone(),
            tag_keyword_regex_cache.clone(),
        ));
    }

    let message_id: i64 = 3015445;
    let mut message_tags: Vec<sigint_inbox_item_tag::ActiveModel> = vec![];

    while let Some(join_result) = join_set.join_next().await {
        let verify_result = join_result.c(h!())?;
        let (tag_id, tag_matches) = verify_result.c(h!())?;

        info!("tag_id={tag_id}, tag_matches={tag_matches}");

        if tag_matches {
            let login = Some("system".to_string());
            let model = Some("keywords-and-regex 0.1.0".to_owned());
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

    sigint_inbox_item_tag::Entity::insert_many(message_tags)
        .on_conflict(
            OnConflict::columns([
                sigint_inbox_item_tag::Column::SigintInboxItemId,
                sigint_inbox_item_tag::Column::TagId,
            ])
            .update_columns([
                sigint_inbox_item_tag::Column::Login,
                sigint_inbox_item_tag::Column::Model,
                sigint_inbox_item_tag::Column::Confidence,
            ])
            .to_owned(),
        )
        .exec(dbx)
        .await
        .c(h!())?;

    Ok(())
}

async fn verify_tag(
    haystack: Arc<String>,
    tag_id: i64,
    dbx: DatabaseConnection,
    tag_keyword_regex_cache: Arc<RwLock<TagKeywordRegexCache>>,
) -> Result<(i64, bool), AppError> {
    let cache_item =
        get_regex_sets_for_tag(tag_id, &dbx, &tag_keyword_regex_cache)
            .await
            .c(h!())?;

    let tag_matches =
        !cache_item.regex_set_negative.is_match(haystack.as_str())
            && cache_item.regex_set_positive.is_match(haystack.as_str());

    Ok((tag_id, tag_matches))
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
            keyword,
            mut keyword_forms,
            ..
        } = model;

        let patterns = match is_positive {
            true => &mut patterns_positive,
            false => &mut patterns_negative,
        };

        if keyword_forms.is_empty() {
            patterns.push(keyword);
        } else {
            patterns.append(&mut keyword_forms);
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

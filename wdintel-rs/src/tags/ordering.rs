use crate::entities::{login, tag, tags_ordering};
use crate::error::AppError;
use crate::h;
use crate::types::Mode;
use anyhow::Context;
use chrono::Utc;
use itertools::Itertools;
use log::info;
use rand::Rng;
use sea_orm::*;
use std::collections::BTreeMap;

type OrderingData = Vec<i64>;

pub async fn collect_tags_list(
    user_id: &str,
    db: &DatabaseConnection,
) -> anyhow::Result<Vec<tag::Model>> {
    let (tag_ids_list, tags) =
        collect_enabled_regular_tags(db).await.context(h!())?;
    let ordering =
        ensure_matching_ordering(user_id, db, tag_ids_list, &tags).await?;
    let mut regular_tags = order_tags(tags, &ordering).context(h!())?;
    let mut extra_tags = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .filter(tag::Column::Extra.eq(true))
        .order_by_asc(tag::Column::Ord)
        .all(db)
        .await
        .context(h!())?;
    regular_tags.append(&mut extra_tags);
    Ok(regular_tags)
}

#[tokio::main]
pub async fn oneoff_ensure_tags_ordering(mode: Mode) -> Result<(), AppError> {
    info!("> oneoff_ensure_tags_ordering start");
    let db = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let (tag_ids_string, tags) =
        collect_enabled_regular_tags(&db).await.context(h!())?;
    let logins = login::Entity::find()
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .all(&db)
        .await
        .context(h!())?;
    for login in logins {
        info!("> ensure_matching_ordering for {login}");
        ensure_matching_ordering(&login, &db, tag_ids_string.clone(), &tags)
            .await?;
    }
    info!("> oneoff_ensure_tags_ordering completed");
    Ok(())
}

async fn ensure_matching_ordering(
    user_id: &str,
    db: &DatabaseConnection,
    tag_ids_string: String,
    tags: &BTreeMap<i64, tag::Model>,
) -> anyhow::Result<tags_ordering::Model> {
    let mut matching_ordering = None;
    let orderings = tags_ordering::Entity::find()
        .filter(tags_ordering::Column::Login.eq(user_id))
        .filter(tags_ordering::Column::DeprecatedAt.is_null())
        .all(db)
        .await
        .context(h!())?;
    for o in orderings.into_iter() {
        if tag_ids_string.eq(&o.tag_ids_list) {
            matching_ordering = Some(o);
        } else {
            // deactivate deprecated because now other tags are enabled
            let mut model = o.into_active_model();
            model.deprecated_at = Set(Some(Utc::now().naive_utc()));
            model.update(db).await.context(h!())?;
        }
    }
    let ordering = match matching_ordering {
        Some(ordering) => ordering,
        None => mk_new_ordering(tag_ids_string, tags, user_id, db)
            .await
            .context(h!())?,
    };
    Ok(ordering)
}

async fn collect_enabled_regular_tags(
    db: &DatabaseConnection,
) -> anyhow::Result<(String, BTreeMap<i64, tag::Model>)> {
    let tags = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .filter(tag::Column::Extra.eq(false))
        .order_by_asc(tag::Column::Ord)
        .all(db)
        .await
        .context(h!())?;
    let tag_ids_string = tags
        .iter()
        .map(|x| format!("{}", x.id))
        .reduce(|a, b| format!("{a},{b}"))
        .unwrap_or_default();
    let tags = tags
        .into_iter()
        .map(|x| (x.id, x))
        .collect::<BTreeMap<_, _>>();
    Ok((tag_ids_string, tags))
}

/// collect live known seeds in order to avoid duplicate ordering.
async fn mk_new_ordering(
    tag_ids_list: String,
    tags: &BTreeMap<i64, tag::Model>,
    user_id: &str,
    db: &DatabaseConnection,
) -> anyhow::Result<tags_ordering::Model> {
    let known_seeds = tags_ordering::Entity::find()
        .filter(tags_ordering::Column::DeprecatedAt.is_null())
        .select_only()
        .column(tags_ordering::Column::Seed)
        .into_tuple::<String>()
        .all(db)
        .await
        .context(h!())?;
    let (ordering, seed) =
        arrange_tags(tags, known_seeds.clone()).context(h!())?;

    let ordering = serde_json::to_value(ordering)?;

    tags_ordering::ActiveModel {
        ordering: Set(ordering),
        tag_ids_list: Set(tag_ids_list),
        seed: Set(seed),
        login: Set(user_id.to_string()),
        id: NotSet,
        created_at: NotSet,
        deprecated_at: NotSet,
    }
    .insert(db)
    .await
    .context(h!())
}

/// split into groups of 8, because 8! order permutations is enough to have a unique user id, and also we're mot sure if >8 is visible.
/// seed is a value between 0 and (n!-1), where n is size of tags array.
/// seeds from 2 arrays are joined with '-' sign.
/// we persist seeds to reduce collisions in ordering.
/// if seed already exists in db - we do few more attempts in order to reduce collisions.
fn arrange_tags(
    tags: &BTreeMap<i64, tag::Model>,
    known_seeds: Vec<String>,
) -> anyhow::Result<(OrderingData, String)> {
    let mut fuel = 10;
    let mut result_ordering = OrderingData::default();
    let mut result_seed = String::default();
    while fuel > 0 {
        fuel -= 1;
        let mut seed_entries = vec![];
        let mut result = vec![];

        let mut tags = tags.clone().into_iter().collect_vec();
        tags.sort_by_key(|(ord, _)| *ord);
        let tags_sorted = tags.into_iter().map(|x| x.1.clone()).collect_vec();

        let mut tags = vec![];
        for tag in tags_sorted {
            tags.push(tag);
            if tags.len() == 8 {
                let (tags_sorted_val, seed) =
                    arrange_tags_vec(tags).context(h!())?;
                seed_entries.push(seed);
                for tag in tags_sorted_val {
                    result.push(tag);
                }
                tags = vec![];
            }
        }
        if !tags.is_empty() {
            let (tags_sorted_val, seed) =
                arrange_tags_vec(tags).context(h!())?;
            seed_entries.push(seed);
            for tag in tags_sorted_val {
                result.push(tag);
            }
        }
        result_ordering = result.into_iter().map(|x| x.id).collect_vec();
        result_seed = seed_entries.into_iter().next().context(h!())?;
        if !known_seeds.contains(&result_seed) {
            break;
        }
    }
    Ok((result_ordering, result_seed))
}

/// details on ordering algorithm:
/// we have array of n elements, so we have n! ways of arrange elements in array; let's call each way a permutation.
/// so we just pick one random permutation out of n! and order elements accordingly.
fn arrange_tags_vec(
    tags: Vec<tag::Model>,
) -> anyhow::Result<(Vec<tag::Model>, String)> {
    let factorials = factorials(tags.len() as i32);
    let max_value = factorials[tags.len()];
    let seed = rand::rng().random_range(0..max_value) as usize;
    let mut index_array = vec![];
    let mut idx = 0;
    while idx < tags.len() {
        index_array.push(idx);
        idx += 1;
    }
    let ordering = get_permutation(seed, index_array);
    let mut result = tags.clone();
    let mut idx = 0;
    while idx < tags.len() {
        let new_idx = ordering[idx];
        let new_element = tags.get(idx).context(h!())?;
        result[new_idx] = new_element.clone();
        idx += 1;
    }
    Ok((result, seed.to_string()))
}

fn order_tags(
    tags: BTreeMap<i64, tag::Model>,
    ordering: &tags_ordering::Model,
) -> anyhow::Result<Vec<tag::Model>> {
    let ids_ordering: OrderingData =
        serde_json::from_value(ordering.ordering.clone()).context(h!())?;
    let mut result = vec![];
    for id in ids_ordering {
        let tag = tags.get(&id).context(h!())?;
        result.push(tag.clone());
    }
    Ok(result)
}

fn factorials(num: i32) -> Vec<i32> {
    let mut factorials = vec![1];
    let mut i = 1;
    let mut factorial = 1;
    while i <= num {
        factorial *= i;
        factorials.push(factorial);
        i += 1;
    }
    factorials
}

/// Constructs the permutation. Use the remainders to construct the permutation.
/// Steps in detail:
///
/// Repeated division and remainder:
///
/// 355 / 6! (720) = 0 remainder 355
/// 355 / 5! (120) = 2 remainder 115
/// 115 / 4! (24) = 4 remainder 19
/// 19 / 3! (6) = 3 remainder 1
/// 1 / 2! (2) = 0 remainder 1
/// 1 / 1! (1) = 1 remainder 0
/// 0 / 0! (1) = 0 remainder 0
/// So, the remainders are 0, 2, 4, 3, 0, 1, 0.
///
/// Construct the permutation:
///
/// Start with the original items in order (e.g., [A, B, C, D, E, F, G]).
/// The first remainder (0) means take the 0th element (A) and place it first in the permutation.
/// Remove that element from the original list.
/// The second remainder (2) means take the 2nd element from the remaining list and place it next.
/// Continue this process.
/// Here's how it plays out:
///
/// Remainders: 0, 2, 4, 3, 0, 1, 0
/// Initial list: [A, B, C, D, E, F, G]
/// 1st: 0 -> A, Remaining: [B, C, D, E, F, G]
/// 2nd: 2 -> D, Remaining: [B, C, E, F, G]
/// 3rd: 4 -> G, Remaining: [B, C, E, F]
/// 4th: 3 -> F, Remaining: [B, C, E]
/// 5th: 0 -> B, Remaining: [C, E]
/// 6th: 1 -> E, Remaining: \[C\]
/// 7th: 0 -> C, Remaining: []
/// Therefore, the permutation corresponding to option #356 is [A, D, G, F, B, E, C].
fn get_permutation(n: usize, items: Vec<usize>) -> Vec<usize> {
    let mut n = n;
    let mut factorials: Vec<usize> = Vec::new();
    let mut factorial = 1;
    factorials.push(1);

    for i in 1..items.len() {
        factorial *= i;
        factorials.push(factorial);
    }
    factorials.reverse();

    let mut result: Vec<usize> = Vec::new();
    let mut remaining_items: Vec<usize> = items.to_vec();

    for factorial in factorials {
        let index = n / factorial;
        result.push(remaining_items.remove(index));
        n %= factorial;
    }

    result
}

#[cfg(test)]
mod tests {
    use crate::tags::ordering::get_permutation;

    #[test]
    fn test_get_permutation3_a() {
        let data: Vec<usize> = vec![1, 2, 3];
        let permutation = get_permutation(5, data.clone());
        let expected: Vec<usize> = vec![3, 2, 1];
        assert_eq!(expected, permutation);
    }

    #[test]
    fn test_get_permutation3_b() {
        let data: Vec<usize> = vec![1, 2, 3];
        let permutation = get_permutation(4, data.clone());
        let expected: Vec<usize> = vec![3, 1, 2];
        assert_eq!(expected, permutation);
    }

    #[test]
    fn test_get_permutation7_a() {
        let data: Vec<usize> = vec![1, 2, 3, 4, 5, 6, 7];
        let permutation = get_permutation(0, data.clone());
        let expected: Vec<usize> = vec![1, 2, 3, 4, 5, 6, 7];
        assert_eq!(expected, permutation);
    }

    #[test]
    fn test_get_permutation7_b() {
        let data: Vec<usize> = vec![1, 2, 3, 4, 5, 6, 7];
        let permutation = get_permutation(5000, data.clone());
        let expected: Vec<usize> = vec![7, 6, 4, 2, 3, 1, 5];
        assert_eq!(expected, permutation);
    }
}

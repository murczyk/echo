use super::query;
use crate::entities::palitra_highlight_blacklist;
use crate::error::AppError;
use crate::h;
use crate::palitra::types::PalitraHighlightBlacklistEntry;
use crate::rer_importer::highlight::CNPoint;
use crate::types::ShortContext;
use sea_orm::ConnectionTrait;
use std::collections::{HashMap, HashSet};

pub(crate) fn normalize_label(label: &str) -> String {
    label.trim().to_lowercase()
}

pub(crate) async fn load_blacklisted_labels<C>(
    dbx: &C,
    palitra_ids: Vec<i64>,
) -> Result<HashMap<i64, HashSet<String>>, AppError>
where
    C: ConnectionTrait,
{
    if palitra_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = query::load_labels(dbx, palitra_ids).await.c(h!())?;
    let mut labels_by_palitra = HashMap::new();
    for (palitra_id, label) in rows {
        labels_by_palitra
            .entry(palitra_id)
            .or_insert_with(HashSet::new)
            .insert(label);
    }
    Ok(labels_by_palitra)
}

pub(crate) fn is_label_blacklisted(
    labels_by_palitra: &HashMap<i64, HashSet<String>>,
    palitra_id: i64,
    label: &str,
) -> bool {
    labels_by_palitra
        .get(&palitra_id)
        .is_some_and(|labels| labels.contains(&normalize_label(label)))
}

pub(crate) fn filter_blacklisted_points(
    labels_by_palitra: &HashMap<i64, HashSet<String>>,
    palitra_id: i64,
    points: &mut Vec<CNPoint>,
) {
    points.retain(|point| {
        !is_label_blacklisted(labels_by_palitra, palitra_id, &point.etalon)
    });
}

pub async fn list_entries<C>(
    dbx: &C,
    palitra_id: i64,
) -> Result<Vec<PalitraHighlightBlacklistEntry>, AppError>
where
    C: ConnectionTrait,
{
    query::list_entries(dbx, palitra_id)
        .await
        .c(h!())?
        .into_iter()
        .map(|(entry, login)| {
            login
                .map(|login| map_entry(entry, login.login))
                .ok_or(AppError::NotFound)
        })
        .collect()
}

pub async fn add_entry<C>(
    dbx: &C,
    palitra_id: i64,
    created_by_login_id: uuid::Uuid,
    requested_label: &str,
    source_message_id: i64,
) -> Result<PalitraHighlightBlacklistEntry, AppError>
where
    C: ConnectionTrait,
{
    let normalized_label = normalize_label(requested_label);
    if normalized_label.is_empty() {
        return Err(AppError::BL {
            msg: "Palitra highlight blacklist label must not be empty".into(),
        });
    }

    let label =
        match query::find_current_label(dbx, palitra_id, &normalized_label)
            .await
            .c(h!())?
        {
            Some(label) => label,
            None => query::find_historical_label(
                dbx,
                created_by_login_id,
                source_message_id,
                palitra_id,
                &normalized_label,
            )
            .await
            .c(h!())?
            .ok_or_else(|| AppError::BL {
                msg: "Palitra highlight blacklist label does not exist".into(),
            })?,
        };
    let entry = query::upsert_entry(
        dbx,
        palitra_id,
        created_by_login_id,
        label.trim().to_string(),
        normalized_label,
    )
    .await
    .c(h!())?;
    let login = query::login_name(dbx, entry.created_by_login_id)
        .await
        .c(h!())?;
    Ok(map_entry(entry, login))
}

pub async fn delete_entry<C>(
    dbx: &C,
    palitra_id: i64,
    blacklist_entry_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if query::delete_entry(dbx, palitra_id, blacklist_entry_id)
        .await
        .c(h!())?
        == 0
    {
        return Err(AppError::NotFound);
    }
    Ok(())
}

fn map_entry(
    entry: palitra_highlight_blacklist::Model,
    created_by_login: String,
) -> PalitraHighlightBlacklistEntry {
    PalitraHighlightBlacklistEntry {
        id: entry.id,
        palitra_id: entry.palitra_id,
        label: entry.label,
        created_by_login_id: entry.created_by_login_id.to_string(),
        created_by_login,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        add_entry, filter_blacklisted_points, is_label_blacklisted,
        load_blacklisted_labels, normalize_label,
    };
    use crate::entities::{
        sigint_inbox_item, sigint_inbox_item_point_token, signal_message,
        signal_message_group,
    };
    use crate::functest::tests::{
        cleanup, find_test_login, find_test_palitra, find_test_signal_group,
        mk_palitra_point, mk_sigint_inbox_item, mk_signal_message,
    };
    use crate::rer_importer::{
        highlight::CNPoint, inbox::bl::get_palitra_points_by_message,
    };
    use sea_orm::{ActiveModelTrait, Set};
    use serde_json::json;
    use serial_test::serial;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn normalize_label_trims_and_lowercases() {
        assert_eq!(normalize_label("  Пункт Альфа  "), "пункт альфа");
    }

    #[test]
    fn blacklist_is_scoped_by_palitra() {
        let labels_by_palitra =
            HashMap::from([(1, HashSet::from(["пункт альфа".to_string()]))]);

        assert!(is_label_blacklisted(&labels_by_palitra, 1, " ПУНКТ АЛЬФА "));
        assert!(!is_label_blacklisted(&labels_by_palitra, 2, "Пункт Альфа"));
    }

    #[test]
    fn filtering_keeps_stored_points_reversible() {
        let labels_by_palitra =
            HashMap::from([(1, HashSet::from(["пункт альфа".to_string()]))]);
        let stored_points =
            vec![point("Пункт Альфа", 0, 11), point("Пункт Бета", 12, 22)];

        let mut visible_points = stored_points.clone();
        filter_blacklisted_points(&labels_by_palitra, 1, &mut visible_points);
        assert_eq!(visible_points, vec![point("Пункт Бета", 12, 22)]);

        let mut restored_points = stored_points.clone();
        filter_blacklisted_points(&HashMap::new(), 1, &mut restored_points);
        assert_eq!(restored_points, stored_points);
    }

    fn point(etalon: &str, begin: usize, end: usize) -> CNPoint {
        CNPoint {
            begin,
            end,
            etalon: etalon.to_string(),
            text: etalon.to_string(),
            palitra_ids: vec![],
        }
    }

    #[serial]
    #[tokio::test]
    async fn validates_and_loads_normalized_existing_label() {
        let env = cleanup().await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let login_id = crate::users::system_login_id(&env.dbx).await.unwrap();
        mk_palitra_point("Пункт Альфа".to_string(), palitra.id, &env.dbx)
            .await
            .unwrap();

        let first =
            add_entry(&env.dbx, palitra.id, login_id, "  ПУНКТ АЛЬФА ", 1)
                .await
                .unwrap();
        assert_eq!(first.label, "Пункт Альфа");
        assert_eq!(first.created_by_login_id, login_id.to_string());
        assert_eq!(first.created_by_login, "system");

        let duplicate =
            add_entry(&env.dbx, palitra.id, login_id, "ПУНКТ АЛЬФА", 1)
                .await
                .unwrap();
        assert_eq!(duplicate.id, first.id);

        let labels = load_blacklisted_labels(&env.dbx, vec![palitra.id, -1])
            .await
            .unwrap();
        assert_eq!(
            labels.get(&palitra.id),
            Some(&HashSet::from(["пункт альфа".to_string()]))
        );
        assert!(
            add_entry(&env.dbx, palitra.id, login_id, "Невідома точка", 1)
                .await
                .is_err()
        );
    }

    #[serial]
    #[tokio::test]
    async fn blacklists_visible_historical_label_only_from_source_message() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let signal_group = find_test_signal_group(&env.dbx).await.unwrap();
        let source_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("Stale point".to_string())),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(source_message.id),
            group_master_key: Set(Some(signal_group.master_key)),
            datasource_group_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(source_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item_point_token::ActiveModel {
            sigint_inbox_item_id: Set(source_message.id),
            palitra_id: Set(palitra.id),
            point_tokens: Set(json!([{
                "begin": 0,
                "end": 11,
                "etalon": "Stale point",
                "text": "Stale point"
            }])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        assert!(add_entry(
            &env.dbx,
            palitra.id,
            login.id,
            "Stale point",
            source_message.id + 1,
        )
        .await
        .is_err());
        assert!(add_entry(
            &env.dbx,
            palitra.id + 1,
            login.id,
            "Stale point",
            source_message.id,
        )
        .await
        .is_err());

        let inaccessible_message =
            mk_sigint_inbox_item(&env.dbx, Default::default())
                .await
                .unwrap();
        sigint_inbox_item_point_token::ActiveModel {
            sigint_inbox_item_id: Set(inaccessible_message.id),
            palitra_id: Set(palitra.id),
            point_tokens: Set(json!([{
                "begin": 0,
                "end": 11,
                "etalon": "Hidden point",
                "text": "Hidden point"
            }])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert!(add_entry(
            &env.dbx,
            palitra.id,
            login.id,
            "Hidden point",
            inaccessible_message.id,
        )
        .await
        .is_err());

        let entry = add_entry(
            &env.dbx,
            palitra.id,
            login.id,
            "  STALE POINT ",
            source_message.id,
        )
        .await
        .unwrap();
        let duplicate = add_entry(
            &env.dbx,
            palitra.id,
            login.id,
            "stale point",
            source_message.id,
        )
        .await
        .unwrap();
        assert_eq!(duplicate.id, entry.id);
        let points_by_message = get_palitra_points_by_message(
            &env.dbx,
            login.id,
            vec![source_message.id],
        )
        .await
        .unwrap();
        assert!(points_by_message
            .get(&source_message.id)
            .is_none_or(Vec::is_empty));
    }
}

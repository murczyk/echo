use super::query;
use crate::entities::palitra_highlight_blacklist;
use crate::error::AppError;
use crate::palitra::types::PalitraHighlightBlacklistEntry;
use crate::rer_importer::highlight::CNPoint;
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

    let rows = query::load_labels(dbx, palitra_ids).await?;
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
        .await?
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

    let label = query::find_current_label(dbx, palitra_id, &normalized_label)
        .await?
        .ok_or_else(|| AppError::BL {
            msg: "Palitra highlight blacklist label does not exist".into(),
        })?;
    let entry = query::upsert_entry(
        dbx,
        palitra_id,
        created_by_login_id,
        label.trim().to_string(),
        normalized_label,
    )
    .await?;
    let login = query::login_name(dbx, entry.created_by_login_id).await?;
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
    if query::delete_entry(dbx, palitra_id, blacklist_entry_id).await? == 0 {
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
    use crate::functest::tests::{
        cleanup, find_test_palitra, mk_palitra_point,
    };
    use crate::rer_importer::highlight::CNPoint;
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

        let first = add_entry(&env.dbx, palitra.id, login_id, "  ПУНКТ АЛЬФА ")
            .await
            .unwrap();
        assert_eq!(first.label, "Пункт Альфа");
        assert_eq!(first.created_by_login_id, login_id.to_string());
        assert_eq!(first.created_by_login, "system");

        let duplicate =
            add_entry(&env.dbx, palitra.id, login_id, "ПУНКТ АЛЬФА")
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
        assert!(add_entry(&env.dbx, palitra.id, login_id, "Невідома точка")
            .await
            .is_err());
    }
}

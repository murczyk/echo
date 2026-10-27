use crate::config::ORBIT_COMBAT_TYPE_BACKFILL_BATCH_SIZE;
use crate::entities::sigint_unit;
use crate::h;
use crate::types::{Mode, ShortContext};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    DbBackend, EntityTrait, FromQueryResult, IntoActiveModel, QueryFilter,
    QuerySelect, Statement,
};
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, FromQueryResult)]
struct Candidate {
    id: i64,
    combat_type_id: Option<Uuid>,
    combat_types: Vec<Uuid>,
}

#[derive(Debug, Default)]
struct Counts {
    updated: u64,
    unchanged: u64,
    skipped: u64,
}

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let db = super::connect_database(mode).await.c(h!())?;
    let counts = populate_combat_types(&db).await.c(h!())?;
    println!(
        "SIGINT combat types: {} updated, {} unchanged, {} skipped.",
        counts.updated, counts.unchanged, counts.skipped,
    );
    Ok(())
}

async fn load_candidates(
    db: &DatabaseConnection,
    after_id: i64,
) -> anyhow::Result<Vec<Candidate>> {
    Candidate::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
with candidates as materialized (
    select unit.id, unit.combat_type_id
    from sigint_unit unit
    where unit.id > $1 and unit.deleted = false
      and exists (
          select 1 from orbit_unit_sigint_unit link
          join orbit_unit orbit on orbit.unit_id = link.orbit_unit_id
          where link.sigint_unit_id = unit.id
            and link.is_suppressed = false and orbit.deleted = false
      )
    order by unit.id limit $2
)
select candidates.id, candidates.combat_type_id,
       coalesce(array_agg(distinct orbit.combat_unit_type_id)
           filter (where orbit.combat_unit_type_id is not null), '{}') as combat_types
from candidates
join orbit_unit_sigint_unit link on link.sigint_unit_id = candidates.id
join orbit_unit orbit on orbit.unit_id = link.orbit_unit_id
where link.is_suppressed = false and orbit.deleted = false
group by candidates.id, candidates.combat_type_id
order by candidates.id
        "#,
        [after_id.into(), ORBIT_COMBAT_TYPE_BACKFILL_BATCH_SIZE.into()],
    )).all(db).await.c(h!())
}

async fn populate_combat_types(
    db: &DatabaseConnection,
) -> anyhow::Result<Counts> {
    let author = crate::users::system_login_id(db).await.c(h!())?;
    let total = count_candidates(db).await.c(h!())?;
    let started = Instant::now();
    let mut after_id = i64::MIN;
    let mut counts = Counts::default();
    loop {
        let candidates = load_candidates(db, after_id).await.c(h!())?;
        if candidates.is_empty() {
            break;
        }
        for candidate in candidates {
            after_id = candidate.id;
            match candidate.combat_types.as_slice() {
                [id] if candidate.combat_type_id == Some(*id) => {
                    counts.unchanged += 1
                }
                [_] => {
                    match update_combat_type(db, candidate.id, &author)
                        .await
                        .c(h!())?
                    {
                        Some(true) => counts.updated += 1,
                        Some(false) => counts.unchanged += 1,
                        None => report_skipped(&mut counts, candidate.id),
                    }
                }
                _ => report_skipped(&mut counts, candidate.id),
            }
        }
        report_progress(after_id, &counts, total, started);
    }
    Ok(counts)
}

async fn count_candidates(db: &DatabaseConnection) -> anyhow::Result<u64> {
    #[derive(FromQueryResult)]
    struct Count {
        count: i64,
    }
    let count = Count::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        r#"
select count(*) from sigint_unit unit
where unit.deleted = false and exists (
    select 1 from orbit_unit_sigint_unit link
    join orbit_unit orbit on orbit.unit_id = link.orbit_unit_id
    where link.sigint_unit_id = unit.id
      and link.is_suppressed = false and orbit.deleted = false
)
        "#,
    ))
    .one(db)
    .await
    .c(h!())?
    .c(h!())?;
    u64::try_from(count.count).c(h!())
}

fn report_progress(
    after_id: i64,
    counts: &Counts,
    total: u64,
    started: Instant,
) {
    let processed = counts.updated + counts.unchanged + counts.skipped;
    let rate = processed as f64 / started.elapsed().as_secs_f64();
    let remaining = total.saturating_sub(processed);
    let seconds = (remaining as f64 / rate).ceil() as u64;
    println!("Through SIGINT unit {after_id}: {} updated, {} unchanged, {} skipped; {rate:.1} units/s, approximately {remaining} remaining ({seconds}s).",
        counts.updated, counts.unchanged, counts.skipped);
}

fn report_skipped(counts: &mut Counts, id: i64) {
    counts.skipped += 1;
    println!("Skipped SIGINT unit {id}: no unambiguous linked combat type; assign it manually.");
}

async fn update_combat_type(
    db: &DatabaseConnection,
    id: i64,
    author: &Uuid,
) -> anyhow::Result<Option<bool>> {
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let Some(unit) = sigint_unit::Entity::find_by_id(id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(&transaction)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    #[derive(FromQueryResult)]
    struct CombatType {
        id: Uuid,
    }
    let combat_types =
        CombatType::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
select distinct orbit.combat_unit_type_id as id
from orbit_unit_sigint_unit link
join orbit_unit orbit on orbit.unit_id = link.orbit_unit_id
where link.sigint_unit_id = $1 and link.is_suppressed = false
  and orbit.deleted = false and orbit.combat_unit_type_id is not null
        "#,
            [id.into()],
        ))
        .all(&transaction)
        .await
        .c(h!())?;
    let [combat_type] = combat_types.as_slice() else {
        return Ok(None);
    };
    if unit.combat_type_id == Some(combat_type.id) {
        return Ok(Some(false));
    }
    crate::sigint::unit::changelog::set_author(&transaction, author)
        .await
        .c(h!())?;
    let mut unit = unit.into_active_model();
    unit.combat_type_id = Set(Some(combat_type.id));
    unit.updated_at = Set(chrono::Utc::now().naive_utc());
    unit.update(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Some(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        orbit_combat_unit_type, orbit_unit, orbit_unit_sigint_unit,
        sigint_unit_orbit_combat_type,
    };
    use crate::functest::tests::{cleanup, mk_sigint_unit};
    use sea_orm::{ConnectionTrait, QueryOrder, TransactionTrait};
    use serial_test::serial;

    async fn add_type(db: &DatabaseConnection, name: &str) -> Uuid {
        let id = Uuid::new_v4();
        orbit_combat_unit_type::ActiveModel {
            id: Set(id),
            key: Set(id.to_string()),
            name: Set(name.to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        super::super::dictionary::copy_sigint_combat_types(db)
            .await
            .unwrap();
        id
    }

    async fn link(
        db: &DatabaseConnection,
        unit_id: i64,
        combat_type: Option<Uuid>,
        suppressed: bool,
        deleted: bool,
    ) {
        let orbit = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            combat_unit_type_id: Set(combat_type),
            deleted: Set(deleted),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit.unit_id),
            sigint_unit_id: Set(unit_id),
            is_manual: Set(true),
            is_suppressed: Set(suppressed),
        }
        .insert(db)
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn regression_3113_backfill_skips_ambiguity_and_is_idempotent() {
        let env = cleanup().await.unwrap();
        let first = add_type(&env.dbx, "Піхота").await;
        let second = add_type(&env.dbx, "Артилерія").await;
        let agreed = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                combat_type_id: Set(Some(second)),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link(&env.dbx, agreed.id, Some(first), false, false).await;
        link(&env.dbx, agreed.id, None, false, false).await;
        link(&env.dbx, agreed.id, Some(first), false, false).await;
        link(&env.dbx, agreed.id, Some(second), true, false).await;
        link(&env.dbx, agreed.id, Some(second), false, true).await;
        let conflict = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                combat_type_id: Set(Some(second)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link(&env.dbx, conflict.id, Some(first), false, false).await;
        link(&env.dbx, conflict.id, Some(second), false, false).await;
        let unknown =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        link(&env.dbx, unknown.id, None, false, false).await;
        let deleted = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                deleted: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link(&env.dbx, deleted.id, Some(first), false, false).await;
        let unlinked =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let counts = populate_combat_types(&env.dbx).await.unwrap();
        assert_eq!(
            (counts.updated, counts.unchanged, counts.skipped),
            (1, 0, 2)
        );
        let units = sigint_unit::Entity::find()
            .order_by_asc(sigint_unit::Column::Id)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(
            units
                .iter()
                .find(|unit| unit.id == agreed.id)
                .unwrap()
                .combat_type_id,
            Some(first)
        );
        assert_eq!(
            units
                .iter()
                .find(|unit| unit.id == conflict.id)
                .unwrap()
                .combat_type_id,
            Some(second)
        );
        assert_eq!(
            units
                .iter()
                .find(|unit| unit.id == unknown.id)
                .unwrap()
                .combat_type_id,
            None
        );
        assert_eq!(
            units
                .iter()
                .find(|unit| unit.id == deleted.id)
                .unwrap()
                .combat_type_id,
            None
        );
        assert_eq!(
            units
                .iter()
                .find(|unit| unit.id == unlinked.id)
                .unwrap()
                .combat_type_id,
            None
        );
        let updated_at = units
            .iter()
            .find(|unit| unit.id == agreed.id)
            .unwrap()
            .updated_at;
        let counts = populate_combat_types(&env.dbx).await.unwrap();
        assert_eq!(
            (counts.updated, counts.unchanged, counts.skipped),
            (0, 1, 2)
        );
        assert_eq!(
            sigint_unit::Entity::find_by_id(agreed.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .updated_at,
            updated_at
        );
    }

    #[tokio::test]
    #[serial]
    async fn regression_3113_dictionary_survives_sync_and_reimport() {
        let env = cleanup().await.unwrap();
        let id = add_type(&env.dbx, "Піхота").await;
        sigint_unit_orbit_combat_type::ActiveModel {
            id: Set(id),
            name: Set("Локальна назва".to_string()),
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                combat_type_id: Set(Some(id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        super::super::dictionary::copy_sigint_combat_types(&env.dbx)
            .await
            .unwrap();
        let transaction = env.dbx.begin().await.unwrap();
        super::super::erase_orbit_data(&transaction).await.unwrap();
        let entries = [(
            super::super::dictionary::DictionaryKind::CombatUnitType,
            vec![
                super::super::dictionary::DictionaryEntry {
                    id,
                    key: id.to_string(),
                    name: "Назва нового імпорту".to_string(),
                },
                super::super::dictionary::DictionaryEntry {
                    id: Uuid::new_v4(),
                    key: "new".to_string(),
                    name: "Новий вид".to_string(),
                },
            ],
        )]
        .into_iter()
        .collect();
        super::super::dictionary::ensure_dictionary_entries(
            &transaction,
            &entries,
        )
        .await
        .unwrap();
        assert_eq!(
            sigint_unit_orbit_combat_type::Entity::find_by_id(id)
                .one(&transaction)
                .await
                .unwrap()
                .unwrap()
                .name,
            "Локальна назва"
        );
        assert_eq!(
            sigint_unit::Entity::find_by_id(unit.id)
                .one(&transaction)
                .await
                .unwrap()
                .unwrap()
                .combat_type_id,
            Some(id)
        );
        let new_id = entries
            [&super::super::dictionary::DictionaryKind::CombatUnitType][1]
            .id;
        assert!(sigint_unit_orbit_combat_type::Entity::find_by_id(new_id)
            .one(&transaction)
            .await
            .unwrap()
            .is_some());
        transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn regression_3113_each_changed_unit_commits_separately() {
        let env = cleanup().await.unwrap();
        let id = add_type(&env.dbx, "Піхота").await;
        let first = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let second = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("fail-3113".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link(&env.dbx, first.id, Some(id), false, false).await;
        link(&env.dbx, second.id, Some(id), false, false).await;
        env.dbx.execute_unprepared(r#"
create function fail_combat_type_3113() returns trigger language plpgsql as $$
begin if new.name = 'fail-3113' then raise exception 'test failure'; end if; return new; end; $$;
create trigger fail_combat_type_3113 before update of combat_type_id on sigint_unit
for each row execute function fail_combat_type_3113();
        "#).await.unwrap();
        let result = populate_combat_types(&env.dbx).await;
        env.dbx.execute_unprepared("drop trigger fail_combat_type_3113 on sigint_unit; drop function fail_combat_type_3113();").await.unwrap();
        assert!(result.is_err());
        assert_eq!(
            sigint_unit::Entity::find_by_id(first.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .combat_type_id,
            Some(id)
        );
        assert_eq!(
            sigint_unit::Entity::find_by_id(second.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .combat_type_id,
            None
        );
        let counts = populate_combat_types(&env.dbx).await.unwrap();
        assert_eq!((counts.updated, counts.unchanged), (1, 1));
    }
}

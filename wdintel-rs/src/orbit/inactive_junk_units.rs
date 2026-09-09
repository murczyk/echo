use super::tui;
use crate::types::{Mode, ShortContext};
use crate::{h, users};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use uuid::Uuid;

const INACTIVE_JUNK_UNIT_IDS_SQL: &str = r#"
select sigint_unit.id
from sigint_unit
where sigint_unit.active = false
  and sigint_unit.created_by_login_id = $1
  and not exists (
      select 1
      from sigint_callsign
      where sigint_callsign.unit_id = sigint_unit.id
  )
  and not exists (
      select 1
      from sigint_network_callsign
      where sigint_network_callsign.unit_id = sigint_unit.id
  )
  and not exists (
      select 1
      from sigint_signal
      where sigint_signal.unit = sigint_unit.id
  )
"#;

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let db = super::connect_database(mode).await.c(h!())?;
    let system_login_id = users::system_login_id(&db).await.c(h!())?;
    let candidate_count = count_inactive_junk_units(&db, system_login_id)
        .await
        .c(h!())?;
    if candidate_count == 0 {
        println!("No inactive junk SIGINT units found.");
        return Ok(());
    }
    if !tui::confirm_delete_inactive_junk_units(candidate_count).c(h!())? {
        return Ok(());
    }
    let deleted_count = delete_inactive_junk_units(&db, system_login_id)
        .await
        .c(h!())?;
    println!("Deleted {deleted_count} inactive junk SIGINT units.");
    Ok(())
}

async fn count_inactive_junk_units<C>(
    db: &C,
    system_login_id: Uuid,
) -> anyhow::Result<i64>
where
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                "select count(*) as candidate_count from ({INACTIVE_JUNK_UNIT_IDS_SQL}) candidates"
            ),
            [system_login_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "candidate_count").c(h!())
}

async fn delete_inactive_junk_units<C>(
    db: &C,
    system_login_id: Uuid,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    Ok(db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                "delete from sigint_unit where id in ({INACTIVE_JUNK_UNIT_IDS_SQL})"
            ),
            [system_login_id.into()],
        ))
        .await
        .c(h!())?
        .rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        sigint_callsign, sigint_network_callsign, sigint_network_unit,
        sigint_signal, sigint_unit,
    };
    use chrono::Utc;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
        QueryFilter,
    };
    use serial_test::serial;
    use std::collections::BTreeSet;

    #[tokio::test]
    #[serial]
    async fn deletes_only_unlinked_inactive_system_units() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let system_login_id = users::system_login_id(&env.dbx).await.unwrap();
        let user_login_id = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let deletable = make_unit(&env.dbx, system_login_id, false).await;
        let active = make_unit(&env.dbx, system_login_id, true).await;
        let user_created = make_unit(&env.dbx, user_login_id, false).await;
        let with_callsign = make_unit(&env.dbx, system_login_id, false).await;
        let with_network_callsign =
            make_unit(&env.dbx, system_login_id, false).await;
        let with_signal = make_unit(&env.dbx, system_login_id, false).await;
        let network = crate::functest::tests::mk_sigint_network(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        crate::functest::tests::mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                network_id: Set(network.id),
                unit_id: Set(deletable.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        insert_callsign(&env.dbx, with_callsign.id).await;
        insert_network_callsign(&env.dbx, network.id, with_network_callsign.id)
            .await;
        insert_signal(&env.dbx, with_signal.id).await;

        assert_eq!(
            count_inactive_junk_units(&env.dbx, system_login_id)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            delete_inactive_junk_units(&env.dbx, system_login_id)
                .await
                .unwrap(),
            1
        );

        let remaining_ids = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in([
                deletable.id,
                active.id,
                user_created.id,
                with_callsign.id,
                with_network_callsign.id,
                with_signal.id,
            ]))
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|unit| unit.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            remaining_ids,
            BTreeSet::from([
                active.id,
                user_created.id,
                with_callsign.id,
                with_network_callsign.id,
                with_signal.id,
            ])
        );
        assert!(sigint_network_unit::Entity::find()
            .filter(sigint_network_unit::Column::UnitId.eq(deletable.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    async fn make_unit<C>(
        db: &C,
        created_by_login_id: Uuid,
        active: bool,
    ) -> sigint_unit::Model
    where
        C: ConnectionTrait,
    {
        crate::functest::tests::mk_sigint_unit(
            db,
            sigint_unit::ActiveModel {
                active: Set(active),
                created_by_login_id: Set(created_by_login_id),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn insert_callsign<C>(db: &C, unit_id: i64)
    where
        C: ConnectionTrait,
    {
        sigint_callsign::ActiveModel {
            callsign: Set(format!("Callsign-{unit_id}")),
            position: Set(String::new()),
            comment: Set(String::new()),
            unit_id: Set(unit_id),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(String::new()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            full_name: Set(String::new()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }

    async fn insert_network_callsign<C>(
        db: &C,
        sigint_network_id: i64,
        unit_id: i64,
    ) where
        C: ConnectionTrait,
    {
        sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(sigint_network_id),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            sigint_callsign: Set(format!("Network-callsign-{unit_id}")),
            sigint_origin_id: Set(None),
            position: Set(None),
            comment: Set(None),
            sigint_callsign_id: Set(None),
            source_id: Set(None),
            radio_freq: Set(None),
            developing: Set(false),
            unit_developing: Set(false),
            unit_id: Set(Some(unit_id)),
            main_radio_station: Set(false),
            original_id: Set(None),
            command_control: Set(false),
            full_name: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }

    async fn insert_signal<C>(db: &C, unit_id: i64)
    where
        C: ConnectionTrait,
    {
        sigint_signal::ActiveModel {
            text: Set(format!("Signal-{unit_id}")),
            meaning: Set(None),
            unit: Set(Some(unit_id)),
            coordinates: Set(None),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }
}

use crate::h;
use crate::types::{Mode, ShortContext};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let db = super::connect_database(mode).await.c(h!())?;
    let updated = mark_linked_sigint_units(&db).await.c(h!())?;
    println!("Marked {updated} linked SIGINT units as present in ORBIT.");
    Ok(())
}

async fn mark_linked_sigint_units<C>(db: &C) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    Ok(db
        .execute_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
update sigint_unit
set present_in_orbit = true
where present_in_orbit is distinct from true
  and deleted = false
  and exists (
      select 1
      from orbit_unit_sigint_unit link
      join orbit_unit on orbit_unit.unit_id = link.orbit_unit_id
      where link.sigint_unit_id = sigint_unit.id
        and link.is_suppressed = false
        and orbit_unit.deleted = false
  )
            "#,
        ))
        .await
        .c(h!())?
        .rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
    use crate::functest::tests::{cleanup, mk_sigint_unit};
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
    };
    use serial_test::serial;
    use uuid::Uuid;

    #[tokio::test]
    #[serial]
    async fn marks_only_linked_sigint_unit_as_present() {
        let env = cleanup().await.unwrap();
        let linked = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unlinked = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orbit_unit = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name: Set(Some("Linked ORBIT unit".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit.unit_id),
            sigint_unit_id: Set(linked.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let mut linked = linked.into_active_model();
        linked.present_in_orbit = Set(None);
        let linked = linked.update(&env.dbx).await.unwrap();

        mark_linked_sigint_units(&env.dbx).await.unwrap();

        let linked = sigint_unit::Entity::find_by_id(linked.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let unlinked = sigint_unit::Entity::find_by_id(unlinked.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(linked.present_in_orbit, Some(true));
        assert_eq!(unlinked.present_in_orbit, None);
    }
}

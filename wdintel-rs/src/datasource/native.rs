use crate::config::{
    DATASOURCE_ECHO_NATIVE_GROUP_PREFIX, DATASOURCE_ECHO_NATIVE_KIND,
};
use crate::entities::{datasource, signal_group};
use crate::h;
use crate::types::ShortContext;
use anyhow::ensure;
use sea_orm::*;

pub fn external_group_condition() -> Condition {
    Condition::any()
        .add(signal_group::Column::DatasourceId.is_null())
        .add(
            signal_group::Column::DatasourceId.not_in_subquery(
                datasource::Entity::find()
                    .filter(
                        datasource::Column::Kind
                            .eq(DATASOURCE_ECHO_NATIVE_KIND),
                    )
                    .select_only()
                    .column(datasource::Column::Id)
                    .into_query(),
            ),
        )
}

pub async fn load<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<datasource::Model> {
    datasource::Entity::find()
        .filter(datasource::Column::Kind.eq(DATASOURCE_ECHO_NATIVE_KIND))
        .one(db)
        .await
        .c(h!())?
        .c(h!())
}

pub async fn is_native_group<C: ConnectionTrait>(
    db: &C,
    key: &str,
) -> anyhow::Result<bool> {
    Ok(signal_group::Entity::find_by_id(key)
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::Datasource.def(),
        )
        .filter(datasource::Column::Kind.eq(DATASOURCE_ECHO_NATIVE_KIND))
        .select_only()
        .column(signal_group::Column::MasterKey)
        .into_tuple::<String>()
        .one(db)
        .await
        .c(h!())?
        .is_some())
}

pub async fn require_external_datasource<C: ConnectionTrait>(
    db: &C,
    id: i64,
) -> anyhow::Result<()> {
    let datasource = datasource::Entity::find_by_id(id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    ensure!(
        datasource.kind != DATASOURCE_ECHO_NATIVE_KIND,
        "Службове джерело Echo не підтримує операції месенджера"
    );
    Ok(())
}

pub async fn ensure_group_datasource_compatible<C: ConnectionTrait>(
    db: &C,
    key: &str,
    datasource_id: i64,
) -> anyhow::Result<()> {
    let datasource = datasource::Entity::find_by_id(datasource_id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    let source_is_native = datasource.kind == DATASOURCE_ECHO_NATIVE_KIND;
    ensure!(
        source_is_native
            == key.starts_with(DATASOURCE_ECHO_NATIVE_GROUP_PREFIX),
        "Група і джерело мають несумісне походження"
    );
    let group = signal_group::Entity::find_by_id(key)
        .select_only()
        .column(signal_group::Column::DatasourceId)
        .into_tuple::<Option<i64>>()
        .one(db)
        .await
        .c(h!())?;
    if let Some(base_datasource_id) = group {
        if source_is_native {
            ensure!(
                base_datasource_id == Some(datasource_id),
                "Не можна змінити походження групи"
            );
        } else if let Some(base_datasource_id) =
            base_datasource_id.filter(|id| *id != datasource_id)
        {
            require_external_datasource(db, base_datasource_id)
                .await
                .c(h!())?;
        }
    }
    Ok(())
}

pub async fn require_external_group_keys<C: ConnectionTrait>(
    db: &C,
    keys: &[String],
) -> anyhow::Result<()> {
    ensure!(
        !keys
            .iter()
            .any(|key| key.starts_with(DATASOURCE_ECHO_NATIVE_GROUP_PREFIX)),
        "Зовнішнє джерело не може змінювати внутрішні групи Echo"
    );
    for keys in
        keys.chunks(crate::config::DATASOURCE_NATIVE_VALIDATION_BATCH_SIZE)
    {
        let native_group = signal_group::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_group::Relation::Datasource.def(),
            )
            .filter(signal_group::Column::MasterKey.eq_any(keys.to_vec()))
            .filter(datasource::Column::Kind.eq(DATASOURCE_ECHO_NATIVE_KIND))
            .select_only()
            .column(signal_group::Column::MasterKey)
            .into_tuple::<String>()
            .one(db)
            .await
            .c(h!())?;
        ensure!(
            native_group.is_none(),
            "Зовнішнє джерело посилається на внутрішню групу Echo"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sea_orm_active_enums::AccountStatus;
    use crate::functest::tests::{
        cleanup, find_test_login, mk_datasource, mk_signal_group,
    };
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn native_source_survives_messenger_maintenance_and_rejects_mutation()
    {
        let env = cleanup().await.unwrap();
        let source = load(&env.dbx).await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        assert!(crate::messenger::bl::edit_account(
            source.id,
            None,
            false,
            None,
            None,
            "changed".into(),
            None,
            None,
            None,
            &env.dbx,
            &login.id,
        )
        .await
        .is_err());
        super::super::fix_datasource_default_aor(&env.dbx)
            .await
            .unwrap();
        super::super::disable_im_datasources(&env.dbx, "native-source-test")
            .await
            .unwrap();
        assert_eq!(load(&env.dbx).await.unwrap(), source);
        assert!(!crate::messenger::bl::list_echo_accounts(None, &env.dbx)
            .await
            .unwrap()
            .iter()
            .any(|account| account.id == source.id));
        let txn = env.dbx.begin().await.unwrap();
        assert!(crate::messenger::bl::deactivate_account(
            source.id, &txn, None, true
        )
        .await
        .is_err());
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn native_source_database_constraints_protect_singleton_and_configuration(
    ) {
        let env = cleanup().await.unwrap();
        let source = load(&env.dbx).await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut duplicate = source.clone().into_active_model();
        duplicate.id = NotSet;
        assert!(duplicate.insert(&txn).await.is_err());
        txn.rollback().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut changed = source.clone().into_active_model();
        changed.status = Set(AccountStatus::Paused);
        assert!(changed.update(&txn).await.is_err());
        txn.rollback().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut changed = source.clone().into_active_model();
        changed.can_send_messages = Set(Some(true));
        assert!(changed.update(&txn).await.is_err());
        txn.rollback().await.unwrap();
        assert_eq!(load(&env.dbx).await.unwrap(), source);
    }

    #[tokio::test]
    #[serial]
    async fn native_group_cannot_acquire_external_mapping() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let native = load(&txn).await.unwrap();
        let external = mk_datasource(&txn, Default::default()).await.unwrap();
        let key = format!(
            "{DATASOURCE_ECHO_NATIVE_GROUP_PREFIX}{}",
            uuid::Uuid::new_v4()
        );
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(key.clone()),
                datasource_id: Set(Some(native.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(crate::messenger::group::ensure_datasource_group_id(
            &txn,
            key.clone(),
            external.id
        )
        .await
        .is_err());
        crate::messenger::group::ensure_datasource_group_id(
            &txn, key, native.id,
        )
        .await
        .unwrap();
        assert!(crate::messenger::group::ensure_datasource_group_id(
            &txn,
            "external-group".into(),
            native.id
        )
        .await
        .is_err());
        txn.rollback().await.unwrap();
    }
}

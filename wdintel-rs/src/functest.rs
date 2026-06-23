//! Functional testing utilities
//!
//! Implements factories of two types: pure build-functions and impure
//! mk-functions:
//!
//! - your func test must be treated like a pure function: you put in
//!   the database state, run your business-logic, and then assert the
//!   results in the database or return value.
//! - build-funcs are factories that don't write into database but
//!   implement default fields
//! - mk-funcs are factories that write into database and implement
//!   default fields
//! - the point is for your test to only describe what is essential
//!   for the system state for the test to pass
//! - the point of this module is to make sure the rest is created in
//!   a system-valid state with all required fields filled with random
//!   or sensible default values
//! - in `build_` functions, missing required fields should cause
//!   failure, and in `mk_` functions, missing dependencies should be
//!   created. Let me fix this properly.

#[cfg(test)]
pub mod tests {
    use crate::entities::sea_orm_active_enums::SigintNetworkKind;
    use crate::entities::*;
    use crate::types::*;
    use sea_orm::*;

    static MIGRATE: tokio::sync::OnceCell<()> =
        tokio::sync::OnceCell::const_new();
    static CLEANUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    const TEST_AOR_NAME: &str = "Смуга1";
    const TEST_ORGANISM_NAME: &str = "666ОБ";
    const TEST_DATASOURCE_NAME: &str = "Джерело1";
    const TEST_SIGNAL_GROUP_NAME: &str = "Вухо-Тест";
    const TEST_SIGNAL_GROUP_KEY: &str = "vukho-test-master-key";
    const TEST_SIGINT_ZONE_NAME: &str = "Весь напрямок";
    const TEST_LOGIN: &str = "Tester";
    const TEST_DATASOURCE_GROUP_NAME: &str = "TestDatasourceGroup";
    const TEST_TAG_LABEL_BPLA: &str = "бпла";
    const TEST_PALITRA_NAME: &str = "TestPalitra";

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct TestIdentity {
        pub login: String,
    }

    pub async fn cleanup() -> Result<Arc<Env>, AppError> {
        MIGRATE
            .get_or_init(|| async {
                crate::migration::run_migration_1(Mode::Test).await.unwrap();
            })
            .await;
        let env = crate::server::new_env(Mode::Test).await.context(h!())?;
        let _guard = CLEANUP.lock().await;
        // Delete dependent entities first to avoid foreign key constraint violations
        secret_group_user::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_callsign_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;

        // Delete entities that depend on sigint_network first
        sigint_network_aor::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_callsign::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_callsign_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_freq_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_freq::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_post::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_unit_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        callsign_additional_source::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_callsign::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network_description::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_network::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_settlement::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_signal_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_signal::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_unit_changelog::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        tags_ordering::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        tag_keyword::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_inbox_item_tag::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        tag::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        log_users_report_generation::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_peleng::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        freq_location::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_bookmark::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_comment::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_important::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        signal_message_media::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_inbox_item::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        signal_message::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        stats_group_5min::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        stats_group_day::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        signal_group_batch::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        signal_group_aor::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        comp_freq::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        comp_freq_callsign::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_zone_aor::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_zone_datasource::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        organism_group::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        goi_association::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        goi_knowledge::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        // Ensure we remove admin data referencing groups before deleting groups
        group_admin_data::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        datasource_group::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        signal_group::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        datasource::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        login::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        delta_login::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        sigint_zone::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        organism_aor::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        organism::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        area_of_responsibility::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        palitra_point::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        palitra_access_login::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        palitra::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;

        fill_initial_data(&env.dbx).await?;

        Ok(env)
    }

    pub async fn fill_initial_data(
        dbx: &DatabaseConnection,
    ) -> Result<(), AppError> {
        use serde_json::json;

        let now = chrono::Utc::now().naive_utc();

        let aor = mk_aor(
            dbx,
            area_of_responsibility::ActiveModel {
                name: Set(TEST_AOR_NAME.to_string()),
                left_bound: Set(0.0),
                right_bound: Set(100.0),
                is_top_level: Set(true),
                is_default: Set(true),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        let organism = mk_organism(
            dbx,
            organism::ActiveModel {
                name: Set(TEST_ORGANISM_NAME.to_string()),
                created_at: Set(now),
                roles: Set(json!(["Rer"])),
                enabled: Set(true),
                parent_id: Set(None),
                deleted_permanently: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_organism_aor(
            dbx,
            organism_aor::ActiveModel {
                organism_id: Set(organism.id),
                aor_id: Set(aor.id),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        let datasource = mk_datasource(
            dbx,
            datasource::ActiveModel {
                display_name: Set(TEST_DATASOURCE_NAME.to_string()),
                deleted: Set(false),
                created_at: Set(now),
                default_aor_id: Set(Some(aor.id)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        let signal_group = mk_signal_group(
            dbx,
            signal_group::ActiveModel {
                master_key: Set(TEST_SIGNAL_GROUP_KEY.to_string()),
                datasource_id: Set(Some(datasource.id)),
                deleted: Set(false),
                name: Set(Some(TEST_SIGNAL_GROUP_NAME.to_string())),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        let sigint_zone = mk_sigint_zone(
            dbx,
            sigint_zone::ActiveModel {
                name: Set(TEST_SIGINT_ZONE_NAME.to_string()),
                created_at: Set(now),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_sigint_zone_datasource(
            dbx,
            sigint_zone_datasource::ActiveModel {
                sigint_zone_id: Set(sigint_zone.id),
                datasource_id: Set(datasource.id),
                group_master_key: Set(signal_group.master_key.clone()),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_signal_group_aor(
            dbx,
            signal_group_aor::ActiveModel {
                master_key: Set(signal_group.master_key.clone()),
                aor_id: Set(aor.id),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_login(
            dbx,
            login::ActiveModel {
                login: Set(TEST_LOGIN.to_string()),
                sigint_zone_id: Set(Some(sigint_zone.id)),
                organism_id: Set(Some(organism.id)),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_datasource_group(
            dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(signal_group.master_key.clone()),
                datasource_id: Set(datasource.id),
                last_sync_at: Set(now),
                created_at: Set(now),
                name: Set(TEST_DATASOURCE_GROUP_NAME.to_string()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_tag(
            dbx,
            tag::ActiveModel {
                label: Set(TEST_TAG_LABEL_BPLA.to_string()),
                enabled: Set(true),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        let palitra = mk_palitra(
            dbx,
            palitra::ActiveModel {
                name: Set(TEST_PALITRA_NAME.to_string()),
                hex_legacy: Set(Some("#ffffff".into())),
                author: Set(Some(TEST_LOGIN.to_string())),
                deleted: Set(false),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        mk_palitra_geometry(
            dbx,
            palitra_geometry::ActiveModel {
                palitra_id: Set(palitra.id),
                hex: Set("#ffffff".into()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_palitra_access(
            dbx,
            palitra_access_login::ActiveModel {
                palitra_id: Set(palitra.id),
                login: Set(TEST_LOGIN.to_string()),
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        Ok(())
    }

    pub async fn find_test_palitra(
        dbx: &DatabaseConnection,
    ) -> Result<palitra::Model, AppError> {
        Ok(palitra::Entity::find()
            .filter(palitra::Column::Name.eq(TEST_PALITRA_NAME))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_aor(
        dbx: &DatabaseConnection,
    ) -> Result<area_of_responsibility::Model, AppError> {
        Ok(area_of_responsibility::Entity::find()
            .filter(area_of_responsibility::Column::Name.eq(TEST_AOR_NAME))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_organism(
        dbx: &DatabaseConnection,
    ) -> Result<organism::Model, AppError> {
        Ok(organism::Entity::find()
            .filter(organism::Column::Name.eq(TEST_ORGANISM_NAME))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_login(
        dbx: &DatabaseConnection,
    ) -> Result<login::Model, AppError> {
        Ok(login::Entity::find()
            .filter(login::Column::Login.eq(TEST_LOGIN))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_datasource(
        dbx: &DatabaseConnection,
    ) -> Result<datasource::Model, AppError> {
        Ok(datasource::Entity::find()
            .filter(datasource::Column::DisplayName.eq(TEST_DATASOURCE_NAME))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_signal_group(
        dbx: &DatabaseConnection,
    ) -> Result<signal_group::Model, AppError> {
        Ok(signal_group::Entity::find()
            .filter(signal_group::Column::Name.eq(TEST_SIGNAL_GROUP_NAME))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_sigint_zone(
        dbx: &DatabaseConnection,
    ) -> Result<sigint_zone::Model, AppError> {
        Ok(sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Name.eq(TEST_SIGINT_ZONE_NAME))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_datasource_group(
        dbx: &DatabaseConnection,
    ) -> Result<datasource_group::Model, AppError> {
        Ok(datasource_group::Entity::find()
            .filter(
                datasource_group::Column::Name.eq(TEST_DATASOURCE_GROUP_NAME),
            )
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn find_test_bpla_tag(
        dbx: &DatabaseConnection,
    ) -> Result<tag::Model, AppError> {
        Ok(tag::Entity::find()
            .filter(tag::Column::Label.eq(TEST_TAG_LABEL_BPLA))
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?)
    }

    pub async fn mk_test_identity() -> Result<TestIdentity, AppError> {
        mk_test_identity_for_login(TEST_LOGIN).await
    }

    pub async fn mk_test_identity_for_login(
        login: &str,
    ) -> Result<TestIdentity, AppError> {
        Ok(TestIdentity {
            login: login.to_string(),
        })
    }

    fn build_datasource(
        inp: datasource::ActiveModel,
    ) -> datasource::ActiveModel {
        let mut out = inp.clone();
        if out.kind == NotSet {
            out.kind = Set("signal".to_string());
        }
        if out.display_name == NotSet {
            out.display_name =
                Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.signal_phone == NotSet {
            out.signal_phone = Set(None);
        }
        if out.api_endpoint == NotSet {
            out.api_endpoint = Set(None);
        }
        if out.enabled == NotSet {
            out.enabled = Set(Some(true));
        }
        if out.group_master_key == NotSet {
            out.group_master_key = Set(None);
        }
        if out.sender_uuid == NotSet {
            out.sender_uuid = Set(None);
        }
        if out.description == NotSet {
            out.description = Set(None);
        }
        if out.status == NotSet {
            out.status = Set(sea_orm_active_enums::AccountStatus::Active);
        }
        if out.echo_client_lock_id == NotSet {
            out.echo_client_lock_id = Set(None);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.default_aor_id == NotSet {
            out.default_aor_id = Set(None);
        }

        out
    }

    pub async fn mk_datasource<'a, 'async_trait, C>(
        txn: &'a C,
        inp: datasource::ActiveModel,
    ) -> Result<datasource::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_datasource(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_signal_group(
        inp: signal_group::ActiveModel,
    ) -> signal_group::ActiveModel {
        let mut out = inp.clone();
        if out.master_key == NotSet {
            out.master_key =
                Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.name == NotSet {
            out.name = Set(None);
        }
        if out.datasource_id == NotSet {
            out.datasource_id = Set(None);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.ignore_operativny == NotSet {
            out.ignore_operativny = Set(false);
        }
        if out.is_secret == NotSet {
            out.is_secret = Set(false);
        }
        if out.is_archived == NotSet {
            out.is_archived = Set(false);
        }
        out
    }

    pub async fn mk_signal_group<'a, 'async_trait, C>(
        txn: &'a C,
        inp: signal_group::ActiveModel,
    ) -> Result<signal_group::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_signal_group(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    pub async fn mk_palitra<'a, 'async_trait, C>(
        txn: &'a C,
        inp: palitra::ActiveModel,
    ) -> Result<palitra::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = inp.insert(txn).await.context(h!())?;
        Ok(out)
    }

    pub async fn mk_palitra_access<'a, 'async_trait, C>(
        txn: &'a C,
        inp: palitra_access_login::ActiveModel,
    ) -> Result<palitra_access_login::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = inp.insert(txn).await.context(h!())?;
        Ok(out)
    }

    pub async fn mk_palitra_geometry<'a, 'async_trait, C>(
        txn: &'a C,
        inp: palitra_geometry::ActiveModel,
    ) -> Result<palitra_geometry::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = inp.insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_palitra_point(
        label: String,
        palitra_id: i64,
        palitra_geometry_id: i64,
    ) -> palitra_point::ActiveModel {
        palitra_point::ActiveModel {
            palitra_id_legacy: Set(Some(palitra_id)),
            palitra_geometry_id: Set(palitra_geometry_id),
            lat: Set(10.0),
            lng: Set(20.0),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            label: Set(Some(label)),
            ..Default::default()
        }
    }

    pub async fn mk_palitra_point<'a, 'async_trait, C>(
        label: String,
        palitra_id: i64,
        txn: &'a C,
    ) -> Result<palitra_point::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let palitra_geometry = palitra_geometry::Entity::find()
            .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
            .filter(palitra_geometry::Column::Deleted.eq(false))
            .order_by_desc(palitra_geometry::Column::UpdatedAt)
            .one(txn)
            .await
            .context(h!())?
            .context(h!())?;
        let out = build_palitra_point(label, palitra_id, palitra_geometry.id)
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_zone(
        inp: sigint_zone::ActiveModel,
    ) -> sigint_zone::ActiveModel {
        let mut out = inp.clone();
        if out.name == NotSet {
            out.name = Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.sigint_origin_id == NotSet {
            out.sigint_origin_id = Set(None);
        }
        out
    }

    pub async fn mk_sigint_zone<'a, 'async_trait, C>(
        txn: &'a C,
        input: sigint_zone::ActiveModel,
    ) -> Result<sigint_zone::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_sigint_zone(input).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_sigint_zone_datasource(
        inp: sigint_zone_datasource::ActiveModel,
    ) -> Result<sigint_zone_datasource::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.sigint_zone_id == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "sigint_zone_id must be set for sigint_zone_datasource"
                )
                .context(h!()),
            ));
        }
        if out.datasource_id == NotSet {
            return Err(AppError::from(
                anyhow!("datasource_id must be set for sigint_zone_datasource")
                    .context(h!()),
            ));
        }
        if out.group_master_key == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "group_master_key must be set for sigint_zone_datasource"
                )
                .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_sigint_zone_datasource<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_zone_datasource::ActiveModel,
    ) -> Result<sigint_zone_datasource::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.sigint_zone_id == NotSet {
            let sigint_zone = mk_sigint_zone(
                txn,
                sigint_zone::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.sigint_zone_id = Set(sigint_zone.id);
        }
        if inp.datasource_id == NotSet {
            let datasource = mk_datasource(
                txn,
                datasource::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.datasource_id = Set(datasource.id);
        }
        if inp.group_master_key == NotSet {
            let signal_group = mk_signal_group(
                txn,
                signal_group::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.group_master_key = Set(signal_group.master_key);
        }
        let row = build_sigint_zone_datasource(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(row)
    }

    fn build_organism(inp: organism::ActiveModel) -> organism::ActiveModel {
        let mut out = inp.clone();
        if out.name == NotSet {
            out.name = Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.roles == NotSet {
            out.roles = Set(serde_json::json!(["Rer"]));
        }
        if out.enabled == NotSet {
            out.enabled = Set(true);
        }
        if out.parent_id == NotSet {
            out.parent_id = Set(None);
        }
        if out.deleted_permanently == NotSet {
            out.deleted_permanently = Set(false);
        }
        if out.goi_integration_type == NotSet {
            out.goi_integration_type =
                Set(crate::config::ORGANISM_GOI_INTEGRATION_TYPE_DEFAULT
                    .to_string());
        }
        if out.goi_ssh_host == NotSet {
            out.goi_ssh_host = Set(None);
        }
        if out.goi_ssh_user == NotSet {
            out.goi_ssh_user = Set(None);
        }
        if out.goi_ssh_password == NotSet {
            out.goi_ssh_password = Set(None);
        }
        if out.goi_ssh_port == NotSet {
            out.goi_ssh_port =
                Set(crate::config::ORGANISM_GOI_SSH_PORT_DEFAULT);
        }
        if out.goi_path == NotSet {
            out.goi_path =
                Set(crate::config::ORGANISM_GOI_PATH_DEFAULT.to_string());
        }
        if out.goi_api_host == NotSet {
            out.goi_api_host = Set(None);
        }
        if out.goi_api_port == NotSet {
            out.goi_api_port =
                Set(crate::config::ORGANISM_GOI_API_PORT_DEFAULT);
        }
        if out.goi_api_login == NotSet {
            out.goi_api_login = Set(None);
        }
        if out.goi_api_password == NotSet {
            out.goi_api_password = Set(None);
        }
        out
    }

    pub async fn mk_organism<'a, 'async_trait, C>(
        txn: &'a C,
        inp: organism::ActiveModel,
    ) -> Result<organism::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_organism(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_organism_aor(
        inp: organism_aor::ActiveModel,
    ) -> Result<organism_aor::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.organism_id == NotSet {
            return Err(AppError::from(
                anyhow!("organism_id must be set for organism_aor")
                    .context(h!()),
            ));
        }
        if out.aor_id == NotSet {
            return Err(AppError::from(
                anyhow!("aor_id must be set for organism_aor").context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_organism_aor<'a, 'async_trait, C>(
        txn: &'a C,
        inp: organism_aor::ActiveModel,
    ) -> Result<organism_aor::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.organism_id == NotSet {
            let organism = mk_organism(
                txn,
                organism::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.organism_id = Set(organism.id);
        }
        if inp.aor_id == NotSet {
            let aor = mk_aor(
                txn,
                area_of_responsibility::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.aor_id = Set(aor.id);
        }
        let out = build_organism_aor(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_login(inp: login::ActiveModel) -> login::ActiveModel {
        let mut out = inp.clone();
        if out.login == NotSet {
            out.login =
                Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.password == NotSet {
            out.password = Set(None);
        }
        if out.roles == NotSet {
            out.roles = Set(serde_json::to_value(vec!["Rer"]).unwrap());
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.sigint_zone_id == NotSet {
            out.sigint_zone_id = Set(None);
        }
        if out.organism_id == NotSet {
            out.organism_id = Set(None);
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.delta_login_id == NotSet {
            out.delta_login_id = Set(None);
        }
        if out.last_active_at == NotSet {
            out.last_active_at = Set(Some(chrono::Utc::now().naive_utc()));
        }
        if out.deactivation_reason == NotSet {
            out.deactivation_reason = Set(None);
        }
        if out.deleted_permanently == NotSet {
            out.deleted_permanently = Set(false);
        }
        out
    }

    pub async fn mk_login<'a, 'async_trait, C>(
        txn: &'a C,
        inp: login::ActiveModel,
    ) -> Result<login::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_login(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_aor(
        inp: area_of_responsibility::ActiveModel,
    ) -> area_of_responsibility::ActiveModel {
        let mut out = inp.clone();
        if out.name == NotSet {
            out.name = Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.description == NotSet {
            out.description = Set(None);
        }
        if out.left_bound == NotSet {
            out.left_bound = Set(30000.0);
        }
        if out.right_bound == NotSet {
            out.right_bound = Set(60000.0);
        }
        if out.left_lat == NotSet {
            out.left_lat = Set(None);
        }
        if out.left_lon == NotSet {
            out.left_lon = Set(None);
        }
        if out.right_lat == NotSet {
            out.right_lat = Set(None);
        }
        if out.right_lon == NotSet {
            out.right_lon = Set(None);
        }
        if out.left_settlement == NotSet {
            out.left_settlement = Set(None);
        }
        if out.right_settlement == NotSet {
            out.right_settlement = Set(None);
        }
        if out.updated_by == NotSet {
            out.updated_by = Set(None);
        }
        if out.updated_at == NotSet {
            out.updated_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.is_top_level == NotSet {
            out.is_top_level = Set(false);
        }
        out
    }

    pub async fn mk_aor<'a, 'async_trait, C>(
        txn: &'a C,
        inp: area_of_responsibility::ActiveModel,
    ) -> Result<area_of_responsibility::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_aor(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_signal_group_aor(
        inp: signal_group_aor::ActiveModel,
    ) -> signal_group_aor::ActiveModel {
        let mut out = inp.clone();
        if out.master_key == NotSet {
            out.master_key =
                Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.aor_id == NotSet {
            out.aor_id = Set(1); // This will be overridden by mk_ function
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        out
    }

    pub async fn mk_signal_group_aor<'a, 'async_trait, C>(
        txn: &'a C,
        inp: signal_group_aor::ActiveModel,
    ) -> Result<signal_group_aor::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.aor_id == NotSet {
            let aor = mk_aor(
                txn,
                area_of_responsibility::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.aor_id = Set(aor.id);
        }
        let out = build_signal_group_aor(inp)
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_datasource_group(
        inp: datasource_group::ActiveModel,
    ) -> Result<datasource_group::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.group_master_key == NotSet {
            return Err(AppError::from(
                anyhow!("group_master_key must be set for datasource_group")
                    .context(h!()),
            ));
        }
        if out.datasource_id == NotSet {
            return Err(AppError::from(
                anyhow!("datasource_id must be set for datasource_group")
                    .context(h!()),
            ));
        }
        if out.last_sync_at == NotSet {
            out.last_sync_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.name == NotSet {
            out.name = Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        Ok(out)
    }

    pub async fn mk_datasource_group<'a, 'async_trait, C>(
        txn: &'a C,
        inp: datasource_group::ActiveModel,
    ) -> Result<datasource_group::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.group_master_key == NotSet {
            let signal_group = mk_signal_group(
                txn,
                signal_group::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.group_master_key = Set(signal_group.master_key);
        }
        if inp.datasource_id == NotSet {
            let datasource = mk_datasource(
                txn,
                datasource::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.datasource_id = Set(datasource.id);
        }
        let out = build_datasource_group(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_tag(inp: tag::ActiveModel) -> tag::ActiveModel {
        let mut out = inp.clone();
        if out.label == NotSet {
            out.label =
                Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.extra == NotSet {
            out.extra = Set(None);
        }
        if out.ord == NotSet {
            out.ord = Set(None);
        }
        if out.title == NotSet {
            out.title = Set(None);
        }
        if out.enabled == NotSet {
            out.enabled = Set(true);
        }
        out
    }

    pub async fn mk_tag<'a, 'async_trait, C>(
        txn: &'a C,
        inp: tag::ActiveModel,
    ) -> Result<tag::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_tag(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_secret_group_user(
        inp: secret_group_user::ActiveModel,
    ) -> Result<secret_group_user::ActiveModel, AppError> {
        let out = inp.clone();
        if out.master_key == NotSet {
            return Err(AppError::from(
                anyhow!("master_key must be set for secret_group_user")
                    .context(h!()),
            ));
        }
        if out.login == NotSet {
            return Err(AppError::from(
                anyhow!("login must be set for secret_group_user")
                    .context(h!()),
            ));
        }
        Ok(out)
    }

    pub async fn mk_secret_group_user<'a, 'async_trait, C>(
        txn: &'a C,
        inp: secret_group_user::ActiveModel,
    ) -> Result<secret_group_user::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.master_key == NotSet {
            let signal_group = mk_signal_group(
                txn,
                signal_group::ActiveModel {
                    is_secret: Set(true),
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.master_key = Set(signal_group.master_key);
        }
        if inp.login == NotSet {
            let login = mk_login(
                txn,
                login::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.login = Set(login.login);
        }
        let out = build_secret_group_user(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_signal_message_group(
        inp: signal_message_group::ActiveModel,
    ) -> Result<signal_message_group::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.signal_message_id == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "signal_message_id must be set for signal_message_group"
                )
                .context(h!()),
            ));
        }
        if out.group_master_key == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "group_master_key must be set for signal_message_group"
                )
                .context(h!()),
            ));
        }
        if out.sender == NotSet {
            out.sender = Set(None);
        }
        if out.message_uid == NotSet {
            out.message_uid = Set(None);
        }
        if out.datasource_group_id == NotSet {
            out.datasource_group_id = Set(None);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_signal_message_group<'a, 'async_trait, C>(
        txn: &'a C,
        inp: signal_message_group::ActiveModel,
    ) -> Result<signal_message_group::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.signal_message_id == NotSet {
            let signal_message = mk_signal_message(
                txn,
                signal_message::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.signal_message_id = Set(signal_message.id);
        }
        if inp.group_master_key == NotSet {
            let signal_group = mk_signal_group(
                txn,
                signal_group::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.group_master_key = Set(Some(signal_group.master_key));
        }
        if inp.datasource_group_id == NotSet {
            let group_master_key = inp
                .group_master_key
                .clone()
                .take()
                .context(h!())?
                .context(h!())?;
            let datasource_group = mk_datasource_group(
                txn,
                datasource_group::ActiveModel {
                    group_master_key: Set(group_master_key),
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.datasource_group_id = Set(Some(datasource_group.id));
        }
        let out = build_signal_message_group(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_signal_message(
        inp: signal_message::ActiveModel,
    ) -> signal_message::ActiveModel {
        let mut out = inp.clone();
        if out.body == NotSet {
            out.body = Set(Some("message".to_string()));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.timestamp == NotSet {
            out.timestamp = Set(Some(chrono::Utc::now().naive_utc()));
        }
        if out.sender == NotSet {
            out.sender =
                Set(Some(random_word::get(random_word::Lang::En).to_string()));
        }
        if out.format == NotSet {
            out.format = Set(None);
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.external_id == NotSet {
            out.external_id = Set(None);
        }
        if out.message_uid == NotSet {
            out.message_uid =
                Set(Some(random_word::get(random_word::Lang::En).to_string()));
        }
        if out.datasource_group_id == NotSet {
            out.datasource_group_id = Set(None);
        }
        out
    }

    pub async fn mk_signal_message<'a, 'async_trait, C>(
        txn: &'a C,
        inp: signal_message::ActiveModel,
    ) -> Result<signal_message::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.datasource_group_id == NotSet {
            let datasource_group = mk_datasource_group(
                txn,
                datasource_group::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.datasource_group_id = Set(Some(datasource_group.id));
        }
        let out = build_signal_message(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_sigint_network(
        inp: sigint_network::ActiveModel,
    ) -> sigint_network::ActiveModel {
        let mut out = inp.clone();
        if out.name == NotSet {
            out.name = Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.location == NotSet {
            out.location = Set(String::new());
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.updated_by == NotSet {
            out.updated_by = Set(None);
        }
        if out.updated_at == NotSet {
            out.updated_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.radio_station == NotSet {
            out.radio_station = Set(None);
        }
        if out.purpose == NotSet {
            out.purpose = Set(None);
        }
        if out.operation_mode == NotSet {
            out.operation_mode = Set(None);
        }
        if out.operation_type == NotSet {
            out.operation_type = Set(None);
        }
        if out.operation_period == NotSet {
            out.operation_period = Set(None);
        }
        if out.merged_to == NotSet {
            out.merged_to = Set(None);
        }
        if out.active_from == NotSet {
            out.active_from = Set(None);
        }
        if out.active_to == NotSet {
            out.active_to = Set(None);
        }
        if out.sigint_origin_id == NotSet {
            out.sigint_origin_id = Set(None);
        }
        if out.original_id == NotSet {
            out.original_id = Set(None);
        }
        out
    }

    pub async fn mk_sigint_network<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_network::ActiveModel,
    ) -> Result<sigint_network::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_sigint_network(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_sigint_network_aor(
        inp: sigint_network_aor::ActiveModel,
    ) -> Result<sigint_network_aor::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.network_id == NotSet {
            return Err(AppError::from(
                anyhow!("network_id must be set for sigint_network_aor")
                    .context(h!()),
            ));
        }
        if out.aor_id == NotSet {
            return Err(AppError::from(
                anyhow!("aor_id must be set for sigint_network_aor")
                    .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.sigint_origin_id == NotSet {
            out.sigint_origin_id = Set(None);
        }
        if out.original_id == NotSet {
            out.original_id = Set(None);
        }
        Ok(out)
    }

    pub async fn mk_sigint_network_aor<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_network_aor::ActiveModel,
    ) -> Result<sigint_network_aor::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.network_id == NotSet {
            let network = mk_sigint_network(
                txn,
                sigint_network::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.network_id = Set(network.id);
        }
        if inp.aor_id == NotSet {
            let aor = mk_aor(
                txn,
                area_of_responsibility::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.aor_id = Set(aor.id);
        }
        let out = build_sigint_network_aor(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_network_freq(
        inp: sigint_network_freq::ActiveModel,
    ) -> Result<sigint_network_freq::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.network_id == NotSet {
            return Err(AppError::from(
                anyhow!("network_id must be set for sigint_network_freq")
                    .context(h!()),
            ));
        }
        if out.freq == NotSet {
            return Err(AppError::from(
                anyhow!("freq must be set for sigint_network_freq")
                    .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.kind == NotSet {
            out.kind = Set(SigintNetworkKind::Vhf);
        }
        if out.modulation_id == NotSet {
            out.modulation_id = Set(None);
        }
        if out.active_from == NotSet {
            out.active_from = Set(chrono::Utc::now().naive_utc());
        }
        if out.active_to == NotSet {
            out.active_to = Set(None);
        }
        if out.sigint_origin_id == NotSet {
            out.sigint_origin_id = Set(None);
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.original_id == NotSet {
            out.original_id = Set(None);
        }
        if out.last_seen_dt == NotSet {
            out.last_seen_dt = Set(None);
        }
        Ok(out)
    }

    pub async fn mk_sigint_network_freq<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_network_freq::ActiveModel,
    ) -> Result<sigint_network_freq::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.network_id == NotSet {
            let network = mk_sigint_network(
                txn,
                sigint_network::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.network_id = Set(network.id);
        }
        let out = build_sigint_network_freq(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_inbox_item_network(
        inp: sigint_inbox_item_network::ActiveModel,
    ) -> Result<sigint_inbox_item_network::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.sigint_inbox_item_id == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "sigint_inbox_item_id must be set for sigint_inbox_item_network"
                )
                .context(h!()),
            ));
        }
        if out.sigint_network_id == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "sigint_network_id must be set for sigint_inbox_item_network"
                )
                .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_sigint_inbox_item_network<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_inbox_item_network::ActiveModel,
    ) -> Result<sigint_inbox_item_network::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.sigint_inbox_item_id == NotSet {
            let inbox_item = mk_sigint_inbox_item(
                txn,
                sigint_inbox_item::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.sigint_inbox_item_id = Set(inbox_item.id);
        }
        if inp.sigint_network_id == NotSet {
            let network = mk_sigint_network(
                txn,
                sigint_network::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.sigint_network_id = Set(network.id);
        }
        let out = build_sigint_inbox_item_network(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_peleng(
        inp: sigint_peleng::ActiveModel,
    ) -> Result<sigint_peleng::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.source_inbox_item_id == NotSet {
            return Err(AppError::from(
                anyhow!("source_inbox_item_id must be set for sigint_peleng")
                    .context(h!()),
            ));
        }
        if out.lat == NotSet {
            out.lat = Set(0.0);
        }
        if out.lng == NotSet {
            out.lng = Set(0.0);
        }
        if out.settlement == NotSet {
            out.settlement = Set(None);
        }
        if out.locality_direction == NotSet {
            out.locality_direction = Set(None);
        }
        if out.distance_m == NotSet {
            out.distance_m = Set(None);
        }
        if out.country_code == NotSet {
            out.country_code = Set(None);
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.updated_at == NotSet {
            out.updated_at = Set(None);
        }
        Ok(out)
    }

    pub async fn mk_sigint_peleng<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_peleng::ActiveModel,
    ) -> Result<sigint_peleng::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.source_inbox_item_id == NotSet {
            let inbox_item = mk_sigint_inbox_item(
                txn,
                sigint_inbox_item::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.source_inbox_item_id = Set(inbox_item.id);
        }
        let out = build_sigint_peleng(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_freq_location(
        inp: freq_location::ActiveModel,
    ) -> Result<freq_location::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.freq == NotSet {
            return Err(AppError::from(
                anyhow!("freq must be set for freq_location").context(h!()),
            ));
        }
        if out.location == NotSet {
            return Err(AppError::from(
                anyhow!("location must be set for freq_location").context(h!()),
            ));
        }
        if out.datetime == NotSet {
            out.datetime = Set(None);
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_freq_location<'a, 'async_trait, C>(
        txn: &'a C,
        inp: freq_location::ActiveModel,
    ) -> Result<freq_location::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_freq_location(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_bookmark(
        inp: sigint_bookmark::ActiveModel,
    ) -> Result<sigint_bookmark::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.user_id == NotSet {
            return Err(AppError::from(
                anyhow!("user_id must be set for sigint_bookmark")
                    .context(h!()),
            ));
        }
        if out.signal_message_id == NotSet {
            return Err(AppError::from(
                anyhow!("signal_message_id must be set for sigint_bookmark")
                    .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        Ok(out)
    }

    pub async fn mk_sigint_bookmark<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_bookmark::ActiveModel,
    ) -> Result<sigint_bookmark::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.signal_message_id == NotSet {
            let signal_message = mk_signal_message(txn, Default::default())
                .await
                .context(h!())?;
            inp.signal_message_id = Set(signal_message.id);
        }
        if inp.user_id == NotSet {
            inp.user_id = Set(TEST_LOGIN.to_string());
        }
        let out = build_sigint_bookmark(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_important(
        inp: sigint_important::ActiveModel,
    ) -> Result<sigint_important::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.signal_message_id == NotSet {
            return Err(AppError::from(
                anyhow!("signal_message_id must be set for sigint_important")
                    .context(h!()),
            ));
        }
        if out.user_id == NotSet {
            out.user_id = Set(None);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        Ok(out)
    }

    pub async fn mk_sigint_important<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_important::ActiveModel,
    ) -> Result<sigint_important::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.signal_message_id == NotSet {
            let signal_message = mk_signal_message(txn, Default::default())
                .await
                .context(h!())?;
            inp.signal_message_id = Set(signal_message.id);
        }
        let out = build_sigint_important(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_comment(
        inp: sigint_comment::ActiveModel,
    ) -> Result<sigint_comment::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.login == NotSet {
            return Err(AppError::from(
                anyhow!("login must be set for sigint_comment").context(h!()),
            ));
        }
        if out.signal_message_id == NotSet {
            return Err(AppError::from(
                anyhow!("signal_message_id must be set for sigint_comment")
                    .context(h!()),
            ));
        }
        if out.comment == NotSet {
            out.comment = Set(String::new());
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_sigint_comment<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_comment::ActiveModel,
    ) -> Result<sigint_comment::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.signal_message_id == NotSet {
            let signal_message = mk_signal_message(txn, Default::default())
                .await
                .context(h!())?;
            inp.signal_message_id = Set(signal_message.id);
        }
        if inp.login == NotSet {
            inp.login = Set(TEST_LOGIN.to_string());
        }
        let out = build_sigint_comment(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_inbox_item_metadata(
        inp: sigint_inbox_item_metadata::ActiveModel,
    ) -> Result<sigint_inbox_item_metadata::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.sigint_inbox_item_id == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "sigint_inbox_item_id must be set for sigint_inbox_item_metadata"
                )
                .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        Ok(out)
    }

    pub async fn mk_sigint_inbox_item_metadata<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_inbox_item_metadata::ActiveModel,
    ) -> Result<sigint_inbox_item_metadata::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.sigint_inbox_item_id == NotSet {
            let inbox_item = mk_sigint_inbox_item(txn, Default::default())
                .await
                .context(h!())?;
            inp.sigint_inbox_item_id = Set(inbox_item.id);
        }
        let out = build_sigint_inbox_item_metadata(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_unit(
        inp: sigint_unit::ActiveModel,
    ) -> sigint_unit::ActiveModel {
        let mut out = inp.clone();
        if out.company == NotSet {
            out.company = Set(String::new());
        }
        if out.regiment == NotSet {
            out.regiment = Set(String::new());
        }
        if out.division == NotSet {
            out.division = Set(String::new());
        }
        if out.army == NotSet {
            out.army = Set(String::new());
        }
        if out.active == NotSet {
            out.active = Set(true);
        }
        if out.deleted == NotSet {
            out.deleted = Set(false);
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.created_by == NotSet {
            out.created_by = Set(TEST_LOGIN.to_string());
        }
        if out.name == NotSet {
            out.name = Set(random_word::get(random_word::Lang::En).to_string());
        }
        if out.comment == NotSet {
            out.comment = Set(String::new());
        }
        if out.battalion == NotSet {
            out.battalion = Set(String::new());
        }
        if out.sigint_origin_id == NotSet {
            out.sigint_origin_id = Set(None);
        }
        if out.original_id == NotSet {
            out.original_id = Set(None);
        }
        out
    }

    pub async fn mk_sigint_unit<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_unit::ActiveModel,
    ) -> Result<sigint_unit::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let out = build_sigint_unit(inp).insert(txn).await.context(h!())?;
        Ok(out)
    }

    fn build_sigint_network_unit(
        inp: sigint_network_unit::ActiveModel,
    ) -> Result<sigint_network_unit::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.network_id == NotSet {
            return Err(AppError::from(
                anyhow!("network_id must be set for sigint_network_unit")
                    .context(h!()),
            ));
        }
        if out.unit_id == NotSet {
            return Err(AppError::from(
                anyhow!("unit_id must be set for sigint_network_unit")
                    .context(h!()),
            ));
        }
        if out.created_at == NotSet {
            out.created_at = Set(chrono::Utc::now().naive_utc());
        }
        if out.sigint_origin_id == NotSet {
            out.sigint_origin_id = Set(None);
        }
        if out.original_id == NotSet {
            out.original_id = Set(None);
        }
        Ok(out)
    }

    pub async fn mk_sigint_network_unit<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_network_unit::ActiveModel,
    ) -> Result<sigint_network_unit::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.network_id == NotSet {
            let network = mk_sigint_network(txn, Default::default())
                .await
                .context(h!())?;
            inp.network_id = Set(network.id);
        }
        if inp.unit_id == NotSet {
            let unit = mk_sigint_unit(txn, Default::default())
                .await
                .context(h!())?;
            inp.unit_id = Set(unit.id);
        }
        let out = build_sigint_network_unit(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_inbox_item_tag(
        inp: sigint_inbox_item_tag::ActiveModel,
    ) -> Result<sigint_inbox_item_tag::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.sigint_inbox_item_id == NotSet {
            return Err(AppError::from(
                anyhow!(
                    "sigint_inbox_item_id must be set for sigint_inbox_item_tag"
                )
                .context(h!()),
            ));
        }
        if out.tag_id == NotSet {
            return Err(AppError::from(
                anyhow!("tag_id must be set for sigint_inbox_item_tag")
                    .context(h!()),
            ));
        }
        if out.confidence == NotSet {
            out.confidence = Set(1.0);
        }
        if out.login == NotSet {
            out.login = Set(None);
        }
        if out.model == NotSet {
            out.model = Set(None);
        }
        Ok(out)
    }

    pub async fn mk_sigint_inbox_item_tag<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_inbox_item_tag::ActiveModel,
    ) -> Result<sigint_inbox_item_tag::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.sigint_inbox_item_id == NotSet {
            let inbox_item = mk_sigint_inbox_item(txn, Default::default())
                .await
                .context(h!())?;
            inp.sigint_inbox_item_id = Set(inbox_item.id);
        }
        if inp.tag_id == NotSet {
            let tag = mk_tag(txn, Default::default()).await.context(h!())?;
            inp.tag_id = Set(tag.id);
        }
        let out = build_sigint_inbox_item_tag(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }

    fn build_sigint_inbox_item(
        inp: sigint_inbox_item::ActiveModel,
    ) -> Result<sigint_inbox_item::ActiveModel, AppError> {
        let mut out = inp.clone();
        if out.id == NotSet {
            return Err(AppError::from(
                anyhow!("id must be set for sigint_inbox_item").context(h!()),
            ));
        }
        if out.freq == NotSet {
            out.freq = Set(None);
        }
        if out.callsigns == NotSet {
            out.callsigns = Set(None);
        }
        if out.checked == NotSet {
            out.checked = Set(None);
        }
        if out.reviewed == NotSet {
            out.reviewed = Set(None);
        }
        if out.unit_v2 == NotSet {
            out.unit_v2 = Set(None);
        }
        if out.lat == NotSet {
            out.lat = Set(None);
        }
        if out.lng == NotSet {
            out.lng = Set(None);
        }
        if out.tags == NotSet {
            out.tags = Set(None);
        }
        if out.parsed_unit_v2 == NotSet {
            out.parsed_unit_v2 = Set(false);
        }
        Ok(out)
    }

    pub async fn mk_sigint_inbox_item<'a, 'async_trait, C>(
        txn: &'a C,
        inp: sigint_inbox_item::ActiveModel,
    ) -> Result<sigint_inbox_item::Model, AppError>
    where
        C: ConnectionTrait + 'async_trait,
    {
        let mut inp = inp.clone();
        if inp.id == NotSet {
            let msg = mk_signal_message(
                txn,
                signal_message::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
            inp.id = Set(msg.id);
        }
        let out = build_sigint_inbox_item(inp)
            .context(h!())?
            .insert(txn)
            .await
            .context(h!())?;
        Ok(out)
    }
}

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
    use crate::entities::*;
    use crate::types::*;
    use sea_orm::*;

    static MIGRATE: tokio::sync::OnceCell<()> =
        tokio::sync::OnceCell::const_new();

    const TEST_AOR_NAME: &str = "Смуга1";
    const TEST_ORGANISM_NAME: &str = "666ОБ";
    const TEST_DATASOURCE_NAME: &str = "Джерело1";
    const TEST_SIGNAL_GROUP_NAME: &str = "Вухо-Тест";
    const TEST_SIGNAL_GROUP_KEY: &str = "vukho-test-master-key";
    const TEST_SIGINT_ZONE_NAME: &str = "Весь напрямок";
    const TEST_LOGIN: &str = "Tester";
    const TEST_DATASOURCE_GROUP_NAME: &str = "TestDatasourceGroup";
    const TEST_TAG_LABEL_BPLA: &str = "бпла";

    pub async fn cleanup() -> Result<Arc<Env>, AppError> {
        MIGRATE
            .get_or_init(|| async {
                crate::migration::run_migration_1(Mode::Test).await.unwrap();
            })
            .await;
        let env = crate::server::new_env(Mode::Test).await.context(h!())?;
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
        sigint_unit_changelog::Entity::delete_many()
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
        login::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .context(h!())?;
        organism_group::Entity::delete_many()
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
        sigint_zone::Entity::delete_many()
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
        area_of_responsibility::Entity::delete_many()
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

        Ok(())
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

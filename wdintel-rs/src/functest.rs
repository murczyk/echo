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
        signal_attachment::Entity::delete_many()
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

        Ok(env)
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
        if out.signal_docker_port == NotSet {
            out.signal_docker_port = Set(None);
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
            out.status = Set(sea_orm_active_enums::AccountStatus::Ready);
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
}

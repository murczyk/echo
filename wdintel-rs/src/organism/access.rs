use crate::entities::{login, organism, organism_admin, organism_aor};
use crate::types::{AppError, Context, ShortContext};
use crate::{h, users};
use actix_identity::Identity;
use sea_orm::*;
use std::collections::HashSet;
use uuid::Uuid;

pub struct ManagementScope {
    pub organism_ids: Option<Vec<i64>>,
    pub own_organism_id: Option<i64>,
    pub sigint_zone_id: Option<i64>,
}

pub async fn management_scope(
    db: &DatabaseConnection,
    user: &Identity,
) -> Result<ManagementScope, AppError> {
    let id = users::login_id_from_identity(user).c(h!())?;
    let login = users::load_active_login(db, &id).await.c(h!())?;
    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    if users::role_matches(&roles, "Admin").context(h!())? {
        return Ok(ManagementScope {
            organism_ids: None,
            own_organism_id: login.organism_id,
            sigint_zone_id: login.sigint_zone_id,
        });
    }
    let organism_ids = administered_organism_ids(db, id).await.c(h!())?;
    if organism_ids.is_empty() {
        return Err(AppError::Forbidden(
            "Потрібні права адміністратора організму".into(),
        ));
    }
    Ok(ManagementScope {
        organism_ids: Some(organism_ids),
        own_organism_id: login.organism_id,
        sigint_zone_id: login.sigint_zone_id,
    })
}

pub async fn administered_organism_ids<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
) -> anyhow::Result<Vec<i64>> {
    organism_admin::Entity::find()
        .join(
            JoinType::InnerJoin,
            organism_admin::Relation::Organism.def(),
        )
        .filter(organism_admin::Column::LoginId.eq(login_id))
        .filter(organism_admin::Column::Deleted.eq(false))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Enabled.eq(true))
        .select_only()
        .column(organism_admin::Column::OrganismId)
        .order_by_asc(organism_admin::Column::OrganismId)
        .into_tuple()
        .all(db)
        .await
        .c(h!())
}

pub fn ensure_supported_roles(
    roles: Option<&[String]>,
) -> Result<(), AppError> {
    if roles
        .is_some_and(|roles| roles.iter().any(|role| role == "OrganismAdmin"))
    {
        return Err(AppError::Forbidden(
            "Адміністраторів призначають у налаштуваннях організму".into(),
        ));
    }
    Ok(())
}

impl ManagementScope {
    pub fn ensure_organism(&self, id: i64) -> Result<(), AppError> {
        if self
            .organism_ids
            .as_ref()
            .is_some_and(|ids| !ids.contains(&id))
        {
            return Err(AppError::Forbidden(
                "Доступ лише до свого організму".into(),
            ));
        }
        Ok(())
    }

    pub fn ensure_login(&self, login: &login::Model) -> Result<(), AppError> {
        if let Some(ids) = &self.organism_ids {
            if !login.organism_id.is_some_and(|id| ids.contains(&id)) {
                return Err(AppError::Forbidden(
                    "Доступ лише до користувачів свого організму".into(),
                ));
            }
            let roles: Vec<String> =
                serde_json::from_value(login.roles.clone()).c(h!())?;
            if roles.iter().any(|role| protected_role(role)) {
                return Err(AppError::Forbidden(
                    "Привілейованими обліковими записами керує Admin".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn ensure_delta_assignment(
        &self,
        changed: bool,
    ) -> Result<(), AppError> {
        if self.organism_ids.is_some() && changed {
            return Err(AppError::Forbidden(
                "Прив’язками Delta керує Admin".into(),
            ));
        }
        Ok(())
    }

    pub fn ensure_signal_profile_assignment(
        &self,
        changed: bool,
    ) -> Result<(), AppError> {
        if self.organism_ids.is_some() && changed {
            return Err(AppError::Forbidden(
                "Прив’язками Signal-профілів керує Admin".into(),
            ));
        }
        Ok(())
    }

    pub async fn ensure_user_zone<C: ConnectionTrait>(
        &self,
        db: &C,
        organism_id: i64,
        zone: Option<i64>,
    ) -> Result<(), AppError> {
        let Some(zone) = zone.filter(|_| self.organism_ids.is_some()) else {
            return Ok(());
        };
        if self.own_organism_id == Some(organism_id)
            && self.sigint_zone_id == Some(zone)
        {
            return Ok(());
        }
        let available = login::Entity::find()
            .filter(login::Column::OrganismId.eq(organism_id))
            .filter(login::Column::SigintZoneId.eq(zone))
            .filter(login::Column::DeletedPermanently.eq(false))
            .one(db)
            .await
            .c(h!())?
            .is_some();
        if !available {
            return Err(AppError::Forbidden(
                "Напрямок має належати користувачам свого організму".into(),
            ));
        }
        Ok(())
    }

    pub async fn creation_zone<C: ConnectionTrait>(
        &self,
        db: &C,
        organism_id: i64,
        requested: Option<i64>,
    ) -> Result<Option<i64>, AppError> {
        self.ensure_user_zone(db, organism_id, requested)
            .await
            .context(h!())?;
        if self.organism_ids.is_none() {
            return Ok(requested);
        }
        if let Some(zone) = requested.or(self
            .sigint_zone_id
            .filter(|_| self.own_organism_id == Some(organism_id)))
        {
            return Ok(Some(zone));
        }
        let user = login::Entity::find()
            .filter(login::Column::OrganismId.eq(organism_id))
            .filter(login::Column::SigintZoneId.is_not_null())
            .filter(login::Column::DeletedPermanently.eq(false))
            .order_by_asc(login::Column::CreatedAt)
            .one(db)
            .await
            .c(h!())?;
        let zone = user.and_then(|user| user.sigint_zone_id).ok_or_else(|| AppError::BL { msg: "Admin має призначити початковий напрямок користувачам організму".into() }).context(h!())?;
        Ok(Some(zone))
    }

    pub async fn ensure_login_settings<C: ConnectionTrait>(
        &self,
        db: &C,
        organism_id: i64,
        roles: Option<&[String]>,
    ) -> Result<(), AppError> {
        self.ensure_organism(organism_id).context(h!())?;
        ensure_supported_roles(roles).context(h!())?;
        if self.organism_ids.is_none() {
            return Ok(());
        }
        let organism = organism::Entity::find_by_id(organism_id)
            .one(db)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .context(h!())?;
        let allowed: Vec<String> =
            serde_json::from_value(organism.roles).c(h!())?;
        if roles.is_some_and(|roles| {
            roles
                .iter()
                .any(|role| protected_role(role) || !allowed.contains(role))
        }) {
            return Err(AppError::Forbidden("Ролі мають бути дозволені організму та не містити глобальних привілеїв".into()));
        }
        Ok(())
    }

    pub async fn ensure_organism_update<C: ConnectionTrait>(
        &self,
        db: &C,
        req: &super::types::UpdateOrganismReq,
    ) -> Result<(), AppError> {
        self.ensure_organism(req.id).context(h!())?;
        ensure_supported_roles(req.roles.as_deref()).context(h!())?;
        if self.organism_ids.is_none() {
            return Ok(());
        }
        let organism = organism::Entity::find_by_id(req.id)
            .lock_exclusive()
            .one(db)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .context(h!())?;
        let original: Vec<String> =
            serde_json::from_value(organism.roles).c(h!())?;
        let roles = req.roles.as_ref().unwrap_or(&original);
        let original_roles: HashSet<_> = original.iter().collect();
        let requested_roles: HashSet<_> = roles.iter().collect();
        let original_aors: HashSet<i64> = organism_aor::Entity::find()
            .filter(organism_aor::Column::OrganismId.eq(req.id))
            .all(db)
            .await
            .c(h!())?
            .into_iter()
            .map(|aor| aor.aor_id)
            .collect();
        let requested_aors: HashSet<i64> = req
            .aor_ids
            .as_deref()
            .unwrap_or_default()
            .iter()
            .copied()
            .collect();
        if req.parent_id != organism.parent_id
            || original_roles != requested_roles
            || original_aors != requested_aors
        {
            return Err(AppError::Forbidden(
                "Ієрархією, ролями, смугами та доступними групами організму керує Admin".into(),
            ));
        }
        Ok(())
    }
}

pub fn protected_role(role: &str) -> bool {
    matches!(
        role,
        "Admin"
            | "Api"
            | "ApiAgent"
            | "MessengerIngest"
            | "No2FA"
            | "NoAutoLogout"
    )
}

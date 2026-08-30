use crate::entities::*;
use crate::types::*;
use sea_orm::*;
use uuid::Uuid;

pub async fn find_secret<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
) -> anyhow::Result<Option<String>> {
    Ok(login_totp::Entity::find_by_id(login_id)
        .one(db)
        .await
        .c(h!())?
        .map(|row| row.totp_secret)
        .filter(|secret| !secret.is_empty()))
}

pub async fn is_enabled<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
) -> anyhow::Result<bool> {
    Ok(find_secret(db, login_id).await?.is_some())
}

pub async fn clear_secret<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
) -> anyhow::Result<()> {
    login_totp::Entity::delete_by_id(login_id)
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

/// Insert secret only when the login has no TOTP row yet.
/// Returns false when a secret was already configured (stale enroll).
pub async fn insert_secret_if_absent<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
    totp_secret: &str,
) -> anyhow::Result<bool> {
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
INSERT INTO login_totp (login_id, totp_secret)
SELECT $1, $2
WHERE NOT EXISTS (
    SELECT 1 FROM login_totp WHERE login_id = $1
)
            "#,
            [login_id.into(), totp_secret.into()],
        ))
        .await
        .c(h!())?;
    Ok(result.rows_affected() > 0)
}

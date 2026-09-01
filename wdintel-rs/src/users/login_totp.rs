use crate::entities::*;
use crate::types::*;
use sea_orm::*;
use uuid::Uuid;

pub fn epoch_of(login: &login::Model) -> i64 {
    login.totp_epoch.unwrap_or(0)
}

/// Returns decrypted plaintext base32 secret, if enrolled.
pub async fn find_secret<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
    totp_strongbox_key: &str,
) -> anyhow::Result<Option<String>> {
    let Some(ciphertext) = login_totp::Entity::find_by_id(login_id)
        .one(db)
        .await
        .c(h!())?
        .map(|row| row.totp_secret)
        .filter(|secret| !secret.is_empty())
    else {
        return Ok(None);
    };
    Ok(Some(
        super::totp_crypto::decrypt_secret(
            totp_strongbox_key,
            login_id,
            &ciphertext,
        )
        .context(h!())?,
    ))
}

pub async fn is_enabled<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
) -> anyhow::Result<bool> {
    Ok(login_totp::Entity::find_by_id(login_id)
        .one(db)
        .await
        .c(h!())?
        .is_some_and(|row| !row.totp_secret.is_empty()))
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

/// Atomically advance enrollment generation under the login row lock.
pub async fn bump_epoch<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
) -> anyhow::Result<()> {
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
UPDATE login
SET totp_epoch = COALESCE(totp_epoch, 0) + 1
WHERE id = $1
            "#,
            [login_id.into()],
        ))
        .await
        .c(h!())?;
    if result.rows_affected() == 0 {
        bail!("login {login_id} missing while bumping totp_epoch");
    }
    Ok(())
}

/// Insert ciphertext only when the login has no TOTP row yet and still has the
/// enrollment generation captured when the challenge was issued.
/// `FOR UPDATE OF login` waits out concurrent epoch bumps and rechecks the
/// predicate so enroll cannot race an uncommitted admin invalidation.
/// Returns false when a secret was already configured or the epoch advanced
/// (e.g. admin clear after the challenge was claimed).
pub async fn insert_secret_if_absent<C: ConnectionTrait>(
    db: &C,
    login_id: Uuid,
    totp_secret_ciphertext: &str,
    expected_epoch: i64,
) -> anyhow::Result<bool> {
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
INSERT INTO login_totp (login_id, totp_secret)
SELECT $1, $2
FROM login
WHERE login.id = $1
  AND COALESCE(login.totp_epoch, 0) = $3
  AND NOT EXISTS (
    SELECT 1 FROM login_totp WHERE login_id = $1
)
FOR UPDATE OF login
            "#,
            [
                login_id.into(),
                totp_secret_ciphertext.into(),
                expected_epoch.into(),
            ],
        ))
        .await
        .c(h!())?;
    Ok(result.rows_affected() > 0)
}

use crate::config::{
    TOTP_2FA_DIGITS, TOTP_2FA_ISSUER, TOTP_2FA_SKEW, TOTP_2FA_STEP_SEC,
};
use crate::types::*;
use anyhow::anyhow;
use totp_rs::{Algorithm, Secret, TOTP};

pub struct TotpEnrollment {
    pub secret_base32: String,
    pub qr_base64: String,
    pub manual_key: String,
}

pub fn generate_enrollment(account_name: &str) -> anyhow::Result<TotpEnrollment> {
    let secret = Secret::generate_secret().to_encoded();
    let secret_base32 = match secret {
        Secret::Encoded(s) => s,
        Secret::Raw(_) => {
            return Err(anyhow!("expected encoded totp secret")).c(h!());
        }
    };
    let qr_base64 = qr_base64_for_secret(&secret_base32, account_name)
        .context(h!())?;
    Ok(TotpEnrollment {
        manual_key: secret_base32.clone(),
        secret_base32,
        qr_base64,
    })
}

pub fn qr_base64_for_secret(
    secret_base32: &str,
    account_name: &str,
) -> anyhow::Result<String> {
    totp_for_secret(secret_base32, account_name)
        .context(h!())?
        .get_qr_base64()
        .map_err(|err| anyhow!("totp qr encode failed: {err}"))
        .c(h!())
}

pub fn verify_token(secret_base32: &str, token: &str) -> anyhow::Result<bool> {
    let totp = totp_for_secret(secret_base32, "").context(h!())?;
    totp.check_current(token).c(h!())
}

fn totp_for_secret(
    secret_base32: &str,
    account_name: &str,
) -> anyhow::Result<TOTP> {
    let secret_bytes = Secret::Encoded(secret_base32.to_string())
        .to_bytes()
        .map_err(|err| anyhow!("invalid totp secret: {err}"))
        .c(h!())?;
    TOTP::new(
        Algorithm::SHA1,
        TOTP_2FA_DIGITS,
        TOTP_2FA_SKEW,
        TOTP_2FA_STEP_SEC,
        secret_bytes,
        Some(TOTP_2FA_ISSUER.to_string()),
        account_name.to_string(),
    )
    .map_err(|err| anyhow!("totp build failed: {err}"))
    .c(h!())
}

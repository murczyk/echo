use crate::config::{
    TOTP_2FA_DIGITS, TOTP_2FA_ISSUER, TOTP_2FA_SKEW, TOTP_2FA_STEP_SEC,
};
use crate::types::*;
use anyhow::anyhow;
use std::time::{SystemTime, UNIX_EPOCH};
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

/// Returns the matched TOTP counter (`unix_time / step`) when `token` is valid
/// within the configured skew window; `None` when the token does not match.
pub fn verify_token(
    secret_base32: &str,
    token: &str,
) -> anyhow::Result<Option<u64>> {
    let totp = totp_for_secret(secret_base32, "").context(h!())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| anyhow!("system clock before unix epoch: {err}"))
        .c(h!())?
        .as_secs();
    Ok(matching_step(&totp, token, now))
}

fn matching_step(totp: &TOTP, token: &str, time: u64) -> Option<u64> {
    let base_step = time / totp.step - u64::from(totp.skew);
    for i in 0..(u16::from(totp.skew) * 2 + 1) {
        let step = base_step + u64::from(i);
        let step_time = step * totp.step;
        if totp.generate(step_time) == token {
            return Some(step);
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_step_returns_counter_for_current_token() {
        let enrollment = generate_enrollment("test").unwrap();
        let totp = totp_for_secret(&enrollment.secret_base32, "").unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let token = totp.generate_current().unwrap();
        let step = matching_step(&totp, &token, now).unwrap();
        assert_eq!(step, now / TOTP_2FA_STEP_SEC);
        assert!(matching_step(&totp, "000000", now).is_none());
    }
}

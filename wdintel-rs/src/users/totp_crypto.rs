use crate::storage::key_from_b64;
use crate::types::*;
use anyhow::anyhow;
use base64::Engine;
use strong_box::{StaticStrongBox, StrongBox};
use uuid::Uuid;

const TOTP_SECRET_AAD_PREFIX: &str = "echo/login_totp/";

fn aad(login_id: Uuid) -> String {
    format!("{TOTP_SECRET_AAD_PREFIX}{login_id}")
}

fn strongbox(key_b64: &str) -> anyhow::Result<StaticStrongBox> {
    let key = key_from_b64(key_b64)
        .map_err(|err| anyhow!("invalid totp_strongbox_key: {err}"))
        .c(h!())?;
    Ok(StaticStrongBox::new(key.clone(), vec![key]))
}

/// Encrypt a TOTP seed for Redis challenge / `login_totp` storage.
pub fn encrypt_secret(
    key_b64: &str,
    login_id: Uuid,
    plaintext_base32: &str,
) -> anyhow::Result<String> {
    let sb = strongbox(key_b64).context(h!())?;
    let ciphertext = sb
        .encrypt(plaintext_base32.as_bytes(), aad(login_id).as_bytes())
        .map_err(|err| anyhow!("totp secret encrypt failed: {err}"))
        .c(h!())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(ciphertext))
}

/// Decrypt a TOTP seed previously produced by [`encrypt_secret`].
pub fn decrypt_secret(
    key_b64: &str,
    login_id: Uuid,
    ciphertext_b64: &str,
) -> anyhow::Result<String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64.trim())
        .map_err(|err| anyhow!("totp secret ciphertext decode failed: {err}"))
        .c(h!())?;
    let sb = strongbox(key_b64).context(h!())?;
    let plaintext = sb
        .decrypt(&raw, aad(login_id).as_bytes())
        .map_err(|err| anyhow!("totp secret decrypt failed: {err}"))
        .c(h!())?;
    String::from_utf8(plaintext)
        .map_err(|err| anyhow!("totp secret plaintext utf8 failed: {err}"))
        .c(h!())
}

pub fn require_totp_strongbox_key(key: Option<&str>) -> anyhow::Result<&str> {
    key.map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "totp_strongbox_key is missing in config.toml; run \
                 oneoff-generate-strongbox-key and set totp_strongbox_key"
            )
        })
        .c(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::generate_strongbox_key_b64;

    #[test]
    fn encrypt_decrypt_roundtrip_is_bound_to_login() {
        let key = generate_strongbox_key_b64();
        let login_id = Uuid::new_v4();
        let other_login = Uuid::new_v4();
        let plaintext = "JBSWY3DPEHPK3PXP";
        let ciphertext =
            encrypt_secret(&key, login_id, plaintext).expect("encrypt");
        assert_ne!(ciphertext, plaintext);
        assert_eq!(
            decrypt_secret(&key, login_id, &ciphertext).expect("decrypt"),
            plaintext
        );
        assert!(decrypt_secret(&key, other_login, &ciphertext).is_err());
    }
}

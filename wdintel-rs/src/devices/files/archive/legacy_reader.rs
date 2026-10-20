use anyhow::Context;
use std::{
    fs::File,
    io::{Read, Seek, Write},
};

use anyhow::{ensure, Result};
use hmac::{Hmac, Mac};
use openssl::symm::{Cipher, Crypter, Mode};
use sha2::{Digest, Sha256};

use crate::{devices::config::*, h, types::ShortContext};

pub(super) fn decrypt(
    mut input: impl Read,
    key: &[u8; 32],
    aad: &[u8],
    size: u64,
    sha256: &[u8; 32],
    quarantine: &mut File,
) -> Result<()> {
    quarantine.set_len(0).c(h!())?;
    quarantine.rewind().c(h!())?;
    let result = decrypt_inner(&mut input, key, aad, size, sha256, quarantine);
    if result.is_err() {
        quarantine.set_len(0).c(h!())?;
        quarantine.rewind().c(h!())?;
    }
    result
}

fn decrypt_inner(
    input: &mut impl Read,
    key: &[u8; 32],
    aad: &[u8],
    size: u64,
    sha256: &[u8; 32],
    quarantine: &mut File,
) -> Result<()> {
    ensure!(
        size <= DEVICE_FILE_ARCHIVE_SOURCE_MAX_BYTES,
        "source size limit"
    );
    ensure!(
        aad.len() as u64 <= DEVICE_FILE_ARCHIVE_PROTOCOL_MAX_BYTES as u64,
        "AAD size limit"
    );
    let mut magic = [0; 3];
    input.read_exact(&mut magic).c(h!())?;
    ensure!(magic == [0xb1, 0xb8, 0xf5], "invalid StrongBox magic");
    ensure!(
        header(input, 4).context(h!())? == 3,
        "invalid StrongBox tuple"
    );
    let key_id = byte_array::<16>(input).context(h!())?;
    let nonce = byte_array::<12>(input).context(h!())?;
    let mut derivation = Hmac::<Sha256>::new_from_slice(key).c(h!())?;
    derivation.update(b"key_id\x01");
    ensure!(
        openssl::memcmp::eq(&key_id, &derivation.finalize().into_bytes()[..16]),
        "unknown StrongBox key"
    );
    ensure!(
        header(input, 2).context(h!())? == size.checked_add(16).c(h!())?,
        "ciphertext length mismatch"
    );
    let mut cipher = Crypter::new(
        Cipher::chacha20_poly1305(),
        Mode::Decrypt,
        key,
        Some(&nonce),
    )
    .c(h!())?;
    cipher.pad(false);
    cipher.aad_update(aad).c(h!())?;
    cipher.aad_update(&key_id).c(h!())?;
    cipher.aad_update(&nonce).c(h!())?;
    let digest =
        decrypt_body(input, &mut cipher, quarantine, size).context(h!())?;
    let mut tag = [0; 16];
    input.read_exact(&mut tag).c(h!())?;
    cipher.set_tag(&tag).c(h!())?;
    let mut final_bytes = [0; 16];
    ensure!(
        cipher.finalize(&mut final_bytes).c(h!())? == 0,
        "unexpected trailing plaintext"
    );
    ensure!(
        input.read(&mut [0]).c(h!())? == 0,
        "trailing StrongBox bytes"
    );
    ensure!(
        openssl::memcmp::eq(&digest, sha256),
        "source digest mismatch"
    );
    ensure!(
        quarantine.metadata().c(h!())?.len() == size,
        "source size mismatch"
    );
    quarantine.sync_all().c(h!())?;
    Ok(())
}

fn decrypt_body(
    input: &mut impl Read,
    cipher: &mut Crypter,
    output: &mut File,
    size: u64,
) -> Result<[u8; 32]> {
    let mut encrypted = vec![0; DEVICE_FILE_ARCHIVE_INFLATE_BUFFER_BYTES];
    let mut plaintext = vec![0; encrypted.len() + 16];
    let mut digest = Sha256::new();
    let mut remaining = size;
    while remaining > 0 {
        let count = encrypted.len().min(remaining as usize);
        input.read_exact(&mut encrypted[..count]).c(h!())?;
        let written =
            cipher.update(&encrypted[..count], &mut plaintext).c(h!())?;
        ensure!(written == count, "unexpected streaming cipher length");
        output.write_all(&plaintext[..written]).c(h!())?;
        digest.update(&plaintext[..written]);
        remaining -= count as u64;
    }
    Ok(digest.finalize().into())
}

fn byte_array<const N: usize>(input: &mut impl Read) -> Result<[u8; N]> {
    ensure!(
        header(input, 2).context(h!())? == N as u64,
        "invalid StrongBox byte field"
    );
    let mut bytes = [0; N];
    input.read_exact(&mut bytes).c(h!())?;
    Ok(bytes)
}

fn header(input: &mut impl Read, major: u8) -> Result<u64> {
    let mut first = [0];
    input.read_exact(&mut first).c(h!())?;
    ensure!(first[0] >> 5 == major, "invalid CBOR field");
    let value = first[0] & 31;
    if value < 24 {
        return Ok(u64::from(value));
    }
    let length = match value {
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        _ => anyhow::bail!("indefinite or reserved CBOR field"),
    };
    let mut bytes = [0; 8];
    input.read_exact(&mut bytes[8 - length..]).c(h!())?;
    Ok(u64::from_be_bytes(bytes))
}

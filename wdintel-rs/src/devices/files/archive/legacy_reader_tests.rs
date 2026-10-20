use super::legacy_reader::decrypt;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Seek};
use strong_box::{StaticStrongBox, StrongBox};

const KEY: [u8; 32] = [0x42; 32];
const AAD: &[u8] = b"private-bucket/device-files/exact-object";

fn encrypt(plaintext: &[u8]) -> Vec<u8> {
    StaticStrongBox::new(Box::new(KEY), [Box::new(KEY)])
        .encrypt(plaintext, AAD)
        .unwrap()
}

struct Chunks<R>(R, usize);

impl<R: Read> Read for Chunks<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let bound = bytes.len().min(self.1);
        self.0.read(&mut bytes[..bound])
    }
}

fn roundtrip(plaintext: &[u8], chunk: usize) {
    let ciphertext = encrypt(plaintext);
    let mut quarantine = tempfile::tempfile().unwrap();
    decrypt(
        Chunks(Cursor::new(ciphertext), chunk),
        &KEY,
        AAD,
        plaintext.len() as u64,
        &Sha256::digest(plaintext).into(),
        &mut quarantine,
    )
    .expect("StrongBox 0.5.1 bytes must verify with bounded reads");
    quarantine.rewind().unwrap();
    let mut actual = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let count = quarantine.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        actual.update(&buffer[..count]);
    }
    assert_eq!(actual.finalize(), Sha256::digest(plaintext));
    assert_eq!(quarantine.metadata().unwrap().len(), plaintext.len() as u64);
}

#[test]
fn legacy_strongbox_large_content_is_streamed_and_verified() {
    let plaintext = vec![0xa5; 100 * 1024 * 1024 + 17];
    roundtrip(&plaintext, 65_537);
}

#[test]
fn legacy_strongbox_chunk_boundaries_and_empty_content() {
    for length in [0, 1, 15, 16, 17, 255, 256, 65_535, 65_536] {
        roundtrip(&vec![0x7f; length], 7);
    }
}

#[test]
fn legacy_strongbox_rejects_key_aad_tag_size_hash_and_envelope() {
    let plaintext = b"authenticated content that must remain private";
    let good = encrypt(plaintext);
    let hash: [u8; 32] = Sha256::digest(plaintext).into();
    let mut bad_tag = good.clone();
    *bad_tag.last_mut().unwrap() ^= 1;
    let mut bad_magic = good.clone();
    bad_magic[0] ^= 1;
    let mut bad_array = good.clone();
    bad_array[3] = 0x84;
    let mut trailing = good.clone();
    trailing.push(0);
    let mut huge_bytes = good.clone();
    huge_bytes
        .splice(34.., [0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    let size = plaintext.len() as u64;
    let mut cases = vec![
        (good.clone(), [0x41; 32], AAD, size, hash),
        (
            good.clone(),
            KEY,
            b"other-bucket/object".as_slice(),
            size,
            hash,
        ),
        (good.clone(), KEY, AAD, size + 1, hash),
        (good.clone(), KEY, AAD, size, [0; 32]),
    ];
    for ciphertext in [bad_tag, bad_magic, bad_array, trailing, huge_bytes] {
        cases.push((ciphertext, KEY, AAD, size, hash));
    }
    for length in [0, 1, 3, 4, 21, 33, good.len() - 1] {
        cases.push((good[..length].to_vec(), KEY, AAD, size, hash));
    }
    for (ciphertext, key, aad, size, hash) in cases {
        let mut quarantine = tempfile::tempfile().unwrap();
        assert!(decrypt(
            Chunks(Cursor::new(ciphertext), 11),
            &key,
            aad,
            size,
            &hash,
            &mut quarantine,
        )
        .is_err());
        assert_eq!(
            quarantine.metadata().unwrap().len(),
            0,
            "failed authentication must discard provisional plaintext"
        );
    }
}

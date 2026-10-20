use super::{
    extract::{self, Meter},
    manifest::{self, Limits},
    manifest_fixtures::{archive, Entry},
};
use std::io::{Cursor, Read, Seek, Write};

#[derive(Default)]
struct Budget {
    available: u64,
    pending: u64,
    used: u64,
}
impl Meter for Budget {
    fn reserve(&mut self, wanted: u64) -> anyhow::Result<u64> {
        anyhow::ensure!(self.pending == 0, "one grant at a time");
        self.pending = wanted.min(self.available).min(7);
        anyhow::ensure!(self.pending > 0, "root budget exhausted");
        Ok(self.pending)
    }
    fn settle(&mut self, used: u64) -> anyhow::Result<()> {
        anyhow::ensure!(used <= self.pending, "overspent grant");
        self.used += used;
        self.available -= used;
        self.pending = 0;
        Ok(())
    }
}

fn compressed(bytes: &[u8]) -> Entry {
    let mut entry = Entry::file("member.bin");
    entry.method = 8;
    entry.size = bytes.len() as u64;
    entry.crc32 = crc32fast::hash(bytes);
    let mut encoder = flate2::write::DeflateEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    );
    encoder.write_all(bytes).unwrap();
    entry.data = encoder.finish().unwrap();
    entry
}

#[test]
fn stored_deflate_empty_and_multiple_short_grants_preserve_exact_bytes_3778() {
    let bytes = b"bounded member bytes with several grants";
    for entry in [Entry::file("stored"), compressed(bytes), compressed(b"")] {
        let expected = if entry.method == 0 {
            b"A".as_slice()
        } else if entry.size == 0 {
            b"".as_slice()
        } else {
            bytes.as_slice()
        };
        let archive = archive(&[entry], true);
        let mut input = Cursor::new(&archive);
        let manifest = manifest::read(
            &mut input,
            archive.len() as u64,
            &Limits::default(),
        )
        .unwrap();
        let mut output = tempfile::tempfile().unwrap();
        let mut budget = Budget {
            available: expected.len() as u64,
            ..Default::default()
        };
        let verified = extract::inflate(
            &mut input,
            &mut output,
            &manifest.members[0],
            &mut budget,
        )
        .unwrap();
        output.rewind().unwrap();
        let mut actual = Vec::new();
        output.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(verified.size, expected.len() as u64);
        assert_eq!(verified.crc32, crc32fast::hash(expected));
        use sha2::Digest;
        assert_eq!(
            verified.sha256,
            <[u8; 32]>::from(sha2::Sha256::digest(expected))
        );
        assert_eq!(budget.used, expected.len() as u64);
    }
}

#[test]
fn invalid_crc_size_truncated_and_trailing_deflate_never_leave_output_3778() {
    let valid = compressed(b"hello");
    let mut crc = valid.clone();
    crc.crc32 ^= 1;
    let mut size = valid.clone();
    size.size -= 1;
    let mut truncated = valid.clone();
    truncated.data.pop();
    let mut trailing = valid;
    trailing.data.push(0);
    for entry in [crc, size, truncated, trailing] {
        let archive = archive(&[entry], false);
        let mut input = Cursor::new(&archive);
        let manifest = manifest::read(
            &mut input,
            archive.len() as u64,
            &Limits::default(),
        )
        .unwrap();
        let mut output = tempfile::tempfile().unwrap();
        let mut budget = Budget {
            available: 100,
            ..Default::default()
        };
        assert!(extract::inflate(
            &mut input,
            &mut output,
            &manifest.members[0],
            &mut budget
        )
        .is_err());
        assert_eq!(output.metadata().unwrap().len(), 0);
    }
}

#[test]
fn exhausted_grant_stops_inflation_without_publishing_partial_bytes_3778() {
    let archive = archive(&[compressed(b"longer than the grant")], false);
    let mut input = Cursor::new(&archive);
    let manifest =
        manifest::read(&mut input, archive.len() as u64, &Limits::default())
            .unwrap();
    let mut output = tempfile::tempfile().unwrap();
    let mut budget = Budget {
        available: 8,
        ..Default::default()
    };
    assert!(extract::inflate(
        &mut input,
        &mut output,
        &manifest.members[0],
        &mut budget
    )
    .is_err());
    assert_eq!(budget.used, 8);
    assert_eq!(output.metadata().unwrap().len(), 0);
}

#[test]
fn archive_truncated_staged_payload_is_terminal_and_leaves_no_output_3778() {
    for entry in [Entry::file("stored"), compressed(b"bounded deflate")] {
        let bytes = archive(&[entry], false);
        let manifest = manifest::read(
            &mut Cursor::new(&bytes),
            bytes.len() as u64,
            &Limits::default(),
        )
        .unwrap();
        let member = &manifest.members[0];
        let mut input = Cursor::new(&bytes[..member.data_offset as usize]);
        let mut output = tempfile::tempfile().unwrap();
        let mut budget = Budget {
            available: 100,
            ..Default::default()
        };
        let failure =
            extract::inflate(&mut input, &mut output, member, &mut budget)
                .unwrap_err();
        assert_eq!(
            super::error::classify(&failure),
            (Some("integrity_mismatch"), None)
        );
        assert_eq!(output.metadata().unwrap().len(), 0);
    }
}

use super::{
    manifest::{self, Limits},
    manifest_fixtures::{archive, Entry},
};
use std::io::Cursor;

fn parse(bytes: &[u8]) -> anyhow::Result<manifest::Manifest> {
    manifest::read(
        &mut Cursor::new(bytes),
        bytes.len() as u64,
        &Limits::default(),
    )
}

#[test]
fn empty_zip_is_a_valid_empty_manifest_3778() {
    for zip64 in [false, true] {
        let result = parse(&archive(&[], zip64)).unwrap();
        assert!(result.members.is_empty());
        assert_eq!(result.records, 0);
    }
}

#[test]
fn stored_and_deflated_zip64_preserve_names_offsets_and_ordinals_3778() {
    for zip64 in [false, true] {
        let mut compressed = Entry::file("report.txt");
        compressed.method = 8;
        compressed.data = vec![0x73, 0x04, 0x00];
        compressed.flags = 8;
        let bytes = archive(&[Entry::file("Report.txt"), compressed], zip64);
        let result = parse(&bytes).unwrap();
        assert_eq!(result.records, 2);
        assert_eq!(result.members.len(), 2);
        let first = &result.members[0];
        let second = &result.members[1];
        assert_eq!(
            (&*first.path, first.ordinal, first.method, first.size),
            ("Report.txt", Some(0), 0, 1)
        );
        assert_eq!(
            (&*second.path, second.ordinal, second.method, second.size),
            ("report.txt", Some(1), 8, 1)
        );
        assert_eq!(
            &bytes[first.data_offset as usize..]
                [..first.compressed_size as usize],
            b"A"
        );
        assert_eq!(
            &bytes[second.data_offset as usize..]
                [..second.compressed_size as usize],
            &[0x73, 0x04, 0x00]
        );
    }
}

#[test]
fn explicit_directory_completes_inferred_parent_without_duplicate_3778() {
    let result = parse(&archive(
        &[Entry::file("dir/file"), Entry::directory("dir/")],
        false,
    ))
    .unwrap();
    assert_eq!(result.members.len(), 2);
    assert_eq!(result.members[0].path, "dir");
    assert!(result.members[0].directory);
    assert!(!result.members[0].inferred);
    assert_eq!(result.members[0].ordinal, Some(1));
    assert_eq!(result.members[1].ordinal, Some(0));
}

#[test]
fn utf8_and_cp437_preserve_exact_names_3778() {
    let mut utf8 = Entry::file("звіт.txt");
    utf8.flags = 0x800;
    let mut cp437 = Entry::file("old.txt");
    cp437.name = vec![0x82, b'.', b't', b'x', b't'];
    let bytes = archive(&[utf8, cp437], false);
    let result = parse(&bytes).unwrap();
    let names: Vec<_> =
        result.members.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(names, vec!["é.txt", "звіт.txt"]);
}

#[test]
fn unicode_path_requires_matching_crc_and_unambiguous_utf8_3778() {
    let mut entry = Entry::file("legacy.txt");
    let mut payload = vec![1];
    payload.extend(crc32fast::hash(&entry.name).to_le_bytes());
    payload.extend("звіт.txt".as_bytes());
    entry.extra.extend(0x7075u16.to_le_bytes());
    entry.extra.extend((payload.len() as u16).to_le_bytes());
    entry.extra.extend(&payload);
    assert_eq!(
        parse(&archive(&[entry], false)).unwrap().members[0].path,
        "звіт.txt"
    );
    let mut invalid = Entry::file("legacy.txt");
    payload[1] ^= 1;
    invalid.extra.extend(0x7075u16.to_le_bytes());
    invalid.extra.extend((payload.len() as u16).to_le_bytes());
    invalid.extra.extend(&payload);
    assert_eq!(
        parse(&archive(&[invalid], false)).unwrap().members[0].path,
        "legacy.txt"
    );
    let mut conflict = Entry::file("legacy.txt");
    conflict.flags = 0x800;
    payload[1] ^= 1;
    conflict.extra.extend(0x7075u16.to_le_bytes());
    conflict.extra.extend((payload.len() as u16).to_le_bytes());
    conflict.extra.extend(&payload);
    assert!(parse(&archive(&[conflict], false)).is_err());
}

#[test]
fn denied_preflight_grant_prevents_the_next_read_3778() {
    use std::{
        cell::Cell,
        io::{Read, Seek, SeekFrom},
        rc::Rc,
    };
    struct Reader {
        bytes: Cursor<Vec<u8>>,
        reads: Rc<Cell<usize>>,
    }
    impl Read for Reader {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.reads.set(self.reads.get() + 1);
            self.bytes.read(bytes)
        }
    }
    impl Seek for Reader {
        fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
            self.bytes.seek(from)
        }
    }
    let bytes = archive(&[Entry::file("member")], false);
    let size = bytes.len() as u64;
    let reads = Rc::new(Cell::new(0));
    let mut input = Reader {
        bytes: Cursor::new(bytes),
        reads: reads.clone(),
    };
    let result =
        manifest::read_metered(&mut input, size, &Limits::default(), |_, _| {
            anyhow::bail!("no durable grant")
        });
    assert!(format!("{:#}", result.unwrap_err()).contains("no durable grant"));
    assert_eq!(reads.get(), 0);
}

#[test]
fn zip64_offsets_above_four_gib_are_not_truncated_3778() {
    use std::io::{Seek, SeekFrom, Write};
    let mut bytes = archive(&[Entry::file("large-offset.txt")], true);
    let find = |signature: &[u8]| {
        bytes.windows(4).position(|part| part == signature).unwrap()
    };
    let central = find(b"PK\x01\x02");
    let end = find(b"PK\x06\x06");
    let locator = find(b"PK\x06\x07");
    let base = 4_294_967_296u64 + 17;
    let offset_field = central + 46 + "large-offset.txt".len() + 4 + 16;
    bytes[offset_field..offset_field + 8].copy_from_slice(&base.to_le_bytes());
    bytes[end + 48..end + 56]
        .copy_from_slice(&(base + central as u64).to_le_bytes());
    bytes[locator + 8..locator + 16]
        .copy_from_slice(&(base + end as u64).to_le_bytes());
    let mut source = tempfile::tempfile().unwrap();
    source.seek(SeekFrom::Start(base)).unwrap();
    source.write_all(&bytes).unwrap();
    let result = manifest::read(
        &mut source,
        base + bytes.len() as u64,
        &Limits::default(),
    )
    .unwrap();
    assert_eq!(
        result.members[0].data_offset,
        base + 30 + "large-offset.txt".len() as u64 + 20
    );
    assert_eq!(result.members[0].size, 1);
}

#[test]
fn unsafe_paths_and_exact_duplicates_are_rejected_before_inflate_3778() {
    for name in [
        "../a", "/a", "C:/a", "a\\b", "a//b", "a/./b", "a/../b", "a\0b", "",
    ] {
        assert!(
            parse(&archive(&[Entry::file(name)], false)).is_err(),
            "{name:?}"
        );
    }
    for entries in [
        vec![Entry::file("a"), Entry::file("a")],
        vec![Entry::file("a"), Entry::file("a/b")],
        vec![Entry::directory("a/"), Entry::file("a")],
    ] {
        assert!(parse(&archive(&entries, false)).is_err());
    }
}

#[test]
fn passwords_symlinks_unsupported_methods_and_invalid_utf8_are_rejected_3778() {
    let mut password = Entry::file("private");
    password.flags = 1;
    let mut symlink = Entry::file("link");
    symlink.attributes = 0o120777 << 16;
    let mut method = Entry::file("unsupported");
    method.method = 12;
    let mut utf8 = Entry::file("invalid");
    utf8.flags = 0x800;
    utf8.name = vec![0xff];
    for entry in [password, symlink, method, utf8] {
        assert!(parse(&archive(&[entry], false)).is_err());
    }
}

#[test]
fn local_header_mismatch_payload_alias_and_truncation_are_rejected_3778() {
    let original =
        archive(&[Entry::file("first"), Entry::file("second")], false);
    let mut mismatch = original.clone();
    mismatch[30] = b'x';
    assert!(parse(&mismatch).is_err());
    let mut alias = original.clone();
    let central: Vec<_> = alias
        .windows(4)
        .enumerate()
        .filter(|(_, b)| *b == b"PK\x01\x02")
        .map(|(i, _)| i)
        .collect();
    alias[central[1] + 42..central[1] + 46]
        .copy_from_slice(&0u32.to_le_bytes());
    assert!(parse(&alias).is_err());
    for length in [0, 3, original.len() - 1] {
        assert!(parse(&original[..length]).is_err());
    }
}

#[test]
fn bounded_manifest_rejects_metadata_records_and_implicit_node_excess_3778() {
    let bytes = archive(&[Entry::file("a/b/c")], false);
    for limits in [
        Limits {
            directory_bytes: 1,
            ..Limits::default()
        },
        Limits {
            records: 0,
            ..Limits::default()
        },
        Limits {
            nodes: 2,
            ..Limits::default()
        },
        Limits {
            path_components: 2,
            ..Limits::default()
        },
    ] {
        assert!(manifest::read(
            &mut Cursor::new(&bytes),
            bytes.len() as u64,
            &limits
        )
        .is_err());
    }
    assert_eq!(parse(&bytes).unwrap().members.len(), 3);
}

#[test]
fn zip64_offset_only_preserves_classic_descriptor_width_3778() {
    let mut entry = Entry::file("offset-only.txt");
    entry.flags = 8;
    let mut bytes = archive(&[entry], false);
    let central = bytes
        .windows(4)
        .position(|part| part == [0x50, 0x4b, 0x01, 0x02])
        .unwrap();
    let name_length = u16::from_le_bytes(
        bytes[central + 28..central + 30].try_into().unwrap(),
    ) as usize;
    let offset = u32::from_le_bytes(
        bytes[central + 42..central + 46].try_into().unwrap(),
    );
    bytes[central + 42..central + 46].copy_from_slice(&u32::MAX.to_le_bytes());
    bytes[central + 30..central + 32].copy_from_slice(&12_u16.to_le_bytes());
    bytes[central + 6..central + 8].copy_from_slice(&45_u16.to_le_bytes());
    let mut extra = vec![1, 0, 8, 0];
    extra.extend((offset as u64).to_le_bytes());
    bytes.splice(
        central + 46 + name_length..central + 46 + name_length,
        extra,
    );
    let eocd = bytes.len() - 22;
    let size =
        u32::from_le_bytes(bytes[eocd + 12..eocd + 16].try_into().unwrap())
            + 12;
    bytes[eocd + 12..eocd + 16].copy_from_slice(&size.to_le_bytes());
    let manifest = manifest::read(
        &mut Cursor::new(&bytes),
        bytes.len() as u64,
        &Limits::default(),
    )
    .unwrap();
    assert_eq!(manifest.members[0].path, "offset-only.txt");
    assert_eq!(manifest.members[0].size, 1);
}

#[test]
fn deflated_directories_require_a_verified_empty_stream_3778() {
    use std::io::Write;
    for compression in
        [flate2::Compression::default(), flate2::Compression::none()]
    {
        for contents in [b"".as_slice(), b"not empty".as_slice()] {
            let mut entry = Entry::directory("directory/");
            entry.method = 8;
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), compression);
            encoder.write_all(contents).unwrap();
            entry.data = encoder.finish().unwrap();
            let bytes = archive(&[entry.clone()], false);
            let result = manifest::read(
                &mut Cursor::new(&bytes),
                bytes.len() as u64,
                &Limits::default(),
            );
            assert_eq!(result.is_ok(), contents.is_empty(), "{result:?}");
            entry.data.push(0);
            let bytes = archive(&[entry], false);
            assert!(manifest::read(
                &mut Cursor::new(&bytes),
                bytes.len() as u64,
                &Limits::default()
            )
            .is_err());
        }
    }
}

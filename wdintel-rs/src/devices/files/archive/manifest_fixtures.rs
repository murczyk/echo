#[derive(Clone)]
pub(super) struct Entry {
    pub name: Vec<u8>,
    pub data: Vec<u8>,
    pub flags: u16,
    pub method: u16,
    pub size: u64,
    pub crc32: u32,
    pub extra: Vec<u8>,
    pub attributes: u32,
}

impl Entry {
    pub fn file(name: &str) -> Self {
        Self {
            name: name.as_bytes().to_vec(),
            data: vec![b'A'],
            flags: 0,
            method: 0,
            size: 1,
            crc32: 0xd3d99e8b,
            extra: vec![],
            attributes: 0o100644 << 16,
        }
    }

    pub fn directory(name: &str) -> Self {
        Self {
            data: vec![],
            size: 0,
            crc32: 0,
            attributes: (0o40755 << 16) | 16,
            ..Self::file(name)
        }
    }
}

fn u16le(out: &mut Vec<u8>, value: u16) {
    out.extend(value.to_le_bytes());
}
fn u32le(out: &mut Vec<u8>, value: u32) {
    out.extend(value.to_le_bytes());
}
fn u64le(out: &mut Vec<u8>, value: u64) {
    out.extend(value.to_le_bytes());
}

pub(super) fn archive(entries: &[Entry], zip64: bool) -> Vec<u8> {
    let mut bytes = vec![];
    let mut offsets = vec![];
    for entry in entries {
        offsets.push(bytes.len() as u64);
        let mut extra = entry.extra.clone();
        if zip64 {
            u16le(&mut extra, 1);
            u16le(&mut extra, 16);
            u64le(&mut extra, entry.size);
            u64le(&mut extra, entry.data.len() as u64);
        }
        u32le(&mut bytes, 0x04034b50);
        u16le(&mut bytes, if zip64 { 45 } else { 20 });
        u16le(&mut bytes, entry.flags);
        u16le(&mut bytes, entry.method);
        u32le(&mut bytes, 0);
        u32le(&mut bytes, entry.crc32);
        u32le(
            &mut bytes,
            if zip64 {
                u32::MAX
            } else {
                entry.data.len() as u32
            },
        );
        u32le(&mut bytes, if zip64 { u32::MAX } else { entry.size as u32 });
        u16le(&mut bytes, entry.name.len() as u16);
        u16le(&mut bytes, extra.len() as u16);
        bytes.extend(&entry.name);
        bytes.extend(extra);
        bytes.extend(&entry.data);
        if entry.flags & 8 != 0 {
            u32le(&mut bytes, 0x08074b50);
            u32le(&mut bytes, entry.crc32);
            if zip64 {
                u64le(&mut bytes, entry.data.len() as u64);
                u64le(&mut bytes, entry.size);
            } else {
                u32le(&mut bytes, entry.data.len() as u32);
                u32le(&mut bytes, entry.size as u32);
            }
        }
    }
    let directory = bytes.len() as u64;
    for (entry, offset) in entries.iter().zip(offsets) {
        let mut extra = entry.extra.clone();
        if zip64 {
            u16le(&mut extra, 1);
            u16le(&mut extra, 24);
            u64le(&mut extra, entry.size);
            u64le(&mut extra, entry.data.len() as u64);
            u64le(&mut extra, offset);
        }
        u32le(&mut bytes, 0x02014b50);
        u16le(&mut bytes, 0x031e);
        u16le(&mut bytes, if zip64 { 45 } else { 20 });
        u16le(&mut bytes, entry.flags);
        u16le(&mut bytes, entry.method);
        u32le(&mut bytes, 0);
        u32le(&mut bytes, entry.crc32);
        u32le(
            &mut bytes,
            if zip64 {
                u32::MAX
            } else {
                entry.data.len() as u32
            },
        );
        u32le(&mut bytes, if zip64 { u32::MAX } else { entry.size as u32 });
        u16le(&mut bytes, entry.name.len() as u16);
        u16le(&mut bytes, extra.len() as u16);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u32le(&mut bytes, entry.attributes);
        u32le(&mut bytes, if zip64 { u32::MAX } else { offset as u32 });
        bytes.extend(&entry.name);
        bytes.extend(extra);
    }
    let directory_size = bytes.len() as u64 - directory;
    if zip64 {
        let record = bytes.len() as u64;
        u32le(&mut bytes, 0x06064b50);
        u64le(&mut bytes, 44);
        u16le(&mut bytes, 45);
        u16le(&mut bytes, 45);
        u32le(&mut bytes, 0);
        u32le(&mut bytes, 0);
        u64le(&mut bytes, entries.len() as u64);
        u64le(&mut bytes, entries.len() as u64);
        u64le(&mut bytes, directory_size);
        u64le(&mut bytes, directory);
        u32le(&mut bytes, 0x07064b50);
        u32le(&mut bytes, 0);
        u64le(&mut bytes, record);
        u32le(&mut bytes, 1);
    }
    u32le(&mut bytes, 0x06054b50);
    u16le(&mut bytes, 0);
    u16le(&mut bytes, 0);
    for _ in 0..2 {
        u16le(
            &mut bytes,
            if zip64 {
                u16::MAX
            } else {
                entries.len() as u16
            },
        );
    }
    u32le(
        &mut bytes,
        if zip64 {
            u32::MAX
        } else {
            directory_size as u32
        },
    );
    u32le(&mut bytes, if zip64 { u32::MAX } else { directory as u32 });
    u16le(&mut bytes, 0);
    bytes
}

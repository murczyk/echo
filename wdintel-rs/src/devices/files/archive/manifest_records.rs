use super::super::path;
use super::{
    io::{u16le, u32le, u64le, Input},
    require, Charge, Failure, Limits, Member,
};
use crate::{h, types::ShortContext};
use anyhow::{Context, Result};
use std::io::{Read, Seek};

pub(super) struct Record {
    member: Member,
    raw_name: Vec<u8>,
    decoded_name: String,
    flags: u16,
    local_offset: u64,
    zip64: bool,
}

pub(super) fn central(
    bytes: &[u8],
    position: &mut usize,
    ordinal: u64,
    limits: &Limits,
) -> Result<Record> {
    let header = bytes
        .get(*position..position.checked_add(46).c(h!())?)
        .ok_or(Failure::Invalid)
        .context(h!())?;
    require(
        u32le(header, 0).context(h!())? == 0x02014b50,
        Failure::Invalid,
    )
    .context(h!())?;
    let flags = u16le(header, 8).context(h!())?;
    let method = u16le(header, 10).context(h!())?;
    supported(flags, method, u16le(header, 6).context(h!())?).context(h!())?;
    let name_length = usize::from(u16le(header, 28).context(h!())?);
    let extra_length = usize::from(u16le(header, 30).context(h!())?);
    let comment_length = usize::from(u16le(header, 32).context(h!())?);
    let start = position.checked_add(46).c(h!())?;
    let end = start
        .checked_add(name_length + extra_length + comment_length)
        .c(h!())?;
    require(end <= bytes.len(), Failure::Invalid).context(h!())?;
    let raw_name = &bytes[start..start + name_length];
    let extra = &bytes[start + name_length..start + name_length + extra_length];
    let (size, compressed_size, local_offset, disk, zip64) = sizes(
        extra,
        u32le(header, 24).context(h!())?,
        u32le(header, 20).context(h!())?,
        u32le(header, 42).context(h!())?,
        u16le(header, 34).context(h!())?,
    )
    .context(h!())?;
    require(disk == 0, Failure::Unsupported).context(h!())?;
    let decoded_name = path::decode(raw_name, flags, extra).context(h!())?;
    let directory = directory_kind(
        &decoded_name,
        u16le(header, 4).context(h!())?,
        u32le(header, 38).context(h!())?,
    )
    .context(h!())?;
    let path =
        path::validate(&decoded_name, directory, limits).context(h!())?;
    require(
        !directory || (size == 0 && u32le(header, 16).context(h!())? == 0),
        Failure::Invalid,
    )
    .context(h!())?;
    require(size <= limits.member_bytes, Failure::Limit("member_bytes"))
        .context(h!())?;
    require(
        u128::from(size)
            <= u128::from(compressed_size) * u128::from(limits.member_ratio),
        Failure::Limit("member_ratio"),
    )
    .context(h!())?;
    require(method != 0 || size == compressed_size, Failure::Invalid)
        .context(h!())?;
    *position = end;
    Ok(Record {
        member: Member {
            modified_at: modified_time(u16le(header, 14)?, u16le(header, 12)?),
            path,
            ordinal: Some(ordinal),
            directory,
            inferred: false,
            method,
            size,
            compressed_size,
            crc32: u32le(header, 16).context(h!())?,
            data_offset: 0,
        },
        raw_name: raw_name.to_vec(),
        decoded_name,
        flags,
        local_offset,
        zip64,
    })
}

fn supported(flags: u16, method: u16, version: u16) -> Result<()> {
    require(flags & (1 | 64 | 8192) == 0, Failure::Password).context(h!())?;
    require(
        matches!(method, 0 | 8) && version <= 45,
        Failure::Unsupported,
    )
    .context(h!())?;
    require(
        flags & !(2 | 4 | 8 | 2048) == 0 && (method == 8 || flags & 6 == 0),
        Failure::Unsupported,
    )
}

fn directory_kind(name: &str, creator: u16, attributes: u32) -> Result<bool> {
    let kind = if matches!(creator >> 8, 3 | 19) {
        (attributes >> 16) & 0xf000
    } else {
        0
    };
    require(matches!(kind, 0 | 0x4000 | 0x8000), Failure::UnsafePath)
        .context(h!())?;
    let directory =
        name.ends_with('/') || attributes & 16 != 0 || kind == 0x4000;
    require(kind != 0x8000 || !directory, Failure::Invalid).context(h!())?;
    Ok(directory)
}

fn sizes(
    extra: &[u8],
    size: u32,
    compressed: u32,
    offset: u32,
    disk: u16,
) -> Result<(u64, u64, u64, u32, bool)> {
    let mut extended = None;
    for (tag, data) in path::extra_fields(extra).context(h!())? {
        if tag == 1 {
            require(extended.is_none(), Failure::Invalid).context(h!())?;
            extended = Some(data);
        }
    }
    let mut position = 0;
    let mut value = |original: u32| -> Result<u64> {
        if original != u32::MAX {
            return Ok(u64::from(original));
        }
        let result =
            u64le(extended.ok_or(Failure::Invalid).context(h!())?, position)
                .context(h!())?;
        position += 8;
        Ok(result)
    };
    let zip64_sizes = size == u32::MAX || compressed == u32::MAX;
    let size = value(size).context(h!())?;
    let compressed = value(compressed).context(h!())?;
    let offset = value(offset).context(h!())?;
    let disk = if disk == u16::MAX {
        u32le(extended.ok_or(Failure::Invalid).context(h!())?, position)
            .context(h!())?
    } else {
        u32::from(disk)
    };
    Ok((size, compressed, offset, disk, zip64_sizes))
}

pub(super) fn local<R: Read + Seek, F: FnMut(Charge, u64) -> Result<()>>(
    input: &mut Input<'_, R, F>,
    mut record: Record,
    boundary: u64,
) -> Result<(Member, (u64, u64))> {
    require(
        record
            .local_offset
            .checked_add(30)
            .is_some_and(|end| end <= boundary),
        Failure::Invalid,
    )
    .context(h!())?;
    let header = input.read_at(record.local_offset, 30).context(h!())?;
    require(
        u32le(&header, 0).context(h!())? == 0x04034b50
            && u16le(&header, 6).context(h!())? == record.flags
            && u16le(&header, 8).context(h!())? == record.member.method,
        Failure::Invalid,
    )
    .context(h!())?;
    supported(
        record.flags,
        record.member.method,
        u16le(&header, 4).context(h!())?,
    )
    .context(h!())?;
    let name_length = usize::from(u16le(&header, 26).context(h!())?);
    let extra_length = usize::from(u16le(&header, 28).context(h!())?);
    let fields_offset = record.local_offset.checked_add(30).c(h!())?;
    let data_offset = fields_offset
        .checked_add((name_length + extra_length) as u64)
        .c(h!())?;
    require(data_offset <= boundary, Failure::Invalid).context(h!())?;
    let fields = input
        .read_at(fields_offset, (name_length + extra_length) as u64)
        .context(h!())?;
    require(fields[..name_length] == record.raw_name, Failure::Invalid)
        .context(h!())?;
    let extra = &fields[name_length..];
    if let Some(name) = path::unicode(&record.raw_name, extra).context(h!())? {
        require(name == record.decoded_name, Failure::PathConflict)
            .context(h!())?;
    }
    let (size, compressed, _, _, zip64) = sizes(
        extra,
        u32le(&header, 22).context(h!())?,
        u32le(&header, 18).context(h!())?,
        0,
        0,
    )
    .context(h!())?;
    let descriptor = record.flags & 8 != 0;
    require(
        (size == record.member.size || (descriptor && size == 0))
            && (compressed == record.member.compressed_size
                || (descriptor && compressed == 0))
            && (u32le(&header, 14).context(h!())? == record.member.crc32
                || (descriptor && u32le(&header, 14).context(h!())? == 0)),
        Failure::Invalid,
    )
    .context(h!())?;
    let data_end = data_offset
        .checked_add(record.member.compressed_size)
        .ok_or(Failure::Invalid)
        .context(h!())?;
    require(data_end <= boundary, Failure::Invalid).context(h!())?;
    let end = if descriptor {
        descriptor_end(
            input,
            data_end,
            boundary,
            &record.member,
            zip64 || record.zip64,
        )
        .context(h!())?
    } else {
        data_end
    };
    record.member.data_offset = data_offset;
    if record.member.directory && record.member.method == 8 {
        empty_directory(input, &record.member).context(h!())?;
    }
    Ok((record.member, (record.local_offset, end)))
}

fn descriptor_end<R: Read + Seek, F: FnMut(Charge, u64) -> Result<()>>(
    input: &mut Input<'_, R, F>,
    offset: u64,
    boundary: u64,
    member: &Member,
    zip64: bool,
) -> Result<u64> {
    let length = if zip64 { 20 } else { 12 };
    require(boundary.saturating_sub(offset) >= length, Failure::Invalid)
        .context(h!())?;
    let bytes = input
        .read_at(offset, (length + 4).min(boundary - offset))
        .context(h!())?;
    let mut endings = Vec::new();
    for start in [0, 4] {
        if start == 4 && u32le(&bytes, 0).context(h!())? != 0x08074b50 {
            continue;
        }
        if bytes.len() < start + length as usize {
            continue;
        }
        let compressed = if zip64 {
            u64le(&bytes, start + 4).context(h!())?
        } else {
            u64::from(u32le(&bytes, start + 4).context(h!())?)
        };
        let size = if zip64 {
            u64le(&bytes, start + 12).context(h!())?
        } else {
            u64::from(u32le(&bytes, start + 8).context(h!())?)
        };
        if u32le(&bytes, start).context(h!())? == member.crc32
            && compressed == member.compressed_size
            && size == member.size
        {
            endings.push(offset + start as u64 + length);
        }
    }
    require(endings.len() == 1, Failure::Invalid).context(h!())?;
    Ok(endings[0])
}

fn empty_directory<R: Read + Seek, F: FnMut(Charge, u64) -> Result<()>>(
    input: &mut Input<'_, R, F>,
    member: &Member,
) -> Result<()> {
    let mut decoder = flate2::Decompress::new(false);
    let mut offset = member.data_offset;
    let mut remaining = member.compressed_size;
    while remaining > 0 {
        let size = remaining.min(
            crate::devices::config::DEVICE_FILE_ARCHIVE_INFLATE_BUFFER_BYTES
                as u64,
        );
        let bytes = input.read_at(offset, size).context(h!())?;
        let mut start = 0;
        while start < bytes.len() {
            let before = decoder.total_in();
            let status = decoder
                .decompress(
                    &bytes[start..],
                    &mut [],
                    flate2::FlushDecompress::None,
                )
                .map_err(|_| Failure::Integrity)
                .context(h!())?;
            if status == flate2::Status::StreamEnd {
                return require(
                    decoder.total_in() == member.compressed_size
                        && decoder.total_out() == 0,
                    Failure::Integrity,
                );
            }
            require(
                decoder.total_in() > before && decoder.total_out() == 0,
                Failure::Integrity,
            )
            .context(h!())?;
            start += (decoder.total_in() - before) as usize;
        }
        offset += size;
        remaining -= size;
    }
    Err(Failure::Integrity.into())
}

fn modified_time(date: u16, time: u16) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDate::from_ymd_opt(
        1980 + i32::from(date >> 9),
        u32::from((date >> 5) & 15),
        u32::from(date & 31),
    )?
    .and_hms_opt(
        u32::from(time >> 11),
        u32::from((time >> 5) & 63),
        u32::from(time & 31) * 2,
    )
}

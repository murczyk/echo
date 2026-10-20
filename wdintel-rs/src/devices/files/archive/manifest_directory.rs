use super::{
    io::{u16le, u32le, u64le, Input},
    require, Charge, Failure, Limits,
};
use crate::{h, types::ShortContext};
use anyhow::{Context, Result};
use std::io::{Read, Seek};

pub(super) struct Directory {
    pub offset: u64,
    pub size: u64,
    pub records: u64,
}

pub(super) fn read<R: Read + Seek, F: FnMut(Charge, u64) -> Result<()>>(
    input: &mut Input<'_, R, F>,
    limits: &Limits,
) -> Result<Directory> {
    require(input.size >= 22, Failure::Invalid).context(h!())?;
    let length = input.size.min(22 + u64::from(u16::MAX));
    let tail = input.read_at(input.size - length, length).context(h!())?;
    let offset = (0..=tail.len() - 22)
        .rev()
        .find(|i| {
            tail[*i..*i + 4] == [0x50, 0x4b, 0x05, 0x06]
                && *i
                    + 22
                    + usize::from(u16::from_le_bytes([
                        tail[*i + 20],
                        tail[*i + 21],
                    ]))
                    == tail.len()
        })
        .ok_or(Failure::Invalid)
        .context(h!())?;
    let end = input.size - length + offset as u64;
    let record = &tail[offset..];
    require(
        u16le(record, 4).context(h!())? == 0
            && u16le(record, 6).context(h!())? == 0,
        Failure::Unsupported,
    )
    .context(h!())?;
    require(
        u16le(record, 8).context(h!())? == u16le(record, 10).context(h!())?,
        Failure::Invalid,
    )
    .context(h!())?;
    let classic = Directory {
        offset: u64::from(u32le(record, 16).context(h!())?),
        size: u64::from(u32le(record, 12).context(h!())?),
        records: u64::from(u16le(record, 10).context(h!())?),
    };
    let extended = if end >= 20 {
        input.read_at(end - 20, 20).context(h!())?
    } else {
        vec![]
    };
    let (directory, boundary) =
        if extended.starts_with(&[0x50, 0x4b, 0x06, 0x07]) {
            zip64(input, &extended, end - 20, &classic, limits).context(h!())?
        } else {
            require(
                classic.offset != u64::from(u32::MAX)
                    && classic.size != u64::from(u32::MAX)
                    && classic.records != u64::from(u16::MAX),
                Failure::Invalid,
            )
            .context(h!())?;
            (classic, end)
        };
    require(
        directory.size <= limits.directory_bytes,
        Failure::Limit("central_directory"),
    )
    .context(h!())?;
    require(
        directory.records <= limits.records,
        Failure::Limit("examined_records"),
    )
    .context(h!())?;
    require(
        directory.offset.checked_add(directory.size) == Some(boundary),
        Failure::Invalid,
    )
    .context(h!())?;
    require(directory.records <= directory.size / 46, Failure::Invalid)
        .context(h!())?;
    Ok(directory)
}

fn zip64<R: Read + Seek, F: FnMut(Charge, u64) -> Result<()>>(
    input: &mut Input<'_, R, F>,
    locator: &[u8],
    locator_offset: u64,
    classic: &Directory,
    limits: &Limits,
) -> Result<(Directory, u64)> {
    require(
        u32le(locator, 4).context(h!())? == 0
            && u32le(locator, 16).context(h!())? == 1,
        Failure::Unsupported,
    )
    .context(h!())?;
    let offset = u64le(locator, 8).context(h!())?;
    let record = input.read_at(offset, 56).context(h!())?;
    require(
        u32le(&record, 0).context(h!())? == 0x06064b50,
        Failure::Invalid,
    )
    .context(h!())?;
    let size = u64le(&record, 4).context(h!())?;
    require(
        size >= 44 && size <= limits.directory_bytes,
        Failure::Invalid,
    )
    .context(h!())?;
    require(
        offset
            .checked_add(12)
            .and_then(|start| start.checked_add(size))
            == Some(locator_offset),
        Failure::Invalid,
    )
    .context(h!())?;
    require(
        u16le(&record, 14).context(h!())? <= 45
            && u32le(&record, 16).context(h!())? == 0
            && u32le(&record, 20).context(h!())? == 0,
        Failure::Unsupported,
    )
    .context(h!())?;
    require(
        u64le(&record, 24).context(h!())?
            == u64le(&record, 32).context(h!())?,
        Failure::Invalid,
    )
    .context(h!())?;
    let directory = Directory {
        offset: u64le(&record, 48).context(h!())?,
        size: u64le(&record, 40).context(h!())?,
        records: u64le(&record, 32).context(h!())?,
    };
    for (old, new, sentinel) in [
        (classic.offset, directory.offset, u64::from(u32::MAX)),
        (classic.size, directory.size, u64::from(u32::MAX)),
        (classic.records, directory.records, u64::from(u16::MAX)),
    ] {
        require(old == sentinel || old == new, Failure::Invalid)
            .context(h!())?;
    }
    if size > 44 {
        input
            .read_at(offset.checked_add(56).c(h!())?, size - 44)
            .context(h!())?;
    }
    Ok((directory, offset))
}

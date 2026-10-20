use super::{
    error::{require, Failure},
    manifest::Member,
};
use crate::{devices::config::*, h, types::ShortContext};
use anyhow::{Context, Result};
use flate2::{Decompress, FlushDecompress, Status};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Verified {
    pub size: u64,
    pub sha256: [u8; 32],
    pub crc32: u32,
}

pub(super) trait Meter {
    fn reserve(&mut self, wanted: u64) -> Result<u64>;
    fn settle(&mut self, used: u64) -> Result<()>;
}

pub(super) fn inflate(
    input: &mut (impl Read + Seek),
    output: &mut File,
    member: &Member,
    meter: &mut impl Meter,
) -> Result<Verified> {
    output.set_len(0).c(h!())?;
    output.rewind().c(h!())?;
    let result = inflate_inner(input, output, member, meter);
    if result.is_err() {
        output.set_len(0).c(h!())?;
    }
    result
}

fn inflate_inner(
    input: &mut (impl Read + Seek),
    output: &mut File,
    member: &Member,
    meter: &mut impl Meter,
) -> Result<Verified> {
    require(
        !member.directory
            && member.size <= DEVICE_FILE_ARCHIVE_MEMBER_MAX_BYTES,
        Failure::Invalid,
    )
    .context(h!())?;
    require(
        member.size
            <= member
                .compressed_size
                .saturating_mul(DEVICE_FILE_ARCHIVE_MEMBER_MAX_RATIO),
        Failure::Limit("member_ratio"),
    )
    .context(h!())?;
    input.seek(SeekFrom::Start(member.data_offset)).c(h!())?;
    let mut sink = Sink {
        output,
        sha256: Sha256::new(),
        crc32: crc32fast::Hasher::new(),
        size: 0,
    };
    match member.method {
        0 => stored(input, &mut sink, member, meter).context(h!())?,
        8 => deflated(input, &mut sink, member, meter).context(h!())?,
        _ => return Err(Failure::Unsupported.into()),
    }
    let crc32 = sink.crc32.finalize();
    require(
        sink.size == member.size && crc32 == member.crc32,
        Failure::Integrity,
    )
    .context(h!())?;
    sink.output.sync_all().c(h!())?;
    Ok(Verified {
        size: sink.size,
        sha256: sink.sha256.finalize().into(),
        crc32,
    })
}

fn read_payload(input: &mut impl Read, bytes: &mut [u8]) -> Result<()> {
    input
        .read_exact(bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                anyhow::Error::from(Failure::Integrity)
            } else {
                anyhow::Error::from(error)
            }
        })
        .context(h!())
}

struct Sink<'a> {
    output: &'a mut File,
    sha256: Sha256,
    crc32: crc32fast::Hasher,
    size: u64,
}
impl Sink<'_> {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.output.write_all(bytes).c(h!())?;
        self.sha256.update(bytes);
        self.crc32.update(bytes);
        self.size += bytes.len() as u64;
        Ok(())
    }
}

fn allowance(meter: &mut impl Meter, wanted: u64) -> Result<usize> {
    let granted = meter.reserve(wanted).context(h!())?;
    require(granted > 0 && granted <= wanted, Failure::Invalid)
        .context(h!())?;
    usize::try_from(granted).c(h!())
}

fn stored(
    input: &mut impl Read,
    sink: &mut Sink<'_>,
    member: &Member,
    meter: &mut impl Meter,
) -> Result<()> {
    require(member.size == member.compressed_size, Failure::Integrity)
        .context(h!())?;
    let mut buffer = vec![0; DEVICE_FILE_ARCHIVE_INFLATE_BUFFER_BYTES];
    while sink.size < member.size {
        let count = allowance(
            meter,
            (member.size - sink.size).min(buffer.len() as u64),
        )
        .context(h!())?;
        read_payload(input, &mut buffer[..count]).context(h!())?;
        meter.settle(count as u64).context(h!())?;
        sink.write(&buffer[..count]).context(h!())?;
    }
    Ok(())
}

fn deflated(
    input: &mut impl Read,
    sink: &mut Sink<'_>,
    member: &Member,
    meter: &mut impl Meter,
) -> Result<()> {
    let mut decoder = Decompress::new(false);
    let mut compressed = vec![0; DEVICE_FILE_ARCHIVE_INFLATE_BUFFER_BYTES];
    let mut output = vec![0; DEVICE_FILE_ARCHIVE_INFLATE_BUFFER_BYTES];
    let mut remaining = member.compressed_size;
    let (mut start, mut end) = (0, 0);
    loop {
        if start == end && remaining > 0 {
            end = remaining.min(compressed.len() as u64) as usize;
            read_payload(input, &mut compressed[..end]).context(h!())?;
            remaining -= end as u64;
            start = 0;
        }
        let wanted = (member.size - sink.size).min(output.len() as u64);
        let allowed = if wanted == 0 {
            0
        } else {
            allowance(meter, wanted).context(h!())?
        };
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = decoder
            .decompress(
                &compressed[start..end],
                &mut output[..allowed],
                FlushDecompress::None,
            )
            .map_err(|_| Failure::Integrity)
            .context(h!())?;
        let consumed = (decoder.total_in() - before_in) as usize;
        let produced = (decoder.total_out() - before_out) as usize;
        if allowed > 0 {
            meter.settle(produced as u64).context(h!())?;
        }
        sink.write(&output[..produced]).context(h!())?;
        start += consumed;
        if status == Status::StreamEnd {
            require(
                decoder.total_in() == member.compressed_size
                    && sink.size == member.size,
                Failure::Integrity,
            )
            .context(h!())?;
            return Ok(());
        }
        require(consumed > 0 || produced > 0, Failure::Integrity)
            .context(h!())?;
    }
}

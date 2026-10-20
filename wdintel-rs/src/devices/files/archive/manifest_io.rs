use super::{require, Charge, Failure};
use crate::{devices::config::*, h, types::ShortContext};
use anyhow::{Context, Result};
use std::{
    io::{Read, Seek, SeekFrom},
    time::{Duration, Instant},
};

pub(super) struct Input<'a, R, F> {
    reader: &'a mut R,
    pub size: u64,
    pub metadata_bytes: u64,
    started: Instant,
    charge: F,
}

impl<'a, R: Read + Seek, F: FnMut(Charge, u64) -> Result<()>> Input<'a, R, F> {
    pub fn new(reader: &'a mut R, size: u64, charge: F) -> Result<Self> {
        require(
            reader.seek(SeekFrom::End(0)).c(h!())? == size,
            Failure::Invalid,
        )
        .context(h!())?;
        Ok(Self {
            reader,
            size,
            metadata_bytes: 0,
            started: Instant::now(),
            charge,
        })
    }
    pub fn charge(&mut self, kind: Charge, amount: u64) -> Result<()> {
        require(
            self.started.elapsed()
                < Duration::from_secs(DEVICE_FILE_ARCHIVE_PREFLIGHT_SECONDS),
            Failure::Limit("preflight_time"),
        )
        .context(h!())?;
        (self.charge)(kind, amount).context(h!())
    }
    pub fn read_at(&mut self, offset: u64, length: u64) -> Result<Vec<u8>> {
        require(
            offset
                .checked_add(length)
                .is_some_and(|end| end <= self.size),
            Failure::Invalid,
        )
        .context(h!())?;
        let total = self
            .metadata_bytes
            .checked_add(length)
            .ok_or(Failure::Limit("metadata_bytes"))
            .context(h!())?;
        require(
            total <= DEVICE_FILE_ARCHIVE_ROOT_METADATA_MAX_BYTES,
            Failure::Limit("metadata_bytes"),
        )
        .context(h!())?;
        self.charge(Charge::Metadata, length).context(h!())?;
        self.metadata_bytes = total;
        let mut bytes = vec![0; usize::try_from(length).c(h!())?];
        self.reader.seek(SeekFrom::Start(offset)).c(h!())?;
        self.reader
            .read_exact(&mut bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::UnexpectedEof {
                    anyhow::Error::from(Failure::Invalid)
                } else {
                    anyhow::Error::from(error).context(h!())
                }
            })
            .context(h!())?;
        Ok(bytes)
    }
}

pub(super) fn u16le(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or(Failure::Invalid)
            .context(h!())?
            .try_into()
            .c(h!())?,
    ))
}
pub(super) fn u32le(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or(Failure::Invalid)
            .context(h!())?
            .try_into()
            .c(h!())?,
    ))
}
pub(super) fn u64le(bytes: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or(Failure::Invalid)
            .context(h!())?
            .try_into()
            .c(h!())?,
    ))
}

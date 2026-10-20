use super::error::{require, Failure};
use crate::devices::config::*;
use crate::h;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Seek};

#[path = "manifest_directory.rs"]
mod directory;
#[path = "manifest_io.rs"]
mod io;
#[path = "manifest_records.rs"]
mod records;

#[derive(Clone, Copy, Debug)]
pub(super) enum Charge {
    Metadata,
    Records,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Limits {
    pub directory_bytes: u64,
    pub records: u64,
    pub nodes: u64,
    pub path_bytes: u64,
    pub path_components: u64,
    pub member_bytes: u64,
    pub member_ratio: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            directory_bytes: DEVICE_FILE_ARCHIVE_DIRECTORY_MAX_BYTES,
            records: DEVICE_FILE_ARCHIVE_ROOT_MAX_RECORDS,
            nodes: DEVICE_FILE_ARCHIVE_ROOT_MAX_NODES,
            path_bytes: DEVICE_FILE_ARCHIVE_PATH_MAX_BYTES,
            path_components: DEVICE_FILE_ARCHIVE_PATH_MAX_COMPONENTS,
            member_bytes: DEVICE_FILE_ARCHIVE_MEMBER_MAX_BYTES,
            member_ratio: DEVICE_FILE_ARCHIVE_MEMBER_MAX_RATIO,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Member {
    pub modified_at: Option<chrono::NaiveDateTime>,
    pub path: String,
    pub ordinal: Option<u64>,
    pub directory: bool,
    pub inferred: bool,
    pub method: u16,
    pub size: u64,
    pub compressed_size: u64,
    pub crc32: u32,
    pub data_offset: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Manifest {
    pub members: Vec<Member>,
    pub records: u64,
    pub metadata_bytes: u64,
}

#[cfg(test)]
pub(super) fn read(
    input: &mut (impl Read + Seek),
    size: u64,
    limits: &Limits,
) -> anyhow::Result<Manifest> {
    read_metered(input, size, limits, |_, _| Ok(()))
}

pub(super) fn read_metered(
    input: &mut (impl Read + Seek),
    size: u64,
    limits: &Limits,
    charge: impl FnMut(Charge, u64) -> Result<()>,
) -> Result<Manifest> {
    require(
        size <= DEVICE_FILE_ARCHIVE_SOURCE_MAX_BYTES,
        Failure::SourceTooLarge,
    )
    .context(h!())?;
    let mut input = io::Input::new(input, size, charge).context(h!())?;
    let directory = directory::read(&mut input, limits).context(h!())?;
    input
        .charge(Charge::Records, directory.records)
        .context(h!())?;
    let bytes = input
        .read_at(directory.offset, directory.size)
        .context(h!())?;
    let mut position = 0;
    let mut members = BTreeMap::new();
    let mut ranges = Vec::new();
    for ordinal in 0..directory.records {
        let record = records::central(&bytes, &mut position, ordinal, limits)
            .context(h!())?;
        let (member, range) =
            records::local(&mut input, record, directory.offset)
                .context(h!())?;
        ranges.push(range);
        insert(&mut members, member, limits).context(h!())?;
    }
    require(position == bytes.len(), Failure::Invalid).context(h!())?;
    ranges.sort_unstable();
    let mut end = 0;
    for (start, next) in ranges {
        require(start >= end && next <= directory.offset, Failure::Invalid)
            .context(h!())?;
        end = next;
    }
    require(
        directory.records != 0 || directory.offset == 0,
        Failure::Invalid,
    )
    .context(h!())?;
    Ok(Manifest {
        members: members.into_values().collect(),
        records: directory.records,
        metadata_bytes: input.metadata_bytes,
    })
}

fn insert(
    members: &mut BTreeMap<String, Member>,
    member: Member,
    limits: &Limits,
) -> Result<()> {
    for (index, _) in member.path.match_indices('/') {
        let parent = &member.path[..index];
        if let Some(existing) = members.get(parent) {
            require(existing.directory, Failure::PathConflict).context(h!())?;
        } else {
            capacity(members, limits).context(h!())?;
            members.insert(
                parent.to_owned(),
                Member {
                    modified_at: None,
                    path: parent.to_owned(),
                    ordinal: None,
                    directory: true,
                    inferred: true,
                    method: 0,
                    size: 0,
                    compressed_size: 0,
                    crc32: 0,
                    data_offset: 0,
                },
            );
        }
    }
    if let Some(existing) = members.get(&member.path) {
        require(
            existing.directory && existing.inferred && member.directory,
            Failure::PathConflict,
        )
        .context(h!())?;
    } else {
        capacity(members, limits).context(h!())?;
    }
    members.insert(member.path.clone(), member);
    Ok(())
}

fn capacity(members: &BTreeMap<String, Member>, limits: &Limits) -> Result<()> {
    require(
        (members.len() as u64) < limits.nodes,
        Failure::Limit("unique_nodes"),
    )
}

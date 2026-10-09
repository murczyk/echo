use std::io::{Cursor, Read};

use anyhow::{Context, Result};

use super::query::{supported_source, Rejection};
use crate::{devices::config::*, h};

pub(super) fn indices(value: &str) -> Result<Vec<usize>> {
    let invalid = || Rejection("invalid_request");
    if value.len() > DEVICE_FILE_PREVIEW_ARCHIVE_MAX_DEPTH * 4 {
        return Err(invalid().into());
    }
    let members = value
        .split(',')
        .map(|part| {
            part.parse::<usize>()
                .ok()
                .filter(|index| {
                    *index < DEVICE_FILE_PREVIEW_ARCHIVE_MAX_ENTRIES
                        && index.to_string() == part
                })
                .ok_or_else(invalid)
        })
        .collect::<std::result::Result<Vec<_>, _>>()
        .context(h!())?;
    if members.len() > DEVICE_FILE_PREVIEW_ARCHIVE_MAX_DEPTH {
        return Err(invalid().into());
    }
    Ok(members)
}

pub(super) fn is_archive(
    name: &str,
    extension: Option<&str>,
    mime_type: Option<&str>,
) -> bool {
    if matches!(
        mime_type
            .and_then(|value| value.split(';').next())
            .map(str::trim),
        Some(
            "application/zip"
                | "application/x-zip"
                | "application/x-zip-compressed"
        )
    ) {
        return true;
    }
    name.trim()
        .rsplit_once('.')
        .map(|(_, suffix)| suffix)
        .filter(|suffix| !suffix.is_empty())
        .or(extension)
        .is_some_and(|extension| {
            extension
                .trim_start_matches('.')
                .eq_ignore_ascii_case("zip")
        })
}

pub(super) fn extract(
    mut bytes: Vec<u8>,
    members: &str,
) -> Result<(Vec<u8>, String)> {
    let mut name = String::new();
    for index in indices(members).context(h!())? {
        (bytes, name) = extract_member(bytes, index).context(h!())?;
    }
    if !supported_source(&name, None) {
        return Err(crate::alpine::DeviceConversionFailure(
            "unsupported_format",
        )
        .into());
    }
    Ok((bytes, name))
}

fn extract_member(bytes: Vec<u8>, index: usize) -> Result<(Vec<u8>, String)> {
    let invalid = || crate::alpine::DeviceConversionFailure("source_invalid");
    if bytes.len() as u64 > DEVICE_FILE_PREVIEW_ARCHIVE_MAX_BYTES {
        return Err(
            crate::alpine::DeviceConversionFailure("source_too_large").into()
        );
    }
    let bytes = single_member_archive(bytes, index)
        .ok_or_else(invalid)
        .context(h!())?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| invalid())
        .context(h!())?;
    let member = archive.by_index(0).map_err(|_| invalid()).context(h!())?;
    let path = member.name();
    if member.is_dir()
        || member.is_symlink()
        || member.encrypted()
        || !matches!(
            member.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        )
        || path.len() > DEVICE_FILE_PREVIEW_ARCHIVE_MAX_PATH_BYTES
        || path.split('/').count() > DEVICE_FILE_PREVIEW_ARCHIVE_MAX_PATH_DEPTH
        || path.starts_with('/')
        || path.contains(['\\', '\0', ':'])
        || path.split('/').any(|part| part == "..")
    {
        return Err(invalid().into());
    }
    let name = path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(invalid)
        .context(h!())?
        .to_owned();
    let size = member.size();
    if size > DEVICE_FILE_PREVIEW_ARCHIVE_MEMBER_MAX_BYTES {
        return Err(
            crate::alpine::DeviceConversionFailure("source_too_large").into()
        );
    }
    let mut bytes = Vec::new();
    member
        .take(DEVICE_FILE_PREVIEW_ARCHIVE_MEMBER_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())
        .context(h!())?;
    if bytes.len() as u64 != size {
        return Err(invalid().into());
    }
    Ok((bytes, name))
}

fn u16_at(bytes: &[u8], offset: usize) -> Option<usize> {
    Some(
        u16::from_le_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?)
            as usize,
    )
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<usize> {
    Some(
        u32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?)
            as usize,
    )
}

fn central_directory(
    bytes: &[u8],
    end: usize,
) -> Option<(usize, Vec<std::ops::Range<usize>>)> {
    if u32_at(bytes, end)? != 0x06054b50
        || end + 22 + u16_at(bytes, end + 20)? != bytes.len()
    {
        return None;
    }
    let count = u16_at(bytes, end + 10)?;
    if count == 0 || count > DEVICE_FILE_PREVIEW_ARCHIVE_MAX_ENTRIES {
        return None;
    }
    let start = u32_at(bytes, end + 16)?;
    let size = u32_at(bytes, end + 12)?;
    if start > end || size > end - start {
        return None;
    }
    let mut offset = start;
    let mut records = Vec::with_capacity(count);
    for _ in 0..count {
        if u32_at(bytes, offset)? != 0x02014b50 {
            return None;
        }
        let next = offset
            + 46
            + u16_at(bytes, offset + 28)?
            + u16_at(bytes, offset + 30)?
            + u16_at(bytes, offset + 32)?;
        if next > end {
            return None;
        }
        records.push(offset..next);
        offset = next;
    }
    let headers_size = offset - start;
    if offset != end {
        if u32_at(bytes, offset)? != 0x05054b50
            || offset + 6 + u16_at(bytes, offset + 4)? != end
        {
            return None;
        }
        if size != headers_size && size != end - start {
            return None;
        }
    } else if size != headers_size {
        return None;
    }
    Some((start, records))
}

fn validate_directory(
    bytes: &[u8],
    end: usize,
    start: usize,
    records: &[std::ops::Range<usize>],
) -> Option<()> {
    if u16_at(bytes, end + 4)? != 0
        || u16_at(bytes, end + 6)? != 0
        || u16_at(bytes, end + 8)? != records.len()
    {
        return None;
    }
    let mut total = 0u64;
    for record in records {
        let offset = record.start;
        total = total.checked_add(u32_at(bytes, offset + 24)? as u64)?;
        if total > DEVICE_FILE_PREVIEW_ARCHIVE_EXPANDED_MAX_BYTES
            || u32_at(bytes, offset + 20)? == u32::MAX as usize
            || u32_at(bytes, offset + 42)? >= start
            || u16_at(bytes, offset + 34)? != 0
        {
            return None;
        }
    }
    Some(())
}

fn single_member_archive(
    mut bytes: Vec<u8>,
    selected: usize,
) -> Option<Vec<u8>> {
    let last = bytes.len().checked_sub(22)?;
    let (end, start, records) = (last.saturating_sub(u16::MAX as usize)..=last)
        .rev()
        .find_map(|end| {
            central_directory(&bytes, end)
                .map(|(start, records)| (end, start, records))
        })?;
    validate_directory(&bytes, end, start, &records)?;
    let record = records.get(selected)?.clone();
    // zip::ZipArchive deduplicates names; isolate the original central-directory ordinal.
    let directory = bytes.get(record)?.to_vec();
    bytes.truncate(start);
    bytes.extend_from_slice(&directory);
    bytes.extend_from_slice(&0x06054b50u32.to_le_bytes());
    bytes.extend_from_slice(&[0; 4]);
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&(directory.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(start as u32).to_le_bytes());
    bytes.extend_from_slice(&[0; 2]);
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip(name: &str, bytes: &[u8]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn nested_archive_geodata_is_extracted_without_trusting_paths() {
        let bytes = b"<gpx version=\"1.1\"/>";
        let nested = zip("maps/route.gpx", bytes);
        let (extracted, name) =
            extract(zip("nested.zip", &nested), "0,0").unwrap();
        assert_eq!(extracted, bytes);
        assert_eq!(name, "route.gpx");
        for name in ["../route.gpx", "/route.gpx", "C:\\route.gpx"] {
            assert!(extract(zip(name, bytes), "0").is_err());
        }
        assert!(extract(zip("route.gpx", bytes), "1").is_err());
        assert!(extract(zip("readme.txt", bytes), "0").is_err());
        let large =
            vec![0; DEVICE_FILE_PREVIEW_ARCHIVE_MEMBER_MAX_BYTES as usize + 1];
        assert!(extract(zip("route.gpx", &large), "0").is_err());
    }

    #[test]
    fn duplicate_names_preserve_original_central_directory_indices() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in
            [("a.gpx", "first"), ("b.gpx", "second"), ("c.gpx", "third")]
        {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body.as_bytes()).unwrap();
        }
        let mut bytes = writer.finish().unwrap().into_inner();
        for offset in 0..bytes.len() - 4 {
            if &bytes[offset..offset + 5] == b"b.gpx" {
                bytes[offset] = b'a';
            }
        }
        for (index, expected) in
            ["first", "second", "third"].into_iter().enumerate()
        {
            assert_eq!(
                extract(bytes.clone(), &index.to_string()).unwrap().0,
                expected.as_bytes()
            );
        }
    }

    #[test]
    fn unsupported_selected_directory_does_not_fall_back_to_an_earlier_one() {
        let mut bytes = zip("route.gpx", b"<gpx/>");
        let end = bytes.len() - 22;
        let (_, records) = central_directory(&bytes, end).unwrap();
        let directory = bytes[records[0].clone()].to_vec();
        let mut footer = bytes[end..].to_vec();
        footer[4..6].copy_from_slice(&1u16.to_le_bytes());
        footer[12..16].copy_from_slice(&(directory.len() as u32).to_le_bytes());
        footer[16..20].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
        bytes[end + 20..end + 22]
            .copy_from_slice(&((directory.len() + 22) as u16).to_le_bytes());
        bytes.extend_from_slice(&directory);
        bytes.extend_from_slice(&footer);
        assert!(extract(bytes, "0").is_err());
    }

    #[test]
    fn archive_query_rejects_ambiguous_or_unbounded_selectors() {
        assert_eq!(indices("0,999,2").unwrap(), [0, 999, 2]);
        for value in ["", "00", "-1", "1,", " 1", "1000", "0,0,0,0,0,0,0,0,0"] {
            assert!(indices(value).is_err(), "{value}");
        }
    }
}

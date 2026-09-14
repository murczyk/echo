use crate::error::AppError;
use crate::here;
use crate::types::*;
use anyhow::Context;
use std::fs;
use std::fs::File;
use std::io::{BufRead, Read};
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};
use walkdir::DirEntry;
use zip::write::FileOptions;

// taken from https://github.com/zip-rs/zip/blob/5737927dbbd15a8b648c315f2f8e2a39cdc1a430/examples/write_dir.rs

pub fn zip_dir<T>(
    it: &mut dyn Iterator<Item = DirEntry>,
    prefix: &str,
    writer: T,
    method: zip::CompressionMethod,
) -> anyhow::Result<()>
where
    T: Write + Seek,
{
    let mut zip = zip::ZipWriter::new(writer);
    // let options =
    let options: FileOptions<zip::write::ExtendedFileOptions> =
        FileOptions::default()
            .compression_method(method)
            .unix_permissions(0o755);

    for entry in it {
        let path = entry.path();
        let name = path.strip_prefix(Path::new(prefix)).context(here!())?;

        // Write file or directory explicitly
        // Some unzip tools unzip files with directory paths correctly, some do not!
        if path.is_file() {
            debug!("adding {:?} as {:?} ...", path, name);

            #[allow(deprecated)]
            zip.start_file_from_path(name, options.clone())
                .context(here!())?;
            let mut f = File::open(path).context(here!())?;

            std::io::copy(&mut f, &mut zip).c(h!())?;
        } else if !name.as_os_str().is_empty() {
            // Only if not root! Avoids path spec / warning
            // and mapname conversion failed error on unzip
            debug!("adding dir {:?} as {:?} ...", path, name);
            #[allow(deprecated)]
            zip.add_directory_from_path(name, options.clone())
                .context(here!())?;
        }
    }
    zip.finish().context(here!())?;
    Result::Ok(())
}

pub fn unzip(fname: &Path) -> Result<(), AppError> {
    let outdir = fname
        .parent()
        .ok_or_else(|| invalid_archive("No parent directory"))
        .c(h!())?;
    unzip_to(fname, outdir).c(h!())?;
    Ok(())
}

pub fn unzip_to(fname: &Path, outdir: &Path) -> Result<(), AppError> {
    unzip_to_with_limits(fname, outdir, None, None).c(h!())?;
    Ok(())
}

pub fn unzip_to_limited(
    fname: &Path,
    outdir: &Path,
    maximum_entries: usize,
    maximum_bytes: u64,
) -> Result<(), AppError> {
    unzip_to_with_limits(
        fname,
        outdir,
        Some(maximum_entries),
        Some(maximum_bytes),
    )
    .c(h!())?;
    Ok(())
}

fn unzip_to_with_limits(
    fname: &Path,
    outdir: &Path,
    maximum_entries: Option<usize>,
    maximum_bytes: Option<u64>,
) -> Result<(), AppError> {
    let file = File::open(fname).c(h!())?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(invalid_archive)
        .c(h!())?;
    match (maximum_entries, maximum_bytes) {
        (Some(entries), Some(bytes)) => {
            validate_archive_limits(&mut archive, entries, bytes).c(h!())?;
        }
        _ => validate_archive(&mut archive, maximum_entries, maximum_bytes)
            .c(h!())?,
    }
    let mut remaining_bytes = maximum_bytes;
    for index in 0..archive.len() {
        let mut entry =
            archive.by_index(index).map_err(invalid_archive).c(h!())?;
        let relative_path = entry
            .enclosed_name()
            .ok_or_else(|| invalid_archive("Unsafe archive path"))
            .c(h!())?;
        if entry.is_dir() {
            create_archive_directories(outdir, &relative_path).c(h!())?;
            continue;
        }
        if let Some(parent) = relative_path.parent() {
            create_archive_directories(outdir, parent).c(h!())?;
        }
        let outpath = outdir.join(relative_path);
        let mut outfile = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&outpath)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    invalid_archive(
                        "Archive entry would overwrite an existing path",
                    )
                } else {
                    AppError::from(error)
                }
            })
            .c(h!())?;
        let declared_size = entry.size();
        copy_archive_entry(
            &mut entry,
            &mut outfile,
            &mut remaining_bytes,
            declared_size,
        )
        .c(h!())?;
    }
    Ok(())
}

fn copy_archive_entry(
    entry: impl Read,
    output: &mut File,
    remaining_bytes: &mut Option<u64>,
    declared_size: u64,
) -> Result<(), AppError> {
    let mut reader = std::io::BufReader::new(entry);
    let mut copied = 0_u64;
    loop {
        let bytes = reader.fill_buf().map_err(invalid_archive).c(h!())?;
        if bytes.is_empty() {
            break;
        }
        if remaining_bytes
            .is_some_and(|remaining| bytes.len() as u64 > remaining)
        {
            return Err(invalid_archive(
                "Archive exceeds the expanded size limit",
            ));
        }
        if bytes.len() as u64 > declared_size - copied {
            return Err(invalid_archive(
                "Archive declares an incorrect entry size",
            ));
        }
        output.write_all(bytes).c(h!())?;
        let length = bytes.len();
        if let Some(remaining) = remaining_bytes {
            *remaining -= length as u64;
        }
        copied += length as u64;
        reader.consume(length);
    }
    if copied != declared_size {
        return Err(invalid_archive(
            "Archive declares an incorrect entry size",
        ));
    }
    Ok(())
}

pub fn validate_archive_limits<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    maximum_entries: usize,
    maximum_bytes: u64,
) -> Result<(), AppError> {
    Ok(
        validate_archive(archive, Some(maximum_entries), Some(maximum_bytes))
            .c(h!())?,
    )
}

fn validate_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    maximum_entries: Option<usize>,
    maximum_bytes: Option<u64>,
) -> Result<(), AppError> {
    if let Some(maximum_entries) =
        maximum_entries.filter(|maximum| archive.len() > *maximum)
    {
        return Err(invalid_archive(format!(
            "Archive contains more than {maximum_entries} entries"
        )));
    }
    let mut expanded_bytes = 0_u64;
    let mut paths = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(invalid_archive).c(h!())?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| invalid_archive("Unsafe archive path"))
            .c(h!())?;
        if path.as_os_str().is_empty()
            || entry.name().contains('\\')
            || entry.name().split('/').any(|part| part == "..")
        {
            return Err(invalid_archive("Unsafe archive path"));
        }
        if entry.unix_mode().is_some_and(|mode| {
            !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000)
        }) {
            return Err(invalid_archive(
                "Archive links and special files are not supported",
            ));
        }
        if !paths.insert(path) {
            return Err(invalid_archive("Duplicate archive entry path"));
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry.size())
            .ok_or_else(|| invalid_archive("Archive expanded size overflows"))
            .c(h!())?;
        if let Some(maximum_bytes) =
            maximum_bytes.filter(|maximum| expanded_bytes > *maximum)
        {
            return Err(invalid_archive(format!(
                "Archive expands to more than {maximum_bytes} bytes"
            )));
        }
    }
    Ok(())
}

fn create_archive_directories(
    root: &Path,
    relative: &Path,
) -> anyhow::Result<()> {
    let mut directory = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            continue;
        }
        directory.push(component);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !fs::symlink_metadata(&directory).c(h!())?.is_dir() {
                    return Err(invalid_archive(
                        "Archive path crosses a symlink or file",
                    ))
                    .c(h!());
                }
            }
            Err(error) => return Err(error).c(h!()),
        }
    }
    Ok(())
}

pub fn find_kml_document_for_source(
    directory: &Path,
    source: &Path,
) -> Result<PathBuf, AppError> {
    if let Some(stem) = source
        .file_stem()
        .filter(|stem| !stem.is_empty() && *stem != "." && *stem != "..")
    {
        let document = directory.join(stem).join("doc.kml");
        if document.is_file() {
            return Ok(document);
        }
    }
    Ok(find_kml_document(directory).c(h!())?)
}

pub fn find_kml_document(directory: &Path) -> Result<PathBuf, AppError> {
    let document = directory.join("doc.kml");
    if document.is_file() {
        return Ok(document);
    }
    for entry in fs::read_dir(directory).c(h!())? {
        let entry = entry.c(h!())?;
        if entry.file_type().c(h!())?.is_file()
            && entry.path().extension() == Some("kml".as_ref())
        {
            return Ok(entry.path());
        }
    }
    let mut paths = walkdir::WalkDir::new(directory)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?
        .into_iter()
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("kml"))
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| {
        (
            path != &directory.join("doc.kml"),
            path.file_name().and_then(|name| name.to_str()) != Some("doc.kml"),
            path.clone(),
        )
    });
    paths.into_iter().next().ok_or_else(|| {
        invalid_archive("Archive does not contain a KML document")
    })
}

fn invalid_archive(error: impl std::fmt::Display) -> AppError {
    AppError::BL {
        msg: format!("Invalid ZIP archive: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn archive(
        directory: &Path,
        entries: &[(&str, &[u8])],
    ) -> std::path::PathBuf {
        let path = directory.join("source.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn legacy_kmz_extraction_accepts_many_entries_and_large_expanded_assets() {
        let source = tempfile::tempdir().unwrap();
        let path = source.path().join("legacy.kmz");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(1));
        writer.start_file("doc.kml", options).unwrap();
        writer.write_all(b"<kml><Document/></kml>").unwrap();
        for index in 0..4096 {
            writer
                .start_file(format!("assets/{index}.txt"), options)
                .unwrap();
            writer.write_all(b"asset").unwrap();
        }
        let expanded_bytes = 201 * 1024 * 1024;
        writer.start_file("assets/large.bin", options).unwrap();
        std::io::copy(
            &mut std::io::repeat(0).take(expanded_bytes),
            &mut writer,
        )
        .unwrap();
        writer.finish().unwrap();

        for (maximum_entries, maximum_bytes) in [
            (4096, expanded_bytes + 1024 * 1024),
            (4098, 200 * 1024 * 1024),
        ] {
            let destination = tempfile::tempdir().unwrap();
            assert!(unzip_to_limited(
                &path,
                destination.path(),
                maximum_entries,
                maximum_bytes
            )
            .is_err());
            assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
        }

        let destination = tempfile::tempdir().unwrap();
        unzip_to(&path, destination.path()).unwrap();
        assert_eq!(
            fs::read_dir(destination.path().join("assets"))
                .unwrap()
                .count(),
            4097
        );
        assert_eq!(
            fs::metadata(destination.path().join("assets/large.bin"))
                .unwrap()
                .len(),
            expanded_bytes
        );
        let document = find_kml_document(destination.path()).unwrap();
        let kml = fs::read_to_string(document).unwrap();
        crate::kml::validate_upload_document(&kml).unwrap();
    }

    #[test]
    fn extraction_enforces_entry_and_aggregate_expansion_limits() {
        let source = tempfile::tempdir().unwrap();
        let path = archive(
            source.path(),
            &[("nested/one.kml", b"1234"), ("two.kml", b"5678")],
        );
        for (entries, bytes) in [(1, 8), (2, 7)] {
            let destination = tempfile::tempdir().unwrap();
            assert!(unzip_to_limited(
                &path,
                destination.path(),
                entries,
                bytes
            )
            .is_err());
            assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
        }
        let destination = tempfile::tempdir().unwrap();
        unzip_to_limited(&path, destination.path(), 2, 8).unwrap();
        assert_eq!(
            fs::read(destination.path().join("nested/one.kml")).unwrap(),
            b"1234"
        );
        assert_eq!(
            fs::read(destination.path().join("two.kml")).unwrap(),
            b"5678"
        );
    }

    #[test]
    fn extraction_rejects_traversal_and_existing_destination_files() {
        for name in [
            "../outside.kml",
            "/outside.kml",
            "nested/../outside.kml",
            "C:\\outside.kml",
        ] {
            let source = tempfile::tempdir().unwrap();
            let destination = tempfile::tempdir().unwrap();
            let path = archive(source.path(), &[(name, b"malicious")]);
            assert!(unzip_to(&path, destination.path()).is_err(), "{name}");
            assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
        }
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let sentinel = destination.path().join("doc.kml");
        fs::write(&sentinel, b"original").unwrap();
        let path = archive(source.path(), &[("doc.kml", b"overwrite")]);
        assert!(unzip_to(&path, destination.path()).is_err());
        assert_eq!(fs::read(sentinel).unwrap(), b"original");

        let destination = tempfile::tempdir().unwrap();
        let path = archive(
            source.path(),
            &[
                ("nested/doc.kml", b"original"),
                ("nested/./doc.kml", b"duplicate"),
            ],
        );
        assert!(unzip_to(&path, destination.path()).is_err());
        assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
    }

    #[test]
    fn extraction_rejects_corrupt_archive_payloads_and_stops_streamed_overflow()
    {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let archive_path = source.path().join("corrupt.zip");
        let mut writer =
            zip::ZipWriter::new(File::create(&archive_path).unwrap());
        writer
            .start_file(
                "doc.kml",
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(b"<kml>unique-audit-source</kml>").unwrap();
        writer.finish().unwrap();
        let mut bytes = fs::read(&archive_path).unwrap();
        let offset = bytes
            .windows(b"unique-audit-source".len())
            .position(|window| window == b"unique-audit-source")
            .unwrap();
        bytes[offset] ^= 1;
        fs::write(&archive_path, bytes).unwrap();
        assert!(unzip_to(&archive_path, destination.path()).is_err());
        let output_path = destination.path().join("bounded-output");
        let mut output = File::create(&output_path).unwrap();
        let mut remaining = Some(3);
        assert!(copy_archive_entry(
            b"1234".as_slice(),
            &mut output,
            &mut remaining,
            3
        )
        .is_err());
        assert!(fs::metadata(&output_path).unwrap().len() <= 3);
    }

    #[test]
    fn extraction_preserves_nested_kml_discovery_and_rejects_missing_document()
    {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let path = archive(
            source.path(),
            &[
                ("original-name/doc.kml", b"<kml/>"),
                ("image.png", b"image"),
            ],
        );
        unzip_to(&path, destination.path()).unwrap();
        assert_eq!(
            find_kml_document(destination.path()).unwrap(),
            destination.path().join("original-name/doc.kml")
        );
        assert!(find_kml_document(source.path()).is_err());
    }

    #[test]
    fn extraction_preserves_source_stem_document_priority() {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir_in(parent.path()).unwrap();
        fs::write(parent.path().join("doc.kml"), b"parent sentinel").unwrap();
        let path = archive(
            source.path(),
            &[
                (
                    "map/doc.kml",
                    b"<kml><Document><name>preferred</name></Document></kml>",
                ),
                (
                    "doc.kml",
                    b"<kml><Document><name>root</name></Document></kml>",
                ),
                (
                    "other/doc.kml",
                    b"<kml><Document><name>other</name></Document></kml>",
                ),
                (
                    "survey.kml",
                    b"<kml><Document><name>survey</name></Document></kml>",
                ),
            ],
        );
        unzip_to(&path, destination.path()).unwrap();
        for source_name in ["map.kmz", "../../map.kmz", "/untrusted/map.kmz"] {
            let document = find_kml_document_for_source(
                destination.path(),
                Path::new(source_name),
            )
            .unwrap();
            assert_eq!(document, destination.path().join("map/doc.kml"));
            assert!(fs::read_to_string(document)
                .unwrap()
                .contains("preferred"));
        }
        let document = find_kml_document_for_source(
            destination.path(),
            Path::new("missing.kmz"),
        )
        .unwrap();
        assert_eq!(document, destination.path().join("doc.kml"));
        assert_eq!(find_kml_document(destination.path()).unwrap(), document);
        for source_name in ["...kmz", "..kmz", ".", "..", ""] {
            let selected = find_kml_document_for_source(
                destination.path(),
                Path::new(source_name),
            )
            .unwrap();
            assert_eq!(selected, document);
            assert_eq!(
                fs::read_to_string(selected).unwrap(),
                "<kml><Document><name>root</name></Document></kml>",
            );
        }
        fs::remove_file(document).unwrap();
        let document = find_kml_document_for_source(
            destination.path(),
            Path::new("missing.kmz"),
        )
        .unwrap();
        assert_eq!(document, destination.path().join("survey.kml"));
        assert_eq!(find_kml_document(destination.path()).unwrap(), document);
    }

    #[cfg(unix)]
    #[test]
    fn extraction_rejects_archive_links_and_existing_symlink_parents() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = source.path().join("symlink.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .add_symlink(
                "link",
                outside.path().display().to_string(),
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.finish().unwrap();
        assert!(unzip_to(&path, destination.path()).is_err());
        std::os::unix::fs::symlink(
            outside.path(),
            destination.path().join("nested"),
        )
        .unwrap();
        let path = archive(source.path(), &[("nested/sentinel", b"outside")]);
        assert!(unzip_to(&path, destination.path()).is_err());
        assert!(!outside.path().join("sentinel").exists());
    }
}

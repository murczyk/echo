use crate::error::AppError;
use crate::here;
use anyhow::Context;
use log::*;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::io::{Seek, Write};
use std::path::Path;
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

    let mut buffer = Vec::new();
    for entry in it {
        let path = entry.path();
        let name = path.strip_prefix(Path::new(prefix)).context(here!())?;

        // Write file or directory explicitly
        // Some unzip tools unzip files with directory paths correctly, some do not!
        if path.is_file() {
            debug!("adding {path:?} as {name:?} ...");

            #[allow(deprecated)]
            zip.start_file_from_path(name, options.clone())
                .context(here!())?;
            let mut f = File::open(path).context(here!())?;

            f.read_to_end(&mut buffer).context(here!())?;
            zip.write_all(&buffer).context(here!())?;
            buffer.clear();
        } else if !name.as_os_str().is_empty() {
            // Only if not root! Avoids path spec / warning
            // and mapname conversion failed error on unzip
            debug!("adding dir {path:?} as {name:?} ...");
            #[allow(deprecated)]
            zip.add_directory_from_path(name, options.clone())
                .context(here!())?;
        }
    }
    zip.finish().context(here!())?;
    Result::Ok(())
}

pub fn unzip(fname: &Path) -> Result<(), AppError> {
    let file = File::open(fname).context(here!())?;
    let outdir = fname.parent().ok_or(AppError::BL {
        msg: "No parent dir".to_string(),
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::BL {
        msg: format!("Open zip error: {e:?}"),
    })?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| AppError::BL {
            msg: format!("Read zip entry error: {e:?}"),
        })?;

        let rel = match file.enclosed_name() {
            Some(path) => path.to_owned(),
            None => continue, // skip suspicious paths
        };
        let outpath = outdir.join(rel);

        if file.is_dir() {
            fs::create_dir_all(&outpath).context(here!())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).context(here!())?;
            }
            let mut outfile = File::create(&outpath).context(here!())?;
            std::io::copy(&mut file, &mut outfile).context(here!())?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                let _ = fs::set_permissions(
                    &outpath,
                    fs::Permissions::from_mode(mode),
                );
            }
        }
    }
    Ok(())
}

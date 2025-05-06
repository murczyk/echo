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
            debug!("adding {:?} as {:?} ...", path, name);

            #[allow(deprecated)]
            zip.start_file_from_path(name, options.clone())
                .context(here!())?;
            let mut f = File::open(path).context(here!())?;

            f.read_to_end(&mut buffer).context(here!())?;
            zip.write_all(&*buffer).context(here!())?;
            buffer.clear();
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
    zip_extract::extract(
        fs::File::open(&fname)?,
        fname.parent().ok_or(AppError::BL {
            msg: "No parent dir".to_string(),
        })?,
        true,
    )
    .map_err(|e| AppError::BL {
        msg: format!("Unzip error: {e:?}"),
    })?;
    Ok(())
}

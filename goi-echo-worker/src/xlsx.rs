use anyhow::{Context, Result};
use rust_xlsxwriter::Workbook;

pub fn empty_xlsx_buffer() -> Result<Vec<u8>> {
    let mut workbook = Workbook::new();
    workbook.add_worksheet();
    workbook
        .save_to_buffer()
        .context("creating empty XLSX workbook")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::read_knowledge_rows;
    use crate::row::read_association_rows;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn empty_xlsx_buffer_is_valid_for_goi_readers() {
        let path = temp_xlsx_path("empty-goi-reader");
        fs::write(&path, empty_xlsx_buffer().expect("empty xlsx"))
            .expect("write xlsx");

        assert!(read_association_rows(&path)
            .expect("associations")
            .is_empty());
        assert!(read_knowledge_rows(&path).expect("knowledge").is_empty());

        fs::remove_file(path).ok();
    }

    fn temp_xlsx_path(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("{prefix}-{}-{suffix}.xlsx", std::process::id()))
    }
}

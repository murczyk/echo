use crate::{
    attachments::worker::{append_html, Package},
    config::{ATTACHMENT_MAX_RESULT_BYTES, OCR_MAX_RESULT_ENTRIES},
    h,
    types::ShortContext,
};

pub(super) async fn parse(name: &str, bytes: &[u8]) -> anyhow::Result<Package> {
    anyhow::ensure!(
        bytes.len() <= ATTACHMENT_MAX_RESULT_BYTES,
        "map exceeds input limit"
    );
    if name.to_ascii_lowercase().ends_with(".kmz") {
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).c(h!())?;
        crate::utils::zip::validate_archive_limits(
            &mut archive,
            OCR_MAX_RESULT_ENTRIES,
            ATTACHMENT_MAX_RESULT_BYTES as u64,
        )
        .c(h!())?;
    }
    let parsed = crate::palitra::kmz::parse_coordinates_from_file(name, bytes)
        .await
        .c(h!())?;
    let mut package = Package {
        complete: true,
        ..Default::default()
    };
    let mut size = 0;
    for (index, point) in parsed.points.iter().enumerate() {
        let text = format!(
            "{}\nWGS84: {:.7}, {:.7}",
            point.label.as_deref().unwrap_or_default(),
            point.coords.lat,
            point.coords.lng
        );
        if !append(
            &mut package,
            name,
            &format!("point {}", index + 1),
            &text,
            &mut size,
        )
        .c(h!())?
        {
            return Ok(package);
        }
    }
    for (index, line) in parsed.line_strings.iter().enumerate() {
        for (vertex, coords) in line.coords.iter().enumerate() {
            let text = format!("WGS84: {:.7}, {:.7}", coords.lat, coords.lng);
            if !append(
                &mut package,
                name,
                &format!("line {}; vertex {}", index + 1, vertex + 1),
                &text,
                &mut size,
            )
            .c(h!())?
            {
                return Ok(package);
            }
        }
    }
    Ok(package)
}

fn append(
    package: &mut Package,
    name: &str,
    locator: &str,
    text: &str,
    size: &mut usize,
) -> anyhow::Result<bool> {
    *size += text.len();
    if *size > ATTACHMENT_MAX_RESULT_BYTES {
        package.complete = false;
        package
            .warnings
            .push("Map extraction reached the text limit".into());
        return Ok(false);
    }
    let html =
        format!("<p>{}</p>", text.replace('&', "&amp;").replace('<', "&lt;"));
    append_html(package, name, locator, &html).c(h!())?;
    Ok(true)
}

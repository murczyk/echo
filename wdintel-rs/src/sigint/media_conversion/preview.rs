use super::types::{
    SignalMediaKmzPreviewLineString, SignalMediaKmzPreviewPoint,
    SignalMediaKmzPreviewPolygon, SignalMediaKmzPreviewRsp,
};
use crate::config::{
    SIGINT_MEDIA_KML_PREVIEW_MAX_COORDINATES,
    SIGINT_MEDIA_KML_PREVIEW_MAX_SOURCE_BYTES,
    SIGINT_MEDIA_KMZ_PREVIEW_MAX_ENTRIES,
    SIGINT_MEDIA_KMZ_PREVIEW_MAX_EXTRACTED_BYTES,
};
use crate::h;
use crate::kml::types::{Kml, Node, Placemark, Polygon, Style, StyleMap};
use crate::palitra::types::Coords;
use crate::types::ShortContext;
use anyhow::Context;
use std::collections::HashMap;
use std::path::Path;

const DEFAULT_POINT_COLOR: &str = "#1976d2";
const DEFAULT_LINE_COLOR: &str = "#455a64";
const DEFAULT_FILL_COLOR: &str = "#1976d2";
const MAX_NODE_NESTING: usize = 64;
pub const PREVIEW_SOURCE_LIMIT_ERROR: &str =
    "Preview limit exceeded: original file is larger than 25 MiB";

#[derive(Default)]
struct Styles {
    styles: HashMap<String, Style>,
    normal_maps: HashMap<String, String>,
}

pub async fn parse_attachment(
    extension: &str,
    bytes: &[u8],
) -> anyhow::Result<SignalMediaKmzPreviewRsp> {
    ensure_source_size(bytes.len()).c(h!())?;
    let extension = extension.to_string();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        parse_attachment_blocking(&extension, &bytes)
    })
    .await
    .c(h!())?
}

fn parse_attachment_blocking(
    extension: &str,
    bytes: &[u8],
) -> anyhow::Result<SignalMediaKmzPreviewRsp> {
    ensure_source_size(bytes.len()).c(h!())?;
    let extension = extension.trim();
    if extension.eq_ignore_ascii_case("kml") {
        return parse_kml_bytes(bytes).c(h!());
    }
    anyhow::ensure!(
        extension.eq_ignore_ascii_case("kmz"),
        "Unsupported preview format"
    );
    let archive = tempfile::NamedTempFile::new().c(h!())?;
    std::fs::write(archive.path(), bytes).c(h!())?;
    let extracted = tempfile::tempdir().c(h!())?;
    crate::utils::zip::unzip_to_limited(
        archive.path(),
        extracted.path(),
        SIGINT_MEDIA_KMZ_PREVIEW_MAX_ENTRIES,
        SIGINT_MEDIA_KMZ_PREVIEW_MAX_EXTRACTED_BYTES,
    )
    .c(h!())?;
    let mut paths = walkdir::WalkDir::new(extracted.path())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| is_kml(path))
        .collect::<Vec<_>>();
    paths.sort();
    anyhow::ensure!(!paths.is_empty(), "KMZ archive contains no KML documents");
    let mut result = SignalMediaKmzPreviewRsp {
        points: vec![],
        line_strings: vec![],
        polygons: vec![],
    };
    for path in paths {
        let bytes = std::fs::read(path).c(h!())?;
        let parsed = parse_kml_bytes(&bytes).c(h!())?;
        ensure_additional_coordinate_budget(
            &result,
            preview_coordinate_count(&parsed),
        )
        .c(h!())?;
        result.points.extend(parsed.points);
        result.line_strings.extend(parsed.line_strings);
        result.polygons.extend(parsed.polygons);
    }
    Ok(result)
}

fn is_kml(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("kml"))
}

fn parse_kml_bytes(bytes: &[u8]) -> anyhow::Result<SignalMediaKmzPreviewRsp> {
    let input = std::str::from_utf8(bytes)
        .context("Invalid KML encoding")
        .c(h!())?;
    crate::kml::validate_upload_document(input).c(h!())?;
    let kml: Kml = quick_xml::de::from_str(input)
        .context("Invalid KML document")
        .c(h!())?;
    let mut styles = Styles::default();
    index_styles(&kml.nodes, &mut styles).c(h!())?;
    let mut result = SignalMediaKmzPreviewRsp {
        points: vec![],
        line_strings: vec![],
        polygons: vec![],
    };
    parse_nodes(&kml.nodes, &styles, &mut result).c(h!())?;
    Ok(result)
}

fn index_styles(nodes: &[Node], styles: &mut Styles) -> anyhow::Result<()> {
    index_styles_at_depth(nodes, styles, 0).c(h!())
}

fn index_styles_at_depth(
    nodes: &[Node],
    styles: &mut Styles,
    depth: usize,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        depth <= MAX_NODE_NESTING,
        "KML document nesting exceeds preview limit"
    );
    for node in nodes {
        match node {
            Node::Folder(folder) => {
                index_style_slices(&folder.styles, &folder.style_maps, styles);
                index_styles_at_depth(&folder.nodes, styles, depth + 1)
                    .c(h!())?;
            }
            Node::Document(document) => {
                index_style_slices(
                    &document.styles,
                    &document.style_maps,
                    styles,
                );
                for cascading in &document.cascading_styles {
                    if let Some(style) = &cascading.style {
                        index_style(style, styles);
                    }
                }
                index_styles_at_depth(&document.nodes, styles, depth + 1)
                    .c(h!())?;
            }
            Node::Style(style) => index_style(style, styles),
            Node::StyleMap(map) => index_style_map(map, styles),
            _ => {}
        }
    }
    Ok(())
}

fn index_style_slices(
    values: &[Style],
    maps: &[StyleMap],
    styles: &mut Styles,
) {
    for style in values {
        index_style(style, styles);
    }
    for map in maps {
        index_style_map(map, styles);
    }
}

fn index_style(style: &Style, styles: &mut Styles) {
    if let Some(id) = &style.id {
        styles.styles.insert(id.clone(), style.clone());
    }
}

fn index_style_map(map: &StyleMap, styles: &mut Styles) {
    let Some(id) = &map.id else {
        return;
    };
    if let Some(pair) = map.pairs.iter().find(|pair| pair.key.body == "normal")
    {
        styles
            .normal_maps
            .insert(id.clone(), normalize_style_ref(&pair.style_url.body));
    }
}

fn normalize_style_ref(value: &str) -> String {
    value.trim().trim_start_matches('#').to_string()
}

fn resolved_style(placemark: &Placemark, styles: &Styles) -> Style {
    let mut style = placemark
        .style_url
        .as_ref()
        .and_then(|url| lookup_style(&url.body, styles))
        .unwrap_or_default();
    if let Some(inline) = &placemark.style {
        if let Some(icon_style) = &inline.icon_style {
            style.icon_style =
                Some(merge_icon_style(style.icon_style.as_ref(), icon_style));
        }
        if let Some(line_style) = &inline.line_style {
            style.line_style =
                Some(merge_line_style(style.line_style.as_ref(), line_style));
        }
        if let Some(poly_style) = &inline.poly_style {
            style.poly_style =
                Some(merge_poly_style(style.poly_style.as_ref(), poly_style));
        }
    }
    style
}

fn merge_icon_style(
    shared: Option<&crate::kml::types::IconStyle>,
    inline: &crate::kml::types::IconStyle,
) -> crate::kml::types::IconStyle {
    crate::kml::types::IconStyle {
        color: inline
            .color
            .clone()
            .or_else(|| shared.and_then(|style| style.color.clone())),
        scale: inline
            .scale
            .clone()
            .or_else(|| shared.and_then(|style| style.scale.clone())),
        icon: inline
            .icon
            .clone()
            .or_else(|| shared.and_then(|style| style.icon.clone())),
    }
}

fn merge_line_style(
    shared: Option<&crate::kml::types::LineStyle>,
    inline: &crate::kml::types::LineStyle,
) -> crate::kml::types::LineStyle {
    crate::kml::types::LineStyle {
        color: inline
            .color
            .clone()
            .or_else(|| shared.and_then(|style| style.color.clone())),
        width: inline
            .width
            .clone()
            .or_else(|| shared.and_then(|style| style.width.clone())),
    }
}

fn merge_poly_style(
    shared: Option<&crate::kml::types::PolyStyle>,
    inline: &crate::kml::types::PolyStyle,
) -> crate::kml::types::PolyStyle {
    crate::kml::types::PolyStyle {
        color: inline
            .color
            .clone()
            .or_else(|| shared.and_then(|style| style.color.clone())),
    }
}

fn lookup_style(reference: &str, styles: &Styles) -> Option<Style> {
    let mut reference = normalize_style_ref(reference);
    for _ in 0..4 {
        if let Some(style) = styles.styles.get(&reference) {
            return Some(style.clone());
        }
        reference = styles.normal_maps.get(&reference)?.clone();
    }
    None
}

fn parse_nodes(
    nodes: &[Node],
    styles: &Styles,
    result: &mut SignalMediaKmzPreviewRsp,
) -> anyhow::Result<()> {
    parse_nodes_at_depth(nodes, styles, result, 0).c(h!())
}

fn parse_nodes_at_depth(
    nodes: &[Node],
    styles: &Styles,
    result: &mut SignalMediaKmzPreviewRsp,
    depth: usize,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        depth <= MAX_NODE_NESTING,
        "KML document nesting exceeds preview limit"
    );
    for node in nodes {
        match node {
            Node::Folder(folder) => {
                parse_nodes_at_depth(&folder.nodes, styles, result, depth + 1)
                    .c(h!())?
            }
            Node::Document(document) => {
                parse_nodes_at_depth(&document.nodes, styles, result, depth + 1)
                    .c(h!())?
            }
            Node::Placemark(placemark) => {
                parse_placemark(placemark, styles, result).c(h!())?
            }
            _ => {}
        }
    }
    Ok(())
}

fn parse_placemark(
    placemark: &Placemark,
    styles: &Styles,
    result: &mut SignalMediaKmzPreviewRsp,
) -> anyhow::Result<()> {
    let style = resolved_style(placemark, styles);
    let label = placemark
        .name
        .clone()
        .filter(|name| !name.trim().is_empty());
    let point_color = style
        .icon_style
        .as_ref()
        .and_then(|s| s.color.as_ref())
        .and_then(|c| kml_color(&c.body))
        .unwrap_or_else(|| (DEFAULT_POINT_COLOR.to_string(), 1.0));
    let line_color = style
        .line_style
        .as_ref()
        .and_then(|s| s.color.as_ref())
        .and_then(|c| kml_color(&c.body))
        .unwrap_or_else(|| (DEFAULT_LINE_COLOR.to_string(), 1.0));
    let fill_color = style
        .poly_style
        .as_ref()
        .and_then(|s| s.color.as_ref())
        .and_then(|c| kml_color(&c.body))
        .unwrap_or_else(|| (DEFAULT_FILL_COLOR.to_string(), 0.35));
    for coordinates in std::iter::once(placemark.point.as_ref()).chain(
        placemark
            .multi_geometry
            .as_ref()
            .into_iter()
            .flat_map(|m| m.points.iter().map(Some)),
    ) {
        if let Some(coordinates) =
            coordinates.and_then(|point| point.coordinates.as_deref())
        {
            let points = coords(coordinates).c(h!())?;
            ensure_additional_coordinate_budget(result, points.len())
                .c(h!())?;
            for coords in points {
                result.points.push(SignalMediaKmzPreviewPoint {
                    coords,
                    label: label.clone(),
                    color: point_color.0.clone(),
                    opacity: point_color.1,
                });
            }
        }
    }
    for line in std::iter::once(placemark.line_string.as_ref()).chain(
        placemark
            .multi_geometry
            .as_ref()
            .into_iter()
            .flat_map(|m| m.line_strings.iter().map(Some)),
    ) {
        if let Some(raw) = line
            .and_then(|line| line.coordinates.as_ref())
            .and_then(|coordinates| coordinates.body.as_deref())
        {
            let coords = coords(raw).c(h!())?;
            if coords.len() >= 2 {
                ensure_additional_coordinate_budget(result, coords.len())
                    .c(h!())?;
                result.line_strings.push(SignalMediaKmzPreviewLineString {
                    coords,
                    color: line_color.0.clone(),
                    opacity: line_color.1,
                    label: label.clone(),
                });
            }
        }
    }
    for polygon in std::iter::once(placemark.polygon.as_ref())
        .chain(
            placemark
                .multi_geometry
                .as_ref()
                .into_iter()
                .flat_map(|m| m.polygons.iter().map(Some)),
        )
        .flatten()
    {
        if let Some(rings) = polygon_rings(polygon).c(h!())? {
            ensure_additional_coordinate_budget(
                result,
                rings.iter().map(Vec::len).sum(),
            )
            .c(h!())?;
            result.polygons.push(SignalMediaKmzPreviewPolygon {
                rings,
                stroke_color: line_color.0.clone(),
                stroke_opacity: line_color.1,
                fill_color: fill_color.0.clone(),
                fill_opacity: fill_color.1,
                label: label.clone(),
            });
        }
    }
    Ok(())
}

fn polygon_rings(
    polygon: &Polygon,
) -> anyhow::Result<Option<Vec<Vec<Coords>>>> {
    let Some(outer) = polygon
        .outer_boundary_is
        .as_ref()
        .and_then(|boundary| boundary.linear_ring.as_ref())
        .and_then(|ring| ring.coordinates.as_ref())
        .and_then(|coordinates| coordinates.body.as_deref())
    else {
        return Ok(None);
    };
    let outer = coords(outer).c(h!())?;
    if outer.len() < 3 {
        return Ok(None);
    }
    let mut rings = vec![outer];
    for boundary in &polygon.inner_boundary_is {
        let Some(raw) = boundary
            .linear_ring
            .as_ref()
            .and_then(|ring| ring.coordinates.as_ref())
            .and_then(|coordinates| coordinates.body.as_deref())
        else {
            continue;
        };
        let Ok(ring) = coords(raw) else {
            continue;
        };
        if ring.len() >= 3 {
            rings.push(ring);
        }
    }
    Ok(Some(rings))
}

pub fn ensure_recorded_source_size(size_bytes: i64) -> anyhow::Result<()> {
    let Ok(size_bytes) = usize::try_from(size_bytes) else {
        anyhow::bail!(PREVIEW_SOURCE_LIMIT_ERROR);
    };
    ensure_source_size(size_bytes).c(h!())
}

pub fn ensure_source_size(size_bytes: usize) -> anyhow::Result<()> {
    anyhow::ensure!(
        size_bytes <= SIGINT_MEDIA_KML_PREVIEW_MAX_SOURCE_BYTES,
        PREVIEW_SOURCE_LIMIT_ERROR
    );
    Ok(())
}

fn coords(raw: &str) -> anyhow::Result<Vec<Coords>> {
    Coords::list_from_kml_coordinates(raw).c(h!())
}

fn kml_color(raw: &str) -> Option<(String, f64)> {
    let raw = raw.trim().trim_start_matches('#');
    if raw.len() != 8 {
        return None;
    }
    let alpha = u8::from_str_radix(&raw[0..2], 16).ok()?;
    let blue = u8::from_str_radix(&raw[2..4], 16).ok()?;
    let green = u8::from_str_radix(&raw[4..6], 16).ok()?;
    let red = u8::from_str_radix(&raw[6..8], 16).ok()?;
    Some((
        format!("#{red:02x}{green:02x}{blue:02x}"),
        f64::from(alpha) / 255.0,
    ))
}

fn preview_coordinate_count(preview: &SignalMediaKmzPreviewRsp) -> usize {
    preview.points.len()
        + preview
            .line_strings
            .iter()
            .map(|line| line.coords.len())
            .sum::<usize>()
        + preview
            .polygons
            .iter()
            .flat_map(|polygon| polygon.rings.iter())
            .map(Vec::len)
            .sum::<usize>()
}

fn ensure_additional_coordinate_budget(
    preview: &SignalMediaKmzPreviewRsp,
    additional: usize,
) -> anyhow::Result<()> {
    let count = preview_coordinate_count(preview);
    anyhow::ensure!(
        count.saturating_add(additional)
            <= SIGINT_MEDIA_KML_PREVIEW_MAX_COORDINATES,
        "Preview limit exceeded: more than 100,000 coordinates"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn preserves_mixed_geometry_holes_and_per_field_style_alpha() {
        let kml = br#"<kml><Document>
          <Style id="shared"><IconStyle><color>400000ff</color></IconStyle><LineStyle><color>8000ff00</color></LineStyle><PolyStyle><color>20ff0000</color></PolyStyle></Style>
          <StyleMap id="mapped"><Pair><key>normal</key><styleUrl>#shared</styleUrl></Pair></StyleMap>
          <Placemark><name>mixed</name><styleUrl>#mapped</styleUrl><Style><IconStyle><scale>1.5</scale></IconStyle><LineStyle><width>3</width></LineStyle><PolyStyle></PolyStyle></Style><MultiGeometry>
            <Point><coordinates>30,50</coordinates></Point>
            <LineString><coordinates>30,50 31,51</coordinates></LineString>
            <Polygon><outerBoundaryIs><LinearRing><coordinates>30,50 32,50 32,52 30,50</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>30.5,50.5 31,50.5 31,51 30.5,50.5</coordinates></LinearRing></innerBoundaryIs></Polygon>
          </MultiGeometry></Placemark></Document></kml>"#;
        let preview = parse_kml_bytes(kml).unwrap();
        assert_eq!(preview.points.len(), 1);
        assert_eq!(preview.points[0].color, "#ff0000");
        assert!(
            (preview.points[0].opacity - 64.0 / 255.0).abs() < f64::EPSILON
        );
        assert_eq!(preview.line_strings.len(), 1);
        assert_eq!(preview.line_strings[0].color, "#00ff00");
        assert!(
            (preview.line_strings[0].opacity - 128.0 / 255.0).abs()
                < f64::EPSILON
        );
        assert_eq!(preview.polygons.len(), 1);
        assert_eq!(preview.polygons[0].rings.len(), 2);
        assert_eq!(preview.polygons[0].stroke_color, "#00ff00");
        assert!(
            (preview.polygons[0].stroke_opacity - 128.0 / 255.0).abs()
                < f64::EPSILON
        );
        assert_eq!(preview.polygons[0].fill_color, "#0000ff");
        assert!(
            (preview.polygons[0].fill_opacity - 32.0 / 255.0).abs()
                < f64::EPSILON
        );
    }

    #[test]
    fn keeps_valid_polygon_holes_when_an_interior_ring_is_invalid() {
        let kml = br#"<kml><Placemark><Polygon>
          <outerBoundaryIs><LinearRing><coordinates>30,50 32,50 32,52 30,50</coordinates></LinearRing></outerBoundaryIs>
          <innerBoundaryIs><LinearRing><coordinates>not-a-coordinate</coordinates></LinearRing></innerBoundaryIs>
          <innerBoundaryIs><LinearRing><coordinates>30.5,50.5 31,50.5 31,51 30.5,50.5</coordinates></LinearRing></innerBoundaryIs>
        </Polygon></Placemark></kml>"#;

        let preview = parse_kml_bytes(kml).unwrap();
        assert_eq!(preview.polygons.len(), 1);
        assert_eq!(preview.polygons[0].rings.len(), 2);
    }

    #[tokio::test]
    async fn rejects_preview_source_limit() {
        let bytes = vec![b' '; SIGINT_MEDIA_KML_PREVIEW_MAX_SOURCE_BYTES + 1];
        assert!(parse_attachment("kml", &bytes).await.is_err());
        assert!(ensure_recorded_source_size(
            i64::try_from(SIGINT_MEDIA_KML_PREVIEW_MAX_SOURCE_BYTES).unwrap()
        )
        .is_ok());
        assert!(ensure_recorded_source_size(
            i64::try_from(SIGINT_MEDIA_KML_PREVIEW_MAX_SOURCE_BYTES).unwrap()
                + 1
        )
        .is_err());
    }

    #[tokio::test]
    async fn parses_native_kmz_with_the_same_preview_shape() {
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        archive
            .start_file("doc.kml", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                br#"<kml><Placemark><Point><coordinates>30,50</coordinates></Point></Placemark></kml>"#,
            )
            .unwrap();
        let bytes = archive.finish().unwrap().into_inner();

        let preview = parse_attachment("KMZ", &bytes).await.unwrap();
        assert_eq!(preview.points.len(), 1);
        assert!(preview.line_strings.is_empty());
        assert!(preview.polygons.is_empty());
    }

    #[tokio::test]
    async fn malformed_kmz_members_report_the_archive_parser_context() {
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        archive
            .start_file("doc.kml", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&[0xff, 0xfe]).unwrap();
        let bytes = archive.finish().unwrap().into_inner();

        let error = parse_attachment("kmz", &bytes).await.unwrap_err();
        let error = format!("{error:#}");
        assert!(error.contains("Invalid KML encoding"));
        assert!(error.contains("preview.rs"));
    }
}

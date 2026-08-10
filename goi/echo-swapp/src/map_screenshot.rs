use crate::config::{
    AUTOMATION_MAP_SCREENSHOT_BASE_TILE_URL, AUTOMATION_MAP_SCREENSHOT_HEIGHT,
    AUTOMATION_MAP_SCREENSHOT_LABEL_TILE_URL,
    AUTOMATION_MAP_SCREENSHOT_MARKER_COLOR,
    AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS,
    AUTOMATION_MAP_SCREENSHOT_MARKER_WEIGHT,
    AUTOMATION_MAP_SCREENSHOT_MAX_ZOOM, AUTOMATION_MAP_SCREENSHOT_PADDING,
    AUTOMATION_MAP_SCREENSHOT_REQUEST_TIMEOUT_SECS,
    AUTOMATION_MAP_SCREENSHOT_TILE_SIZE, AUTOMATION_MAP_SCREENSHOT_WIDTH,
};
use crate::error::ShortContext;
use crate::h;
use anyhow::{bail, Result};
use base64::{engine::general_purpose, Engine};
use image::{imageops, DynamicImage, ImageFormat, Rgba, RgbaImage};
use reqwest::Client;
use std::f64::consts::PI;
use std::io::Cursor;
use std::time::Duration;
use tokio::task::JoinSet;

const WEB_MERCATOR_MAX_LATITUDE: f64 = 85.051_128_78;

#[derive(Clone, Copy, Debug)]
pub struct MapCoordinate {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Clone, Copy, Debug)]
struct PixelPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct Viewport {
    zoom: u8,
    origin: PixelPoint,
}

#[derive(Clone, Copy, Debug)]
struct TilePosition {
    x: i32,
    y: i32,
    offset_x: i64,
    offset_y: i64,
}

struct LoadedTile {
    position: TilePosition,
    image: RgbaImage,
}

pub async fn create(coordinates: &[MapCoordinate]) -> Result<String> {
    let viewport = fit_viewport(coordinates)?;
    let tiles = download_tiles(viewport).await.c(h!())?;
    let image = render_map(coordinates, viewport, tiles);
    encode_png(image)
}

fn fit_viewport(coordinates: &[MapCoordinate]) -> Result<Viewport> {
    if coordinates.is_empty() {
        bail!("coordinate screenshot requires at least one coordinate");
    }
    if coordinates.iter().any(|coordinate| {
        !coordinate.lat.is_finite() || !coordinate.lng.is_finite()
    }) {
        bail!("coordinate screenshot contains an invalid coordinate");
    }
    let zoom = (0..=AUTOMATION_MAP_SCREENSHOT_MAX_ZOOM)
        .rev()
        .find(|zoom| points_fit(coordinates, *zoom))
        .unwrap_or(0);
    let bounds = pixel_bounds(coordinates, zoom);
    let center = PixelPoint {
        x: (bounds.0.x + bounds.1.x) / 2.0,
        y: (bounds.0.y + bounds.1.y) / 2.0,
    };
    Ok(Viewport {
        zoom,
        origin: PixelPoint {
            x: center.x - f64::from(AUTOMATION_MAP_SCREENSHOT_WIDTH) / 2.0,
            y: center.y - f64::from(AUTOMATION_MAP_SCREENSHOT_HEIGHT) / 2.0,
        },
    })
}

fn points_fit(coordinates: &[MapCoordinate], zoom: u8) -> bool {
    let bounds = pixel_bounds(coordinates, zoom);
    bounds.1.x - bounds.0.x
        <= f64::from(AUTOMATION_MAP_SCREENSHOT_WIDTH)
            - 2.0 * AUTOMATION_MAP_SCREENSHOT_PADDING
        && bounds.1.y - bounds.0.y
            <= f64::from(AUTOMATION_MAP_SCREENSHOT_HEIGHT)
                - 2.0 * AUTOMATION_MAP_SCREENSHOT_PADDING
}

fn pixel_bounds(
    coordinates: &[MapCoordinate],
    zoom: u8,
) -> (PixelPoint, PixelPoint) {
    coordinates
        .iter()
        .map(|coordinate| project(*coordinate, zoom))
        .fold(
            (
                PixelPoint {
                    x: f64::INFINITY,
                    y: f64::INFINITY,
                },
                PixelPoint {
                    x: f64::NEG_INFINITY,
                    y: f64::NEG_INFINITY,
                },
            ),
            |(min, max), point| {
                (
                    PixelPoint {
                        x: min.x.min(point.x),
                        y: min.y.min(point.y),
                    },
                    PixelPoint {
                        x: max.x.max(point.x),
                        y: max.y.max(point.y),
                    },
                )
            },
        )
}

fn project(coordinate: MapCoordinate, zoom: u8) -> PixelPoint {
    let world_size = f64::from(AUTOMATION_MAP_SCREENSHOT_TILE_SIZE)
        * f64::from(1_u32 << zoom);
    let latitude = coordinate
        .lat
        .clamp(-WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE)
        .to_radians();
    PixelPoint {
        x: (coordinate.lng + 180.0) / 360.0 * world_size,
        y: (1.0 - (latitude.tan() + 1.0 / latitude.cos()).ln() / PI) / 2.0
            * world_size,
    }
}

async fn download_tiles(viewport: Viewport) -> Result<Vec<LoadedTile>> {
    let client = Client::builder()
        .timeout(Duration::from_secs(
            AUTOMATION_MAP_SCREENSHOT_REQUEST_TIMEOUT_SECS,
        ))
        .user_agent("echo-swapp")
        .build()
        .c(h!())?;
    let mut tasks = JoinSet::new();
    for position in tile_positions(viewport) {
        let client = client.clone();
        tasks.spawn(async move {
            let image = download_tile(&client, position, viewport.zoom)
                .await
                .c(h!())?;
            Ok::<_, anyhow::Error>(LoadedTile { position, image })
        });
    }
    let mut tiles = Vec::new();
    while let Some(tile) = tasks.join_next().await {
        tiles.push(tile.c(h!())??);
    }
    Ok(tiles)
}

fn tile_positions(viewport: Viewport) -> Vec<TilePosition> {
    let tile_size = f64::from(AUTOMATION_MAP_SCREENSHOT_TILE_SIZE);
    let tile_count = 1_i32 << viewport.zoom;
    let start_x = (viewport.origin.x / tile_size).floor() as i32;
    let end_x =
        ((viewport.origin.x + f64::from(AUTOMATION_MAP_SCREENSHOT_WIDTH) - 1.0)
            / tile_size)
            .floor() as i32;
    let start_y = (viewport.origin.y / tile_size).floor() as i32;
    let end_y = ((viewport.origin.y
        + f64::from(AUTOMATION_MAP_SCREENSHOT_HEIGHT)
        - 1.0)
        / tile_size)
        .floor() as i32;
    let mut positions = Vec::new();
    for y in start_y..=end_y {
        if !(0..tile_count).contains(&y) {
            continue;
        }
        for x in start_x..=end_x {
            positions.push(TilePosition {
                x: x.rem_euclid(tile_count),
                y,
                offset_x: (f64::from(x) * tile_size - viewport.origin.x).round()
                    as i64,
                offset_y: (f64::from(y) * tile_size - viewport.origin.y).round()
                    as i64,
            });
        }
    }
    positions
}

async fn download_tile(
    client: &Client,
    position: TilePosition,
    zoom: u8,
) -> Result<RgbaImage> {
    let base_url =
        tile_url(AUTOMATION_MAP_SCREENSHOT_BASE_TILE_URL, position, zoom);
    let label_url =
        tile_url(AUTOMATION_MAP_SCREENSHOT_LABEL_TILE_URL, position, zoom);
    let (base, labels) = tokio::join!(
        download_image(client, &base_url),
        download_image(client, &label_url)
    );
    let mut base = base.c(h!())?;
    match labels {
        Ok(labels) => imageops::overlay(&mut base, &labels, 0, 0),
        Err(err) => log::warn!(
            "coordinate screenshot label tile {zoom}/{}/{} failed: {err:#}",
            position.x,
            position.y
        ),
    }
    Ok(base)
}

fn tile_url(template: &str, position: TilePosition, zoom: u8) -> String {
    template
        .replace("{x}", &position.x.to_string())
        .replace("{y}", &position.y.to_string())
        .replace("{z}", &zoom.to_string())
}

async fn download_image(client: &Client, url: &str) -> Result<RgbaImage> {
    let bytes = client
        .get(url)
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?
        .bytes()
        .await
        .c(h!())?;
    Ok(image::load_from_memory(&bytes).c(h!())?.to_rgba8())
}

fn render_map(
    coordinates: &[MapCoordinate],
    viewport: Viewport,
    tiles: Vec<LoadedTile>,
) -> RgbaImage {
    let mut image = RgbaImage::new(
        AUTOMATION_MAP_SCREENSHOT_WIDTH,
        AUTOMATION_MAP_SCREENSHOT_HEIGHT,
    );
    for tile in tiles {
        imageops::overlay(
            &mut image,
            &tile.image,
            tile.position.offset_x,
            tile.position.offset_y,
        );
    }
    for coordinate in coordinates {
        draw_marker(&mut image, viewport, *coordinate);
    }
    image
}

fn draw_marker(
    image: &mut RgbaImage,
    viewport: Viewport,
    coordinate: MapCoordinate,
) {
    let point = project(coordinate, viewport.zoom);
    let center_x = (point.x - viewport.origin.x).round() as i32;
    let center_y = (point.y - viewport.origin.y).round() as i32;
    let inner_radius = AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS
        - AUTOMATION_MAP_SCREENSHOT_MARKER_WEIGHT;
    let outer_squared = AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS.pow(2);
    let inner_squared = inner_radius.pow(2);
    for y in -AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS
        ..=AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS
    {
        for x in -AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS
            ..=AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS
        {
            let distance_squared = x.pow(2) + y.pow(2);
            if distance_squared > outer_squared
                || distance_squared < inner_squared
            {
                continue;
            }
            let pixel_x = center_x + x;
            let pixel_y = center_y + y;
            if pixel_x >= 0
                && pixel_y >= 0
                && pixel_x < image.width() as i32
                && pixel_y < image.height() as i32
            {
                image.put_pixel(
                    pixel_x as u32,
                    pixel_y as u32,
                    Rgba(AUTOMATION_MAP_SCREENSHOT_MARKER_COLOR),
                );
            }
        }
    }
}

fn encode_png(image: RgbaImage) -> Result<String> {
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut png, ImageFormat::Png)
        .c(h!())?;
    Ok(general_purpose::STANDARD.encode(png.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_zero_coordinate_to_world_center() {
        let point = project(MapCoordinate { lat: 0.0, lng: 0.0 }, 1);

        assert_eq!(point.x, 256.0);
        assert_eq!(point.y, 256.0);
    }

    #[test]
    fn uses_maximum_zoom_for_one_coordinate() {
        let viewport = fit_viewport(&[MapCoordinate {
            lat: 47.42135,
            lng: 35.62197,
        }])
        .unwrap();

        assert_eq!(viewport.zoom, AUTOMATION_MAP_SCREENSHOT_MAX_ZOOM);
    }

    #[test]
    fn lowers_zoom_until_all_coordinates_fit() {
        let coordinates = [
            MapCoordinate {
                lat: 47.42135,
                lng: 35.62197,
            },
            MapCoordinate {
                lat: 48.42135,
                lng: 36.62197,
            },
        ];
        let viewport = fit_viewport(&coordinates).unwrap();
        let bounds = pixel_bounds(&coordinates, viewport.zoom);

        assert!(points_fit(&coordinates, viewport.zoom));
        assert!(bounds.1.x > bounds.0.x);
        assert!(bounds.1.y > bounds.0.y);
        assert!(viewport.zoom < AUTOMATION_MAP_SCREENSHOT_MAX_ZOOM);
    }

    #[test]
    fn renders_marker_and_valid_png() {
        let coordinate = MapCoordinate { lat: 0.0, lng: 0.0 };
        let viewport = fit_viewport(&[coordinate]).unwrap();
        let image = render_map(&[coordinate], viewport, Vec::new());
        let marker_pixels = image
            .pixels()
            .filter(|pixel| pixel.0 == AUTOMATION_MAP_SCREENSHOT_MARKER_COLOR)
            .count();
        assert!(marker_pixels > 0);

        let screenshot = encode_png(image).unwrap();
        let bytes = general_purpose::STANDARD.decode(screenshot).unwrap();

        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}

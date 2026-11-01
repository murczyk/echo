//! Image previews sent to vision-capable engines.

use crate::config::{
    AI_AGENT_UPLOAD_IMAGE_JPEG_QUALITIES, AI_AGENT_UPLOAD_IMAGE_MAX_BYTES,
    AI_AGENT_UPLOAD_IMAGE_MAX_EDGE_PX, AI_AGENT_UPLOAD_IMAGE_MAX_PIXELS,
};
use crate::h;
use crate::types::ShortContext;
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageReader};
use std::io::Cursor;

fn decode(bytes: &[u8]) -> anyhow::Result<DynamicImage> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .c(h!())?;
    let (width, height) = reader.into_dimensions().c(h!())?;
    anyhow::ensure!(
        u64::from(width) * u64::from(height)
            <= AI_AGENT_UPLOAD_IMAGE_MAX_PIXELS,
        "image has too many pixels"
    );
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .c(h!())?
        .decode()
        .c(h!())
}

/// Downscales to the configured long edge and re-encodes as JPEG, lowering
/// quality until the result fits the per-image byte budget.
pub(crate) fn preview_jpeg(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    let image = decode(bytes).c(h!())?;
    let edge = AI_AGENT_UPLOAD_IMAGE_MAX_EDGE_PX;
    let image = if image.width() > edge || image.height() > edge {
        image.resize(edge, edge, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let image = DynamicImage::ImageRgb8(image.to_rgb8());
    let mut scaled = image;
    loop {
        for quality in AI_AGENT_UPLOAD_IMAGE_JPEG_QUALITIES {
            let mut encoded = Vec::new();
            scaled
                .write_with_encoder(JpegEncoder::new_with_quality(
                    &mut encoded,
                    *quality,
                ))
                .c(h!())?;
            if encoded.len() <= AI_AGENT_UPLOAD_IMAGE_MAX_BYTES {
                return Ok(encoded);
            }
        }
        anyhow::ensure!(
            scaled.width() > 256 && scaled.height() > 256,
            "image preview does not fit the size budget"
        );
        scaled = scaled.resize(
            scaled.width() * 3 / 4,
            scaled.height() * 3 / 4,
            image::imageops::FilterType::Triangle,
        );
    }
}

/// The extractor only accepts PNG and JPEG rasters.
pub(crate) fn to_png(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut encoded = Vec::new();
    decode(bytes)
        .c(h!())?
        .write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
        .c(h!())?;
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([
                (x % 256) as u8,
                (y % 256) as u8,
                ((x ^ y) % 256) as u8,
            ])
        });
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn preview_is_bounded_jpeg() {
        let preview = preview_jpeg(&png(3000, 1200)).unwrap();
        assert!(preview.len() <= AI_AGENT_UPLOAD_IMAGE_MAX_BYTES);
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!(decoded.width(), AI_AGENT_UPLOAD_IMAGE_MAX_EDGE_PX);
        assert!(decoded.height() < 1200);
    }

    #[test]
    fn rejects_non_images() {
        assert!(preview_jpeg(b"not an image").is_err());
    }
}

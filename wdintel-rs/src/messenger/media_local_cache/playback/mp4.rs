use crate::config::MESSENGER_MEDIA_LOCAL_CACHE_MP4_METADATA_MAX_BYTES;
use crate::h;
use crate::types::ShortContext;
use anyhow::{bail, Result};
use std::path::Path;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(crate) async fn validate(path: &Path) -> Result<()> {
    let mut file = fs::File::open(path).await.c(h!())?;
    let total = file.metadata().await.c(h!())?.len();
    let mut offset = 0;
    while offset + 8 <= total {
        file.seek(std::io::SeekFrom::Start(offset)).await.c(h!())?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).await.c(h!())?;
        let mut size =
            u64::from(u32::from_be_bytes(header[..4].try_into().c(h!())?));
        let kind = &header[4..];
        let header_size = if size == 1 {
            size = file.read_u64().await.c(h!())?;
            16
        } else {
            8
        };
        if size < header_size || size > total - offset {
            bail!("invalid MP4 box size")
        }
        if kind == b"mdat" {
            bail!("normalized MP4 metadata follows its video data")
        }
        if kind == b"moov" {
            if size > MESSENGER_MEDIA_LOCAL_CACHE_MP4_METADATA_MAX_BYTES {
                bail!("MP4 metadata exceeds its limit")
            }
            let mut metadata =
                vec![0; usize::try_from(size - header_size).c(h!())?];
            file.read_exact(&mut metadata).await.c(h!())?;
            if validate_boxes(&metadata, 0).c(h!())? == 0 {
                bail!("MP4 has no H.264 decoder configuration")
            }
            return Ok(());
        }
        offset += size;
    }
    bail!("MP4 has no playback metadata")
}

fn validate_boxes(mut data: &[u8], depth: usize) -> Result<usize> {
    if depth > 8 {
        bail!("MP4 box nesting exceeds its limit")
    }
    let mut configurations = 0;
    while !data.is_empty() {
        if data.len() < 8 {
            bail!("truncated MP4 box header")
        }
        let size =
            usize::try_from(u32::from_be_bytes(data[..4].try_into().c(h!())?))
                .c(h!())?;
        if size < 8 || size > data.len() {
            bail!("truncated MP4 metadata box")
        }
        let kind = &data[4..8];
        let body = &data[8..size];
        match kind {
            b"trak" | b"mdia" | b"minf" | b"stbl" => {
                configurations += validate_boxes(body, depth + 1).c(h!())?
            }
            b"stsd" if body.len() >= 8 => {
                configurations +=
                    validate_boxes(&body[8..], depth + 1).c(h!())?
            }
            b"avc1" if body.len() >= 78 => {
                configurations +=
                    validate_boxes(&body[78..], depth + 1).c(h!())?
            }
            b"avcC" => {
                validate_avcc(body).c(h!())?;
                configurations += 1;
            }
            _ => {}
        }
        data = &data[size..];
    }
    Ok(configurations)
}

fn validate_avcc(data: &[u8]) -> Result<()> {
    if data.len() < 6 || data[0] != 1 || data[5] & 31 == 0 {
        bail!("invalid H.264 decoder configuration")
    }
    let mut offset = 6;
    for _ in 0..data[5] & 31 {
        let length = data.get(offset..offset + 2).c(h!())?;
        let length =
            usize::from(u16::from_be_bytes(length.try_into().c(h!())?));
        offset += 2;
        let sps = data.get(offset..offset + length).c(h!())?;
        if sps.len() < 4 || sps[0] & 31 != 7 || sps[1..4] != data[1..4] {
            bail!("MP4 decoder configuration disagrees with its H.264 stream");
        }
        offset += length;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_avcc;

    #[test]
    fn rejects_the_reported_container_and_stream_level_mismatch() {
        let mut avcc = vec![1, 100, 0, 13, 255, 225, 0, 4, 103, 100, 0, 40];
        assert!(validate_avcc(&avcc).is_err());
        avcc[3] = 40;
        assert!(validate_avcc(&avcc).is_ok());
        avcc.truncate(10);
        assert!(validate_avcc(&avcc).is_err());
    }
}

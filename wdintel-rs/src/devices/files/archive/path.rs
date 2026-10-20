use super::{
    error::{require, Failure},
    manifest::Limits,
};
use crate::{h, types::ShortContext};
use anyhow::{Context, Result};

pub(super) fn extra_fields(mut extra: &[u8]) -> Result<Vec<(u16, &[u8])>> {
    let mut fields = Vec::new();
    while !extra.is_empty() {
        require(extra.len() >= 4, Failure::Invalid).context(h!())?;
        let tag = u16::from_le_bytes([extra[0], extra[1]]);
        let length = u16::from_le_bytes([extra[2], extra[3]]) as usize;
        require(length <= extra.len() - 4, Failure::Invalid).context(h!())?;
        fields.push((tag, &extra[4..4 + length]));
        extra = &extra[4 + length..];
    }
    Ok(fields)
}

pub(super) fn unicode(raw: &[u8], extra: &[u8]) -> Result<Option<String>> {
    let mut found = false;
    let mut name = None;
    for (tag, data) in extra_fields(extra).context(h!())? {
        if tag != 0x7075 {
            continue;
        }
        require(!found && data.len() >= 5, Failure::Invalid).context(h!())?;
        found = true;
        let crc = u32::from_le_bytes(data[1..5].try_into().c(h!())?);
        if data[0] == 1 && crc == crc32fast::hash(raw) {
            name = Some(
                std::str::from_utf8(&data[5..])
                    .map_err(|_| Failure::Invalid)
                    .context(h!())?
                    .to_owned(),
            );
        }
    }
    Ok(name)
}

pub(super) fn decode(raw: &[u8], flags: u16, extra: &[u8]) -> Result<String> {
    let unicode = unicode(raw, extra).context(h!())?;
    if flags & 0x800 != 0 {
        let name = std::str::from_utf8(raw)
            .map_err(|_| Failure::Invalid)
            .context(h!())?;
        require(
            unicode.as_deref().is_none_or(|value| value == name),
            Failure::PathConflict,
        )
        .context(h!())?;
        return Ok(name.to_owned());
    }
    if let Some(name) = unicode {
        return Ok(name);
    }
    Ok(raw
        .iter()
        .map(|byte| {
            if *byte < 128 {
                char::from(*byte)
            } else {
                CP437[usize::from(*byte) - 128]
            }
        })
        .collect())
}

pub(super) fn validate(
    name: &str,
    directory: bool,
    limits: &Limits,
) -> Result<String> {
    let path = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    require(
        !path.is_empty()
            && !path.starts_with('/')
            && !path.contains(['\\', ':'])
            && !path.chars().any(char::is_control),
        Failure::UnsafePath,
    )
    .context(h!())?;
    require(
        path.len() as u64 <= limits.path_bytes,
        Failure::Limit("path_bytes"),
    )
    .context(h!())?;
    let mut components = 0;
    for part in path.split('/') {
        require(
            !part.is_empty() && part != "." && part != "..",
            Failure::UnsafePath,
        )
        .context(h!())?;
        components += 1;
    }
    require(
        components <= limits.path_components,
        Failure::Limit("path_components"),
    )
    .context(h!())?;
    Ok(path.to_owned())
}

const CP437: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä',
    'Å', 'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥',
    '₧', 'ƒ', 'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼',
    '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗',
    '╝', '╜', '╛', '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩',
    '╦', '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘',
    '┌', '█', '▄', '▌', '▐', '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ',
    'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈',
    '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u{00a0}',
];

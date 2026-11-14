use crate::error::AppError;
use crate::h;
use crate::messengers::types::MessengersMessagesDirection;
use crate::types::ShortContext;

/// A cursor page of a timeline: the newest page, the first page, or the
/// page next to a position decoded from a cursor.
pub(crate) enum CursorPage<P> {
    Latest,
    Oldest,
    Older(P),
    Newer(P),
}

pub(crate) fn page_limit(
    limit: Option<i64>,
    default: i64,
    max: i64,
) -> Result<u64, AppError> {
    let limit = limit.unwrap_or(default);
    if !(1..=max).contains(&limit) {
        return Err(AppError::BL {
            msg: format!("invalid limit: {limit}, max {max}"),
        });
    }
    Ok(limit as u64)
}

/// Without a cursor, `Older` and `Newer` have no effect; `Oldest` cannot be
/// combined with a cursor.
pub(crate) fn parse_cursor_page<P>(
    cursor: Option<&str>,
    direction: Option<MessengersMessagesDirection>,
    decode: impl FnOnce(&str) -> Result<P, AppError>,
) -> Result<CursorPage<P>, AppError> {
    let oldest = direction == Some(MessengersMessagesDirection::Oldest);
    let Some(cursor) = cursor else {
        return Ok(if oldest {
            CursorPage::Oldest
        } else {
            CursorPage::Latest
        });
    };
    if oldest {
        return Err(AppError::BL {
            msg: "direction Oldest excludes cursor".to_string(),
        });
    }
    let position = decode(cursor).c(h!())?;
    Ok(match direction {
        Some(MessengersMessagesDirection::Newer) => CursorPage::Newer(position),
        _ => CursorPage::Older(position),
    })
}

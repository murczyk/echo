//! Parses `-f framecrc` packet statistics streamed on stdout: proves the
//! whole input was decoded and yields its decoded duration.
//! Ported from wdintel-rs `devices/audio/probe.rs` `OutputProgress`.

use crate::constants::*;
use crate::error::{MediaError, Result};
use crate::limits::*;

#[derive(Debug, Default)]
pub(crate) struct Framecrc {
    pending: Vec<u8>,
    time_base: Option<(u128, u128)>,
    ticks: u128,
}

impl Framecrc {
    /// Feed one stdout chunk. Returns whether a decoded packet was seen.
    pub(crate) fn consume(&mut self, chunk: &[u8]) -> Result<bool> {
        if self.pending.len() + chunk.len() > ECHO_MEDIA_AUDIO_FRAMECRC_BYTES {
            return Err(MediaError::OutputLimit);
        }
        self.pending.extend_from_slice(chunk);
        let mut progressed = false;
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| MediaError::invalid("framecrc is not UTF-8"))?;
            progressed |= self.line(line.trim())?;
        }
        Ok(progressed)
    }

    /// Decoded duration in microseconds, once stdout has closed.
    pub(crate) fn finish(&self) -> Result<i64> {
        if !self.pending.is_empty() {
            return Err(MediaError::invalid("decoding did not complete"));
        }
        let (numerator, denominator) = self
            .time_base
            .ok_or_else(|| MediaError::invalid("no decoded audio packets"))?;
        let duration = self
            .ticks
            .checked_mul(numerator)
            .and_then(|value| {
                value.checked_mul(ECHO_MEDIA_AUDIO_MICROSECONDS_PER_SECOND)
            })
            .and_then(|value| value.checked_add(denominator / 2))
            .ok_or_else(out_of_range)?
            / denominator;
        let duration = i64::try_from(duration).map_err(|_| out_of_range())?;
        if duration <= 0 {
            return Err(MediaError::invalid(
                "decoded duration is not positive",
            ));
        }
        Ok(duration)
    }

    fn line(&mut self, line: &str) -> Result<bool> {
        if let Some(value) = line.strip_prefix("#tb 0:") {
            self.time_base(value.trim())?;
            return Ok(false);
        }
        if line.starts_with('#') || line.is_empty() {
            return Ok(false);
        }
        self.packet(line)?;
        Ok(true)
    }

    fn time_base(&mut self, value: &str) -> Result<()> {
        let invalid = || MediaError::invalid("invalid decoded time base");
        let (numerator, denominator) =
            value.split_once('/').ok_or_else(invalid)?;
        let time_base = (
            numerator.parse::<u128>().map_err(|_| invalid())?,
            denominator.parse::<u128>().map_err(|_| invalid())?,
        );
        if time_base.0 == 0
            || time_base.1 == 0
            || self.time_base.is_some_and(|previous| previous != time_base)
        {
            return Err(invalid());
        }
        self.time_base = Some(time_base);
        Ok(())
    }

    fn packet(&mut self, line: &str) -> Result<()> {
        let invalid = || MediaError::invalid("invalid decoded packet");
        let fields: Vec<_> = line.split(',').map(str::trim).collect();
        if fields.len() != 6 || fields[0] != "0" || self.time_base.is_none() {
            return Err(invalid());
        }
        let ticks = fields[3].parse::<u128>().map_err(|_| invalid())?;
        let size = fields[4].parse::<u64>().map_err(|_| invalid())?;
        if ticks == 0 || size == 0 {
            return Err(MediaError::invalid("empty decoded packet"));
        }
        self.ticks = self.ticks.checked_add(ticks).ok_or_else(out_of_range)?;
        Ok(())
    }
}

fn out_of_range() -> MediaError {
    MediaError::invalid("decoded duration is out of range")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_packet_durations_across_chunks() {
        let mut crc = Framecrc::default();
        let text = "#software: Lavf\n#tb 0: 1/48000\n#media_type 0: audio\n\
                    0, 0, 0, 24000, 96000, 0x1\n0, 1, 1, 24000, 96000, 0x2\n";
        let (first, second) = text.split_at(40);
        crc.consume(first.as_bytes()).unwrap();
        assert!(crc.consume(second.as_bytes()).unwrap());
        assert_eq!(crc.finish().unwrap(), 1_000_000);
    }

    #[test]
    fn rejects_truncated_or_inconsistent_output() {
        let mut partial = Framecrc::default();
        partial.consume(b"#tb 0: 1/48000\n0, 0, 0, 10").unwrap();
        assert!(partial.finish().is_err());
        let mut changed = Framecrc::default();
        changed.consume(b"#tb 0: 1/48000\n").unwrap();
        assert!(changed.consume(b"#tb 0: 1/44100\n").is_err());
        let mut empty = Framecrc::default();
        empty.consume(b"#tb 0: 1/48000\n").unwrap();
        assert!(empty.finish().is_err());
        let mut zero = Framecrc::default();
        assert!(zero
            .consume(b"#tb 0: 1/48000\n0, 0, 0, 0, 1, 0x1\n")
            .is_err());
    }
}

use crate::constants::*;
use crate::error::{MediaError, Result};
use crate::sandbox::{Network, Policy};
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

/// Media to read: a local regular file or an allowlisted HTTPS object.
#[derive(Debug, Clone)]
pub enum Input {
    File(LocalFile),
    Remote(RemoteUrl),
}

impl Input {
    pub fn file(path: impl AsRef<Path>) -> Result<Self> {
        LocalFile::new(path).map(Self::File)
    }

    pub(crate) fn protocols(&self) -> &'static str {
        match self {
            Self::File(_) => ECHO_MEDIA_PROTOCOLS_LOCAL,
            Self::Remote(_) => ECHO_MEDIA_PROTOCOLS_REMOTE,
        }
    }

    /// The `-i` argument: `file:` forces the file protocol for local paths,
    /// so names such as `concat:a|b` or `subfile,,...:x` stay literal.
    pub(crate) fn argument(&self) -> OsString {
        match self {
            Self::File(file) => {
                let mut value = OsString::from("file:");
                value.push(file.path.as_os_str());
                value
            }
            Self::Remote(url) => OsString::from(&url.url),
        }
    }

    pub(crate) fn grant(&self, policy: Policy) -> Policy {
        match self {
            Self::File(file) => policy.read_file(&file.path),
            Self::Remote(url) => {
                policy.network(Network::TcpConnect(vec![url.port]))
            }
        }
    }

    pub(crate) fn secrets(&self) -> Vec<String> {
        match self {
            Self::File(_) => Vec::new(),
            Self::Remote(url) => url.secrets(),
        }
    }
}

/// An absolute path to an existing regular file (not a symlink).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    path: PathBuf,
}

impl LocalFile {
    pub fn new(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return Err(MediaError::rejected("input path must be absolute"));
        }
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            MediaError::rejected(format!("input {}: {error}", path.display()))
        })?;
        if !metadata.file_type().is_file() {
            return Err(MediaError::rejected(
                "input must be a regular file, not a symlink",
            ));
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// An `https://` URL whose host is on the caller's allowlist. `Debug` and
/// `Display` never print it, and it is redacted from stderr.
#[derive(Clone)]
pub struct RemoteUrl {
    url: String,
    host: String,
    port: u16,
}

impl RemoteUrl {
    pub fn new(url: &str, allowed_hosts: &[&str]) -> Result<Self> {
        if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(MediaError::rejected(
                "remote URL has control characters",
            ));
        }
        let rest = url
            .strip_prefix(ECHO_MEDIA_REMOTE_SCHEME)
            .ok_or_else(|| MediaError::rejected("remote URL must use https"))?;
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (host, port) = split_authority(&rest[..end])?;
        if !allowed_hosts
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&host))
        {
            return Err(MediaError::rejected("remote host is not allowed"));
        }
        Ok(Self {
            url: url.to_string(),
            host,
            port,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    fn secrets(&self) -> Vec<String> {
        let mut secrets = vec![self.url.clone()];
        if let Some((_, query)) = self.url.split_once('?') {
            secrets.push(query.to_string());
        }
        secrets
    }
}

fn split_authority(authority: &str) -> Result<(String, u16)> {
    if authority.is_empty() || authority.contains('@') {
        return Err(MediaError::rejected(
            "remote URL has an invalid authority",
        ));
    }
    if authority.starts_with('[') {
        return Err(MediaError::rejected("IP literal hosts are not supported"));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port.parse::<u16>().map_err(|_| {
                MediaError::rejected("remote URL has an invalid port")
            })?;
            (host, port)
        }
        None => (authority, ECHO_MEDIA_REMOTE_DEFAULT_PORT),
    };
    if host.is_empty() || port == 0 {
        return Err(MediaError::rejected(
            "remote URL has an invalid authority",
        ));
    }
    Ok((host.to_ascii_lowercase(), port))
}

impl fmt::Debug for RemoteUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteUrl")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("url", &ECHO_MEDIA_REDACTED)
            .finish()
    }
}

impl fmt::Display for RemoteUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "https://{}/{ECHO_MEDIA_REDACTED}", self.host)
    }
}

/// A comma-separated demuxer allowlist passed as `-format_whitelist`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Formats(&'static str);

impl Formats {
    pub const THUMBNAIL: Self = Self(ECHO_MEDIA_FORMATS_THUMBNAIL);
    pub const IMAGE: Self = Self(ECHO_MEDIA_FORMATS_IMAGE);
    pub const VIDEO: Self = Self(ECHO_MEDIA_FORMATS_VIDEO);
    pub const AUDIO: Self = Self(ECHO_MEDIA_FORMATS_AUDIO);
    pub const MOV: Self = Self(ECHO_MEDIA_FORMATS_MOV);
    pub const WAV_MP3: Self = Self(ECHO_MEDIA_FORMATS_WAV_MP3);

    /// A custom allowlist. Demuxers that follow references to other files or
    /// URLs (`hls`, `concat`, `lavfi`, ...) are refused.
    pub fn custom(list: &'static str) -> Result<Self> {
        let names: Vec<_> = list.split(',').map(str::trim).collect();
        if names.iter().any(|name| name.is_empty()) {
            return Err(MediaError::rejected("empty demuxer name"));
        }
        if let Some(name) = names
            .iter()
            .find(|name| ECHO_MEDIA_FORMATS_FORBIDDEN.contains(name))
        {
            return Err(MediaError::rejected(format!(
                "demuxer {name} is not allowed"
            )));
        }
        Ok(Self(list))
    }

    pub fn as_str(&self) -> &'static str {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S3: &str = "s3.eu-central-003.backblazeb2.com";

    #[test]
    fn remote_url_requires_https_and_an_allowed_host() {
        let url = format!("https://{S3}/bucket/key?X-Amz-Signature=abc");
        let remote = RemoteUrl::new(&url, &[S3]).unwrap();
        assert_eq!(remote.port(), 443);
        for bad in [
            format!("http://{S3}/key"),
            "https://evil.example/key".to_string(),
            format!("https://user@{S3}/key"),
            format!("https://evil.example@{S3}/key"),
            format!("https://{S3}:0/key"),
            format!("https://{S3}/key with space"),
            "https://[::1]/key".to_string(),
        ] {
            assert!(RemoteUrl::new(&bad, &[S3]).is_err(), "{bad}");
        }
    }

    #[test]
    fn remote_url_is_never_printed() {
        let url = format!("https://{S3}:8443/key?X-Amz-Signature=secret");
        let remote = RemoteUrl::new(&url, &[S3]).unwrap();
        assert_eq!(remote.port(), 8443);
        let printed = format!("{remote:?} {remote}");
        assert!(!printed.contains("secret"), "{printed}");
        assert!(!printed.contains("/key"), "{printed}");
        let secrets = Input::Remote(remote).secrets();
        assert!(secrets.contains(&url));
        assert!(secrets.contains(&"X-Amz-Signature=secret".to_string()));
    }

    #[test]
    fn local_file_must_be_an_absolute_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("source");
        std::fs::write(&file, b"x").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(LocalFile::new(&file).is_ok());
        assert!(LocalFile::new("relative/source").is_err());
        assert!(LocalFile::new(&link).is_err());
        assert!(LocalFile::new(dir.path()).is_err());
        assert!(LocalFile::new(dir.path().join("missing")).is_err());
    }

    #[test]
    fn local_input_argument_forces_the_file_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("concat:a|b");
        std::fs::write(&file, b"x").unwrap();
        let argument = Input::file(&file).unwrap().argument();
        let expected = format!("file:{}", file.display());
        assert_eq!(argument, OsString::from(expected));
    }

    #[test]
    fn custom_formats_refuse_reference_following_demuxers() {
        assert!(Formats::custom("mov,matroska").is_ok());
        for bad in ["mov,hls", "concat", "lavfi", "mov,,mp3"] {
            assert!(Formats::custom(bad).is_err(), "{bad}");
        }
        for preset in [
            Formats::THUMBNAIL,
            Formats::IMAGE,
            Formats::VIDEO,
            Formats::AUDIO,
            Formats::MOV,
            Formats::WAV_MP3,
        ] {
            assert!(Formats::custom(preset.as_str()).is_ok(), "{preset:?}");
        }
    }
}

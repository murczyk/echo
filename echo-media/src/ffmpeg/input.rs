use crate::constants::*;
use crate::error::{MediaError, Result};
use crate::sandbox::{Network, Policy};
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

/// Media to read: a local regular file or an object on an allowlisted origin.
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
            Self::Remote(url) => url.origin.scheme.protocols(),
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
                policy.network(Network::TcpConnect(vec![url.origin.port]))
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

/// URL scheme of a remote input. It selects ffmpeg's protocol whitelist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

impl Scheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }

    fn protocols(self) -> &'static str {
        match self {
            Self::Http => ECHO_MEDIA_PROTOCOLS_HTTP,
            Self::Https => ECHO_MEDIA_PROTOCOLS_HTTPS,
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Self::Http => ECHO_MEDIA_HTTP_DEFAULT_PORT,
            Self::Https => ECHO_MEDIA_HTTPS_DEFAULT_PORT,
        }
    }

    /// Splits `scheme://` off `url`, ignoring ASCII case.
    fn strip(url: &str) -> Option<(Self, &str)> {
        [Self::Https, Self::Http].into_iter().find_map(|scheme| {
            let prefix_len = scheme.as_str().len() + 3;
            let prefix = url.get(..prefix_len)?;
            let expected = format!("{}://", scheme.as_str());
            prefix
                .eq_ignore_ascii_case(&expected)
                .then(|| (scheme, &url[prefix_len..]))
        })
    }
}

/// Scheme, host and port: what an allowlist entry and a URL must share.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Origin {
    scheme: Scheme,
    host: String,
    port: u16,
}

impl Origin {
    /// Parses the origin of `url`, returning it and the rest of the URL
    /// (path, query and fragment).
    fn parse(url: &str) -> Result<(Self, &str)> {
        let (scheme, rest) = Scheme::strip(url).ok_or_else(|| {
            MediaError::rejected("remote URL must use http or https")
        })?;
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (host, port) = split_authority(&rest[..end], scheme)?;
        Ok((Self { scheme, host, port }, &rest[end..]))
    }
}

/// An `http://` or `https://` URL whose origin (scheme, host and port) is on
/// the caller's allowlist. The scheme picks ffmpeg's protocol whitelist.
/// `Debug` and `Display` never print the path or query, and the URL is
/// redacted from stderr.
#[derive(Clone)]
pub struct RemoteUrl {
    url: String,
    origin: Origin,
}

impl RemoteUrl {
    /// `allowed_origins` are origins such as `https://s3.example.com` or
    /// `http://127.0.0.1:9000`; a missing port means the scheme's default.
    pub fn new(url: &str, allowed_origins: &[&str]) -> Result<Self> {
        if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(MediaError::rejected(
                "remote URL has control characters",
            ));
        }
        let (origin, _) = Origin::parse(url)?;
        for allowed in allowed_origins {
            if allowed_origin(allowed)? == origin {
                return Ok(Self {
                    url: url.to_string(),
                    origin,
                });
            }
        }
        Err(MediaError::rejected("remote origin is not allowed"))
    }

    pub fn scheme(&self) -> Scheme {
        self.origin.scheme
    }

    pub fn host(&self) -> &str {
        &self.origin.host
    }

    pub fn port(&self) -> u16 {
        self.origin.port
    }

    fn secrets(&self) -> Vec<String> {
        let mut secrets = vec![self.url.clone()];
        if let Some((_, query)) = self.url.split_once('?') {
            secrets.push(query.to_string());
        }
        secrets
    }
}

fn allowed_origin(allowed: &str) -> Result<Origin> {
    let (origin, rest) = Origin::parse(allowed)?;
    if !rest.is_empty() && rest != "/" {
        return Err(MediaError::rejected(
            "allowed origin must not have a path or query",
        ));
    }
    Ok(origin)
}

fn split_authority(authority: &str, scheme: Scheme) -> Result<(String, u16)> {
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
        None => (authority, scheme.default_port()),
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
            .field("scheme", &self.origin.scheme)
            .field("host", &self.origin.host)
            .field("port", &self.origin.port)
            .field("url", &ECHO_MEDIA_REDACTED)
            .finish()
    }
}

impl fmt::Display for RemoteUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let origin = &self.origin;
        write!(
            f,
            "{}://{}:{}/{ECHO_MEDIA_REDACTED}",
            origin.scheme.as_str(),
            origin.host,
            origin.port
        )
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

    const S3: &str = "https://s3.eu-central-003.backblazeb2.com";
    const MINIO: &str = "http://127.0.0.1:9000";

    #[test]
    fn remote_url_must_match_an_allowed_origin() {
        let url = format!("{S3}/bucket/key?X-Amz-Signature=abc");
        let remote = RemoteUrl::new(&url, &[S3]).unwrap();
        assert_eq!(remote.scheme(), Scheme::Https);
        assert_eq!(remote.port(), 443);
        let explicit = "HTTPS://S3.eu-central-003.backblazeb2.com:443/key";
        assert!(RemoteUrl::new(explicit, &[S3]).is_ok());
        let local =
            RemoteUrl::new(&format!("{MINIO}/bucket/key"), &[S3, MINIO])
                .unwrap();
        assert_eq!((local.scheme(), local.port()), (Scheme::Http, 9000));
        for bad in [
            "http://s3.eu-central-003.backblazeb2.com/key".to_string(),
            "https://s3.eu-central-003.backblazeb2.com:8443/key".to_string(),
            "http://127.0.0.1/key".to_string(),
            "https://127.0.0.1:9000/key".to_string(),
            "https://evil.example/key".to_string(),
            "ftp://s3.eu-central-003.backblazeb2.com/key".to_string(),
            "file:///etc/passwd".to_string(),
            "https://user@s3.eu-central-003.backblazeb2.com/key".to_string(),
            "https://evil.example@s3.eu-central-003.backblazeb2.com/key"
                .to_string(),
            format!("{S3}:0/key"),
            format!("{S3}/key with space"),
            "https://[::1]/key".to_string(),
        ] {
            assert!(RemoteUrl::new(&bad, &[S3, MINIO]).is_err(), "{bad}");
        }
    }

    #[test]
    fn allowed_origins_must_be_bare_origins() {
        let url = format!("{S3}/key");
        let with_path = format!("{S3}/bucket");
        assert!(RemoteUrl::new(&url, &[&with_path]).is_err());
        assert!(RemoteUrl::new(&url, &[&format!("{S3}/")]).is_ok());
        assert!(RemoteUrl::new(&url, &["s3.eu-central-003.backblazeb2.com"])
            .is_err());
    }

    #[test]
    fn scheme_selects_the_protocol_whitelist() {
        let https = RemoteUrl::new(&format!("{S3}/key"), &[S3]).unwrap();
        let http = RemoteUrl::new(&format!("{MINIO}/key"), &[MINIO]).unwrap();
        assert_eq!(Input::Remote(https).protocols(), "https,tls,tcp");
        assert_eq!(Input::Remote(http).protocols(), "http,tcp");
    }

    #[test]
    fn remote_url_is_never_printed() {
        let url = "https://s3.eu-central-003.backblazeb2.com:8443/key?X-Amz-Signature=secret";
        let origin = "https://s3.eu-central-003.backblazeb2.com:8443";
        let remote = RemoteUrl::new(url, &[origin]).unwrap();
        assert_eq!(remote.port(), 8443);
        let printed = format!("{remote:?} {remote}");
        assert!(!printed.contains("secret"), "{printed}");
        assert!(!printed.contains("/key"), "{printed}");
        let secrets = Input::Remote(remote).secrets();
        assert!(secrets.contains(&url.to_string()));
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

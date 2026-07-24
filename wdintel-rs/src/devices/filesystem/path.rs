use super::{
    error::{FilesystemError, FilesystemFieldError},
    types::{ParsedSourcePath, PathSyntax},
    validation::{
        validate_absolute_path_limits, validate_path_component_limits,
    },
};

#[allow(dead_code)]
pub(in crate::devices) struct SourcePathParser;

#[allow(dead_code)]
impl SourcePathParser {
    pub(in crate::devices) fn parse(
        path_syntax: PathSyntax,
        absolute_path: String,
        field_path: &str,
    ) -> Result<ParsedSourcePath, FilesystemError> {
        validate_absolute_path_limits(&absolute_path, field_path)?;

        let (root_name, components) = match path_syntax {
            PathSyntax::Posix => parse_posix_path(&absolute_path),
            PathSyntax::Windows => parse_windows_path(&absolute_path),
        }
        .ok_or_else(|| invalid_absolute_path(field_path))?;

        validate_path_component_limits(&components, field_path)?;
        let components = components.into_iter().map(str::to_string).collect();

        Ok(ParsedSourcePath {
            path_syntax,
            absolute_path,
            root_name,
            components,
        })
    }
}

#[allow(dead_code)]
pub(super) fn name_key(name: &str) -> Vec<u8> {
    name.as_bytes().to_vec()
}

fn parse_posix_path(absolute_path: &str) -> Option<(String, Vec<&str>)> {
    let path_without_root = absolute_path.strip_prefix('/')?;
    if path_without_root.is_empty()
        || path_without_root.starts_with('/')
        || absolute_path.contains('\\')
    {
        return None;
    }

    let components = path_without_root.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| !is_valid_component(component))
    {
        return None;
    }

    Some(("/".to_string(), components))
}

fn parse_windows_path(absolute_path: &str) -> Option<(String, Vec<&str>)> {
    if absolute_path.contains('/') {
        return None;
    }

    if absolute_path.starts_with("\\\\?\\")
        || absolute_path.starts_with("\\\\.\\")
    {
        return None;
    }

    if absolute_path.starts_with("\\\\") {
        parse_unc_path(absolute_path)
    } else {
        parse_drive_path(absolute_path)
    }
}

fn parse_drive_path(absolute_path: &str) -> Option<(String, Vec<&str>)> {
    let bytes = absolute_path.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return None;
    }

    let components = absolute_path[3..].split('\\').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| !is_valid_component(component))
    {
        return None;
    }

    let drive = (bytes[0] as char).to_ascii_uppercase();
    Some((format!("{drive}:\\"), components))
}

fn parse_unc_path(absolute_path: &str) -> Option<(String, Vec<&str>)> {
    let path_without_prefix = absolute_path.strip_prefix("\\\\")?;
    let mut path_segments = path_without_prefix.split('\\');
    let server = path_segments.next()?;
    let share = path_segments.next()?;
    let components = path_segments.collect::<Vec<_>>();

    if !is_valid_component(server)
        || !is_valid_component(share)
        || components.is_empty()
        || components
            .iter()
            .any(|component| !is_valid_component(component))
    {
        return None;
    }

    Some((format!("\\\\{server}\\{share}\\"), components))
}

fn is_valid_component(component: &str) -> bool {
    !component.is_empty()
        && !component.contains('\0')
        && !matches!(component, "." | "..")
}

fn invalid_absolute_path(field_path: &str) -> FilesystemError {
    FilesystemError::Validation(vec![FilesystemFieldError {
        path: field_path.to_string(),
        message:
            "must be an absolute file path valid for the selected path syntax"
                .to_string(),
    }])
}

#[cfg(test)]
mod tests;

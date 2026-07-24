use super::*;
use crate::config::{
    DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS, DEVICE_FILE_PATH_COMPONENT_MAX_CHARS,
    DEVICE_FILE_PATH_COMPONENT_MAX_COUNT,
};

fn validation_errors(
    result: Result<ParsedSourcePath, FilesystemError>,
) -> Vec<FilesystemFieldError> {
    match result {
        Err(FilesystemError::Validation(errors)) => errors,
        _ => panic!("expected filesystem validation error"),
    }
}

#[test]
fn parser_preserves_exact_paths_and_canonicalizes_only_drive_roots() {
    struct Case {
        path_syntax: PathSyntax,
        absolute_path: &'static str,
        root_name: &'static str,
        components: &'static [&'static str],
    }

    let cases = [
        Case {
            path_syntax: PathSyntax::Posix,
            absolute_path: "/var/Журнал/app.log",
            root_name: "/",
            components: &["var", "Журнал", "app.log"],
        },
        Case {
            path_syntax: PathSyntax::Windows,
            absolute_path: r"c:\Logs\APP.LOG",
            root_name: r"C:\",
            components: &["Logs", "APP.LOG"],
        },
        Case {
            path_syntax: PathSyntax::Windows,
            absolute_path: r"\\Server\Share\dir\report.pdf",
            root_name: r"\\Server\Share\",
            components: &["dir", "report.pdf"],
        },
        Case {
            path_syntax: PathSyntax::Windows,
            absolute_path: r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_disarm.wav",
            root_name: r"D:\",
            components: &[
                "Counter-Strike Source v34 HD",
                "cstrike",
                "sound",
                "weapons",
                "csgo",
                "c4",
                "c4_disarm.wav",
            ],
        },
        Case {
            path_syntax: PathSyntax::Windows,
            absolute_path: r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_plant.wav",
            root_name: r"D:\",
            components: &[
                "Counter-Strike Source v34 HD",
                "cstrike",
                "sound",
                "weapons",
                "csgo",
                "c4",
                "c4_plant.wav",
            ],
        },
        Case {
            path_syntax: PathSyntax::Posix,
            absolute_path: "/var/<:|?*>.log",
            root_name: "/",
            components: &["var", "<:|?*>.log"],
        },
        Case {
            path_syntax: PathSyntax::Windows,
            absolute_path: r"C:\<:|?*>\report",
            root_name: r"C:\",
            components: &["<:|?*>", "report"],
        },
    ];

    for case in cases {
        let parsed = SourcePathParser::parse(
            case.path_syntax,
            case.absolute_path.to_string(),
            "files[3].absolute_path",
        )
        .unwrap();

        assert_eq!(parsed.path_syntax, case.path_syntax);
        assert_eq!(parsed.absolute_path, case.absolute_path);
        assert_eq!(
            parsed.absolute_path.as_bytes(),
            case.absolute_path.as_bytes()
        );
        assert_eq!(parsed.root_name, case.root_name);
        assert_eq!(
            parsed.components,
            case.components
                .iter()
                .map(|component| (*component).to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(parsed.file_name(), *case.components.last().unwrap());
    }
}

#[test]
fn name_key_preserves_exact_utf8_bytes() {
    let name = "Журнал.TXT";

    assert_eq!(name_key(name), name.as_bytes());
}

#[test]
fn parser_rejects_each_forbidden_path_form_with_exact_field_path() {
    let cases = [
        (PathSyntax::Posix, "/".to_string()),
        (PathSyntax::Posix, "relative/file".to_string()),
        (PathSyntax::Posix, "//dir/file".to_string()),
        (PathSyntax::Posix, "/dir//file".to_string()),
        (PathSyntax::Posix, "/dir/".to_string()),
        (PathSyntax::Posix, "/dir\\file".to_string()),
        (PathSyntax::Posix, "/./file".to_string()),
        (PathSyntax::Posix, "/dir/..".to_string()),
        (PathSyntax::Posix, "/dir/\0file".to_string()),
        (PathSyntax::Windows, "C:file".to_string()),
        (PathSyntax::Windows, "\\file".to_string()),
        (PathSyntax::Windows, "C:\\".to_string()),
        (PathSyntax::Windows, "C:\\dir/file".to_string()),
        (PathSyntax::Windows, "C:\\\\file".to_string()),
        (PathSyntax::Windows, "C:\\dir\\".to_string()),
        (PathSyntax::Windows, "C:\\.\\file".to_string()),
        (PathSyntax::Windows, "C:\\dir\\..\\file".to_string()),
        (PathSyntax::Windows, "C:\\dir\\\0file".to_string()),
        (PathSyntax::Windows, r"\\?\C:\file".to_string()),
        (PathSyntax::Windows, r"\\.\C:\file".to_string()),
        (PathSyntax::Windows, r"\\\server\share\file".to_string()),
        (PathSyntax::Windows, r"\\server\share".to_string()),
        (PathSyntax::Windows, r"\\server\\file".to_string()),
        (PathSyntax::Windows, r"\\server\share\dir\\file".to_string()),
        (PathSyntax::Windows, "\\\\server\\share\\dir\\".to_string()),
        (PathSyntax::Windows, r"\\.\share\dir\file".to_string()),
        (PathSyntax::Windows, r"\\server\share\..\file".to_string()),
    ];

    for (index, (path_syntax, absolute_path)) in cases.into_iter().enumerate() {
        let field_path = format!("files[{index}].absolute_path");
        assert_eq!(
            validation_errors(SourcePathParser::parse(
                path_syntax,
                absolute_path,
                &field_path,
            )),
            vec![FilesystemFieldError {
                path: field_path,
                message: "must be an absolute file path valid for the selected path syntax"
                    .to_string(),
            }]
        );
    }
}

#[test]
fn parser_enforces_scalar_component_count_and_component_length_boundaries() {
    let component_count = DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS
        / DEVICE_FILE_PATH_COMPONENT_MAX_CHARS;
    let component = "a".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS - 1);
    let max_path = format!("/{}", vec![component; component_count].join("/"));
    assert_eq!(
        max_path.chars().count(),
        DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS
    );
    assert!(SourcePathParser::parse(
        PathSyntax::Posix,
        max_path.clone(),
        "files[0].absolute_path",
    )
    .is_ok());

    let scalar_overflow = format!("{max_path}a");
    assert_eq!(
        validation_errors(SourcePathParser::parse(
            PathSyntax::Posix,
            scalar_overflow,
            "files[0].absolute_path",
        )),
        vec![FilesystemFieldError {
            path: "files[0].absolute_path".to_string(),
            message: format!(
                "must contain between 1 and {DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS} Unicode scalar values"
            ),
        }]
    );

    let max_component =
        format!("/{}", "💾".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS));
    assert!(SourcePathParser::parse(
        PathSyntax::Posix,
        max_component,
        "files[1].absolute_path",
    )
    .is_ok());
    let component_overflow =
        format!("/{}", "💾".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS + 1));
    assert_eq!(
        validation_errors(SourcePathParser::parse(
            PathSyntax::Posix,
            component_overflow,
            "files[1].absolute_path",
        )),
        vec![FilesystemFieldError {
            path: "files[1].absolute_path".to_string(),
            message: format!(
                "each path component must contain between 1 and {DEVICE_FILE_PATH_COMPONENT_MAX_CHARS} Unicode scalar values"
            ),
        }]
    );

    let max_component_count = format!(
        "/{}",
        vec!["a"; DEVICE_FILE_PATH_COMPONENT_MAX_COUNT].join("/")
    );
    assert!(SourcePathParser::parse(
        PathSyntax::Posix,
        max_component_count,
        "files[2].absolute_path",
    )
    .is_ok());
    let component_count_overflow = format!(
        "/{}",
        vec!["a"; DEVICE_FILE_PATH_COMPONENT_MAX_COUNT + 1].join("/")
    );
    assert_eq!(
        validation_errors(SourcePathParser::parse(
            PathSyntax::Posix,
            component_count_overflow,
            "files[2].absolute_path",
        )),
        vec![FilesystemFieldError {
            path: "files[2].absolute_path".to_string(),
            message: format!(
                "must contain between 1 and {DEVICE_FILE_PATH_COMPONENT_MAX_COUNT} path components"
            ),
        }]
    );
}

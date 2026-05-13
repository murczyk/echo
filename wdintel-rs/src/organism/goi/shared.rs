use crate::config::{
    ORGANISM_GOI_API_PORT_DEFAULT, ORGANISM_GOI_INTEGRATION_TYPE_FULL,
    ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE,
};
use crate::entities::{goi_integration, organism};
use crate::organism::types::GoiIntegrationType;
use crate::utils::string::normalize_optional_trimmed;
use url::Url;

pub fn goi_integration_type(organism: &organism::Model) -> GoiIntegrationType {
    match organism.goi_integration_type.trim() {
        ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE => GoiIntegrationType::Simple,
        ORGANISM_GOI_INTEGRATION_TYPE_FULL => GoiIntegrationType::Full,
        _ => GoiIntegrationType::Full,
    }
}

pub fn goi_integration_type_db_value(
    integration_type: &GoiIntegrationType,
) -> &'static str {
    match integration_type {
        GoiIntegrationType::Simple => ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE,
        GoiIntegrationType::Full => ORGANISM_GOI_INTEGRATION_TYPE_FULL,
    }
}

pub fn goi_api_host(organism: &organism::Model) -> Option<String> {
    if goi_integration_type(organism) != GoiIntegrationType::Full {
        return None;
    }
    normalize_optional_trimmed(organism.goi_api_host.clone())
        .or_else(|| normalize_optional_trimmed(organism.goi_ssh_host.clone()))
}

pub fn goi_web_host(organism: &organism::Model) -> Option<String> {
    let ssh_host = normalize_optional_trimmed(organism.goi_ssh_host.clone());
    let api_host = normalize_optional_trimmed(organism.goi_api_host.clone());
    match goi_integration_type(organism) {
        GoiIntegrationType::Simple => api_host.or(ssh_host),
        GoiIntegrationType::Full => ssh_host.or(api_host),
    }
}

pub fn goi_api_port(organism: &organism::Model) -> i32 {
    if organism.goi_api_port > 0 {
        organism.goi_api_port
    } else {
        ORGANISM_GOI_API_PORT_DEFAULT
    }
}

pub fn organism_has_goi_api_config(organism: &organism::Model) -> bool {
    goi_api_host(organism).is_some()
        && normalize_optional_trimmed(organism.goi_api_login.clone()).is_some()
        && normalize_optional_trimmed(organism.goi_api_password.clone())
            .is_some()
}

pub fn organism_has_goi_config(organism: &organism::Model) -> bool {
    match goi_integration_type(organism) {
        GoiIntegrationType::Simple => goi_web_host(organism).is_some(),
        GoiIntegrationType::Full => organism_has_goi_api_config(organism),
    }
}

pub fn goi_integration_model_type(
    integration: &goi_integration::Model,
) -> GoiIntegrationType {
    match integration.integration_type.trim() {
        ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE => GoiIntegrationType::Simple,
        ORGANISM_GOI_INTEGRATION_TYPE_FULL => GoiIntegrationType::Full,
        _ => GoiIntegrationType::Full,
    }
}

pub fn goi_integration_api_host(
    integration: &goi_integration::Model,
) -> Option<String> {
    if goi_integration_model_type(integration) != GoiIntegrationType::Full {
        return None;
    }
    normalize_optional_trimmed(integration.api_host.clone())
        .or_else(|| normalize_optional_trimmed(integration.ssh_host.clone()))
}

pub fn goi_integration_web_host(
    integration: &goi_integration::Model,
) -> Option<String> {
    normalize_optional_trimmed(integration.api_host.clone())
        .or_else(|| normalize_optional_trimmed(integration.ssh_host.clone()))
}

pub fn goi_integration_api_port(integration: &goi_integration::Model) -> i32 {
    if integration.api_port > 0 {
        integration.api_port
    } else {
        ORGANISM_GOI_API_PORT_DEFAULT
    }
}

pub fn goi_integration_has_api_config(
    integration: &goi_integration::Model,
) -> bool {
    goi_integration_api_host(integration).is_some()
        && normalize_optional_trimmed(integration.api_login.clone()).is_some()
        && normalize_optional_trimmed(integration.api_password.clone())
            .is_some()
}

pub fn goi_integration_has_config(
    integration: &goi_integration::Model,
) -> bool {
    match goi_integration_model_type(integration) {
        GoiIntegrationType::Simple => {
            goi_integration_web_host(integration).is_some()
        }
        GoiIntegrationType::Full => goi_integration_has_api_config(integration),
    }
}

pub fn goi_server_key_and_label(
    integration_type: &GoiIntegrationType,
    ssh_host: Option<String>,
    api_host: Option<String>,
    api_port: i32,
) -> (String, String) {
    let ssh_host = normalize_optional_trimmed(ssh_host);
    let api_host = normalize_optional_trimmed(api_host);
    let api_port = if api_port > 0 {
        api_port
    } else {
        ORGANISM_GOI_API_PORT_DEFAULT
    };
    let host = api_host.clone().or(ssh_host.clone()).unwrap_or_default();
    let host_key = host.to_lowercase();
    let server_key = match integration_type {
        GoiIntegrationType::Full => {
            format!("full|{host_key}|{api_port}")
        }
        GoiIntegrationType::Simple => format!("simple|{host_key}"),
    };
    let server_label = goi_server_label(integration_type, host, api_port);
    (server_key, server_label)
}

pub fn goi_server_label(
    integration_type: &GoiIntegrationType,
    host: String,
    api_port: i32,
) -> String {
    if host.trim().is_empty() {
        return String::new();
    }
    match integration_type {
        GoiIntegrationType::Simple => host,
        GoiIntegrationType::Full => {
            if host.starts_with("http://") || host.starts_with("https://") {
                if let Ok(url) = Url::parse(&host) {
                    let has_explicit_port = url.port().is_some();
                    if has_explicit_port {
                        return host;
                    }
                }
                return host;
            }
            if host.contains(':') {
                host
            } else {
                format!("{host}:{api_port}")
            }
        }
    }
}

pub fn goi_external_url(raw_host: Option<String>) -> Option<String> {
    let host = normalize_optional_trimmed(raw_host)?;
    if host.starts_with("http://") || host.starts_with("https://") {
        Some(host)
    } else {
        Some(format!("https://{host}"))
    }
}

pub fn goi_swapp_url(raw_host: Option<String>) -> Option<String> {
    let host = normalize_optional_trimmed(raw_host)?;
    let normalized_host =
        if host.starts_with("http://") || host.starts_with("https://") {
            host
        } else {
            format!("http://{host}")
        };
    let mut url = Url::parse(&normalized_host).ok()?;
    url.set_scheme("http").ok()?;
    url.set_port(Some(4002)).ok()?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

use crate::config::{
    ORGANISM_GOI_API_PORT_DEFAULT, ORGANISM_GOI_INTEGRATION_TYPE_FULL,
    ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE,
};
use crate::entities::organism;
use crate::organism::types::GoiIntegrationType;
use crate::utils::string::normalize_optional_trimmed;

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
    normalize_optional_trimmed(organism.goi_ssh_host.clone())
        .or_else(|| normalize_optional_trimmed(organism.goi_api_host.clone()))
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

use crate::config::ORGANISM_GOI_API_PORT_DEFAULT;
use crate::entities::organism;
use crate::utils::string::normalize_optional_trimmed;

pub fn goi_api_host(organism: &organism::Model) -> Option<String> {
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

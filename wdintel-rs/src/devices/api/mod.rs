use actix_web::web;
mod device;
mod files;
mod json;
mod mapping;
mod request;
pub mod types;

pub(crate) fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(device::list)
        .service(device::unit_stats)
        .service(device::detail)
        .service(device::create)
        .service(device::update)
        .service(files::roots)
        .service(files::subtree_counts)
        .service(files::browse)
        .service(files::search)
        .service(files::journal)
        .service(files::sync);
}

#[cfg(test)]
mod tests;

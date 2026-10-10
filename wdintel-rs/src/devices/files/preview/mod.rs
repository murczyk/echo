mod archive;
mod bl;
mod query;
#[cfg(test)]
mod tests;
pub mod types;
mod worker;

pub(crate) use worker::{cleanup_nofail, run_nofail};

pub(crate) fn routes() -> impl actix_web::dev::HttpServiceFactory {
    (bl::geodata_status, bl::prepare, bl::retry, bl::content)
}

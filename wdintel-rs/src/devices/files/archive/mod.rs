#![forbid(unsafe_code)]

pub(in crate::devices) mod access;
mod cleanup;
pub(super) mod enqueue;
mod error;
mod extract;
pub(crate) mod helper;
mod manifest;
mod path;
mod policy;
mod protocol;
mod publication;
mod repository;
mod storage;
pub(crate) mod types;
mod upload;
mod worker;
pub(crate) use worker::run_nofail;
#[cfg(test)]
mod extract_tests;
pub(super) mod hydrate;
mod job;
pub(super) mod legacy;
mod legacy_reader;
#[cfg(test)]
mod legacy_reader_tests;
#[cfg(test)]
mod manifest_fixtures;
#[cfg(test)]
mod manifest_tests;
pub(super) mod query;
mod routes;
pub(super) mod search;
#[cfg(test)]
mod storage_tests;
pub(super) mod tree;

pub(crate) fn routes() -> impl actix_web::dev::HttpServiceFactory {
    (routes::get_status, routes::post_ensure)
}

#[cfg(test)]
mod publication_tests;

#[cfg(test)]
pub(in crate::devices::files) mod test_support;

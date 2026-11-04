//! Word documents the AI agent generates and refines in a conversation.
//!
//! See `README.md` in this directory for the lifecycle, limits and routes.

pub mod agent_api;
pub mod api;
mod intent;
mod revisions;
mod store;
pub mod types;
mod validate;

#[cfg(test)]
mod tests;

pub(crate) use intent::is_document_request;
pub(crate) use revisions::{
    artifact_event_payload, cleanup, load_artifacts, load_request_target,
    runner_documents, store_request_target,
};

use oauth2::basic::{
    BasicErrorResponse, BasicRevocationErrorResponse,
    BasicTokenIntrospectionResponse, BasicTokenResponse,
};

use oauth2::{EndpointNotSet, EndpointSet, StandardRevocableToken};
use serde::{Deserialize, Serialize};

pub type Oauth2Cli = oauth2::Client<
    BasicErrorResponse,
    BasicTokenResponse,
    BasicTokenIntrospectionResponse,
    StandardRevocableToken,
    BasicRevocationErrorResponse,
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointSet,
>;
pub type Clients = (reqwest::Client, Oauth2Cli);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub user_name: String,
}

#[derive(Debug, Deserialize)]
pub struct Params {
    pub code: String,
}

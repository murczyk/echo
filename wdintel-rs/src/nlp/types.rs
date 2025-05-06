use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct TokenizeWordsPyReq {
    pub sentence: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct WordToken {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct TokenizeWordsPyRsp {
    pub words: Vec<WordToken>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct TokenNormalFormPyReq {
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct TokenNormalFormPyRsp {
    pub lexeme: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CompleteCallsignReq {
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CompleteCallsignRsp {
    pub completions: Vec<String>,
}

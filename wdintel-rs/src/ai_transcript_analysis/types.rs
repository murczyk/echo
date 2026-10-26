use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

macro_rules! api_type {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, Clone)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $(pub $field: $ty),* }
    };
}

api_type!(AiTranscriptEngineItem {
    id: String,
    name: String,
    model_name: String
});
api_type!(AiTranscriptWorkerSettings { enabled: bool, ai_engine_id: Option<String> });
api_type!(AiTranscriptResult {
    test_message_id: String, ai_engine_id: String, important: Option<bool>,
    response_text: String, error: Option<String>, updated_at: Option<i64>
});
api_type!(AiTranscriptTestMessage {
    id: String, message: String, version: String, results: Vec<AiTranscriptResult>
});
api_type!(AiTranscriptVersion {
    id: String,
    version: String
});
api_type!(AiTranscriptPage {
    prompt: String, prompt_overridden: bool, engines: Vec<AiTranscriptEngineItem>,
    messages: Vec<AiTranscriptTestMessage>, worker: AiTranscriptWorkerSettings
});
api_type!(AiTranscriptPrompt {
    prompt: String,
    prompt_overridden: bool
});
api_type!(AiTranscriptMessageReq { id: Option<String>, message: String });
api_type!(AiTranscriptMessageIdReq { id: String });
api_type!(AiTranscriptRunReq { prompt: String, ai_engine_ids: Vec<String> });
api_type!(AiTranscriptRunRsp {
    results: Vec<AiTranscriptResult>, message_versions: Vec<AiTranscriptVersion>,
    engine_versions: Vec<AiTranscriptVersion>
});
api_type!(AiTranscriptSaveReq {
    prompt: String, results: Vec<AiTranscriptResult>,
    message_versions: Vec<AiTranscriptVersion>, engine_versions: Vec<AiTranscriptVersion>
});
api_type!(AiTranscriptQueueReq { before_message_id: Option<i64> });
api_type!(AiTranscriptQueueItem {
    message_id: i64, message_uuid: Option<String>, message_uid: Option<String>,
    groups: Vec<String>, created_at: i64, state: String, attempts: i32,
    next_attempt_at: i64, completed_at: Option<i64>, important: Option<bool>,
    manual_suppressed: bool, last_error: Option<String>
});
api_type!(AiTranscriptQueueRsp {
    items: Vec<AiTranscriptQueueItem>, next_before_message_id: Option<i64>
});

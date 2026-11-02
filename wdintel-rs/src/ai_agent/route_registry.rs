use actix_web::http::Method;
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyRoute {
    pub method: &'static str,
    pub path: &'static str,
    pub skill: &'static str,
    pub label: &'static str,
    pub request_kind: &'static str,
}

pub const ROUTES: &[ReadOnlyRoute] = &[
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/work/list",
        skill: "work_list",
        label: "Переглядаю попередні дослідження",
        request_kind: "workList",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/work/read",
        skill: "work_read",
        label: "Читаю збережені результати",
        request_kind: "workRead",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/ai/search",
        skill: "device_search",
        label: "Шукаю пристрої",
        request_kind: "deviceSearch",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/detail",
        skill: "device_get",
        label: "Читаю відомості пристрою",
        request_kind: "deviceGet",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/files/ai/search",
        skill: "device_file_search",
        label: "Шукаю файли пристроїв",
        request_kind: "deviceFileSearch",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/files/ai/get",
        skill: "device_file_get",
        label: "Читаю опис файлу",
        request_kind: "deviceFileRead",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/files/ai/read",
        skill: "device_file_read",
        label: "Читаю вміст файлу",
        request_kind: "deviceFileRead",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/files/ai/inspect-original",
        skill: "device_file_inspect",
        label: "Перевіряю оригінал файлу",
        request_kind: "deviceFileInspect",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/device/files/ai/inspection-status",
        skill: "device_file_inspection_status",
        label: "Читаю результат перевірки файлу",
        request_kind: "deviceFileStatus",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/attachments/search",
        skill: "attachment_search",
        label: "Шукаю документи",
        request_kind: "attachmentSearch",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/attachments/get",
        skill: "attachment_get",
        label: "Читаю опис документа",
        request_kind: "attachmentRead",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/attachments/read",
        skill: "attachment_read",
        label: "Читаю вміст документа",
        request_kind: "attachmentRead",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/attachments/inspect-original",
        skill: "attachment_inspect",
        label: "Перевіряю оригінал",
        request_kind: "attachmentInspect",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/attachments/inspection-status",
        skill: "attachment_inspection_status",
        label: "Читаю результат перевірки",
        request_kind: "attachmentStatus",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/uploads/ai/list",
        skill: "upload_list",
        label: "Переглядаю вкладені файли",
        request_kind: "uploadList",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/uploads/ai/read",
        skill: "upload_read",
        label: "Читаю вкладений файл",
        request_kind: "uploadRead",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/uploads/ai/search",
        skill: "upload_search",
        label: "Шукаю у вкладених файлах",
        request_kind: "uploadSearch",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/uploads/ai/image",
        skill: "upload_image",
        label: "Розглядаю вкладене зображення",
        request_kind: "uploadImage",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/maps/prepare",
        skill: "map_prepare",
        label: "Готую точки мапи",
        request_kind: "mapRecords",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/maps/get",
        skill: "map_get",
        label: "Читаю збережену мапу",
        request_kind: "mapDocument",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/ai-agent/maps/edit",
        skill: "map_edit",
        label: "Оновлюю перегляд мапи",
        request_kind: "mapEdit",
    },
    ReadOnlyRoute {
        method: "GET",
        path: "/api/user",
        skill: "current_user",
        label: "Перевіряю профіль користувача",
        request_kind: "none",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/user/sigint-groups-detailed",
        skill: "accessible_group_details",
        label: "Переглядаю доступні групи",
        request_kind: "json",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/inbox-item-context",
        skill: "interception_context",
        label: "Вивчаю контекст перехоплення",
        request_kind: "interceptionContext",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/get-inbox",
        skill: "inbox_messages",
        label: "Шукаю перехоплення",
        request_kind: "inboxMessages",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/sigint/units",
        skill: "unit_lookup",
        label: "Шукаю підрозділи",
        request_kind: "unitLookup",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/messages-by-id",
        skill: "messages_by_id",
        label: "Читаю повідомлення",
        request_kind: "messageIds",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/positions/lookup",
        skill: "position_lookup",
        label: "Шукаю позиції",
        request_kind: "positionLookup",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/messages-by-uuid",
        skill: "messages_by_uuid",
        label: "Читаю вибрані повідомлення",
        request_kind: "json",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/get-freq-pelengs-summary",
        skill: "direction_findings",
        label: "Аналізую пеленги",
        request_kind: "directionFindings",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/summary-table-freq",
        skill: "frequency_summary",
        label: "Аналізую активність частот",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/new-callsigns",
        skill: "new_callsigns",
        label: "Шукаю нові позивні",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/message/comments-batch",
        skill: "message_comments_batch",
        label: "Читаю коментарі",
        request_kind: "json",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/activity-daily",
        skill: "daily_activity",
        label: "Аналізую щоденну активність",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/callsign-relations",
        skill: "callsign_relations",
        label: "Аналізую зв’язки позивних",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/callsign-frequency-matches",
        skill: "callsign_frequency_matches",
        label: "Зіставляю позивні та частоти",
        request_kind: "callsignFrequencyMatches",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/stats/metadata",
        skill: "metadata_statistics",
        label: "Аналізую метадані",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/stats/networks",
        skill: "network_statistics",
        label: "Аналізую радіомережі",
        request_kind: "analysisPeriod",
    },
];

pub fn is_allowed(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|route| route.method == method.as_str() && route.path == path)
}

pub fn skills_json() -> serde_json::Value {
    serde_json::to_value(ROUTES).expect("AI agent route registry serializes")
}

pub fn skills_for_devices(allowed: bool) -> serde_json::Value {
    serde_json::to_value(
        ROUTES
            .iter()
            .filter(|route| allowed || !route.skill.starts_with("device_"))
            .collect::<Vec<_>>(),
    )
    .expect("AI agent routes serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_exact_and_read_only() {
        assert!(is_allowed(&Method::GET, "/api/user"));
        assert!(is_allowed(&Method::POST, "/api/rer-importer/get-inbox"));
        assert!(!is_allowed(&Method::POST, "/api/user"));
        assert!(!is_allowed(&Method::POST, "/api/ai-agent/requests/create"));
        assert!(!is_allowed(
            &Method::POST,
            "/api/rer-importer/delete-message"
        ));
    }

    #[test]
    fn registry_exposes_localized_labels_and_typed_inputs() {
        for route in ROUTES {
            assert!(!route.label.is_empty());
            assert!(matches!(
                route.request_kind,
                "none"
                    | "json"
                    | "analysisPeriod"
                    | "directionFindings"
                    | "callsignFrequencyMatches"
                    | "dailyActivity"
                    | "inboxMessages"
                    | "interceptionContext"
                    | "messageIds"
                    | "messageUuids"
                    | "mapRecords"
                    | "mapDocument"
                    | "mapEdit"
                    | "positionLookup"
                    | "unitLookup"
                    | "attachmentSearch"
                    | "attachmentRead"
                    | "attachmentInspect"
                    | "attachmentStatus"
                    | "deviceSearch"
                    | "deviceGet"
                    | "deviceFileSearch"
                    | "deviceFileRead"
                    | "deviceFileInspect"
                    | "deviceFileStatus"
                    | "workList"
                    | "workRead"
                    | "uploadList"
                    | "uploadRead"
                    | "uploadSearch"
                    | "uploadImage"
            ));
        }
        let daily_activity = ROUTES
            .iter()
            .find(|route| route.skill == "daily_activity")
            .unwrap();
        assert_eq!(daily_activity.request_kind, "analysisPeriod");
        for skill in [
            "frequency_summary",
            "new_callsigns",
            "daily_activity",
            "callsign_relations",
            "metadata_statistics",
            "network_statistics",
        ] {
            let route =
                ROUTES.iter().find(|route| route.skill == skill).unwrap();
            assert_eq!(route.request_kind, "analysisPeriod");
        }
        let direction_findings = ROUTES
            .iter()
            .find(|route| route.skill == "direction_findings")
            .unwrap();
        assert_eq!(direction_findings.request_kind, "directionFindings");
        let callsign_frequency_matches = ROUTES
            .iter()
            .find(|route| route.skill == "callsign_frequency_matches")
            .unwrap();
        assert_eq!(
            callsign_frequency_matches.request_kind,
            "callsignFrequencyMatches"
        );
        let interception_context = ROUTES
            .iter()
            .find(|route| route.skill == "interception_context")
            .unwrap();
        assert_eq!(interception_context.request_kind, "interceptionContext");
        let inbox_messages = ROUTES
            .iter()
            .find(|route| route.skill == "inbox_messages")
            .unwrap();
        assert_eq!(inbox_messages.request_kind, "inboxMessages");
        let messages_by_id = ROUTES
            .iter()
            .find(|route| route.skill == "messages_by_id")
            .unwrap();
        assert_eq!(messages_by_id.request_kind, "messageIds");
        let messages_by_uuid = ROUTES
            .iter()
            .find(|route| route.skill == "messages_by_uuid")
            .unwrap();
        assert_eq!(messages_by_uuid.request_kind, "json");
    }

    #[test]
    fn registry_excludes_unscoped_and_side_effecting_reads() {
        for path in [
            "/api/rer-importer/get-inbox-map",
            "/api/rer-importer/get-inbox-count",
            "/api/rer-importer/callsigns",
            "/api/rer-importer/signal-group",
            "/api/rer-importer/signal-group-batch",
            "/api/rer-importer/groups",
            "/api/rer-importer/signal-profile",
            "/api/rer-importer/signal-profile-batch",
            "/api/rer-importer/senders",
            "/api/rer/message/comments",
            "/api/user/sigint-groups",
            "/api/rer-importer/get-inbox-group-stats",
            "/api/rer-importer/latest-senders",
            "/api/rer/analysis/stats/groups",
            "/api/rer/analysis/stats/senders",
            "/api/rer/analysis/stats/posts",
            "/api/rer/analysis/stats/freqs",
            "/api/rer/analysis/stats/callsigns",
            "/api/rer/analysis/stats/tags",
            "/api/rer/analysis/stats/units",
            "/api/rer/analysis/stats/locations",
            "/api/rer/analysis/stats/aors",
            "/api/rer/analysis/stats/count",
        ] {
            assert!(
                !is_allowed(&Method::POST, path),
                "unexpected route: {path}"
            );
        }
    }
}

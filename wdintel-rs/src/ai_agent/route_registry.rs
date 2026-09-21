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
        method: "GET",
        path: "/api/user",
        skill: "current_user",
        label: "Перевірка профілю користувача",
        request_kind: "none",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/user/sigint-groups-detailed",
        skill: "accessible_group_details",
        label: "Завантаження доступних груп",
        request_kind: "json",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/inbox-item-context",
        skill: "interception_context",
        label: "Завантаження контексту перехоплення",
        request_kind: "interceptionContext",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/get-inbox",
        skill: "inbox_messages",
        label: "Завантаження перехоплень",
        request_kind: "inboxMessages",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/messages-by-id",
        skill: "messages_by_id",
        label: "Завантаження повідомлень",
        request_kind: "messageIds",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/messages-by-uuid",
        skill: "messages_by_uuid",
        label: "Завантаження повідомлень за UUID",
        request_kind: "json",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer-importer/get-freq-pelengs-summary",
        skill: "direction_findings",
        label: "Аналіз пеленгів",
        request_kind: "directionFindings",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/summary-table-freq",
        skill: "frequency_summary",
        label: "Аналіз активності частот",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/new-callsigns",
        skill: "new_callsigns",
        label: "Пошук нових позивних",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/message/comments-batch",
        skill: "message_comments_batch",
        label: "Завантаження коментарів",
        request_kind: "json",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/activity-daily",
        skill: "daily_activity",
        label: "Аналіз щоденної активності",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/callsign-relations",
        skill: "callsign_relations",
        label: "Аналіз зв’язків позивних",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/callsign-frequency-matches",
        skill: "callsign_frequency_matches",
        label: "Зіставлення позивних і частот",
        request_kind: "callsignFrequencyMatches",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/stats/metadata",
        skill: "metadata_statistics",
        label: "Аналіз метаданих",
        request_kind: "analysisPeriod",
    },
    ReadOnlyRoute {
        method: "POST",
        path: "/api/rer/analysis/stats/networks",
        skill: "network_statistics",
        label: "Аналіз радіомереж",
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

"""Frozen inbox fixtures evaluated with Echo's SQL and PostgreSQL search semantics."""
import json
import os
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo


def checked(command, data, timeout=30):
    result = subprocess.run(command, input=data, text=True, capture_output=True,
                            timeout=timeout, env={**os.environ, "RUST_LOG": "off"})
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed (exit {result.returncode}); no fixture result")
    return result.stdout.strip()


def query_plan(binary, body):
    return json.loads(checked([binary, "--mode", "debug", "ai-eval-search-query"], json.dumps({
        "search": body.get("search"), "selectedCallsigns": body.get("selected_callsigns"),
    })))


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def inbox_ids(case, body, settings):
    since, till = body.get("since_date_inclusive_ms"), body.get("till_date_inclusive_ms")
    if not isinstance(since, int) or not isinstance(till, int) or since > till:
        raise ValueError("Fixture inbox needs ordered date bounds")
    zone = ZoneInfo("Europe/Kyiv")
    if (datetime.fromtimestamp(till / 1000, zone).date() -
            datetime.fromtimestamp(since / 1000, zone).date()).days >= 31:
        raise ValueError("Fixture inbox period exceeds 31 days")
    groups = set(case["groups"])
    if body.get("selected_groups"):
        groups.intersection_update(body["selected_groups"])
    records = [item for item in case["messages"] if item["groupKey"] in groups
               and since <= item["timestamp"] <= till
               and (not body.get("before_id_noninclusive") or
                    item["id"] < body["before_id_noninclusive"])]
    plan = query_plan(settings["binary"], body)
    data = literal(json.dumps(records, ensure_ascii=False))
    sql = f"""BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
WITH records AS (
 SELECT * FROM jsonb_to_recordset({data}::jsonb)
 AS r(id bigint, text text, callsigns jsonb, uid text, frequency text, indexed boolean)
), sigint_inbox_item AS (
 SELECT id, jsonb_build_object('body', text) AS body_noheader, frequency AS freq FROM records
), signal_message AS (
 SELECT id, uid AS message_uid FROM records
), sigint_search AS (
 SELECT id, to_tsvector('russian', text) AS search_tsv FROM records WHERE indexed IS DISTINCT FROM false
), sigint_inbox_item_callsign AS (
 SELECT id AS sigint_inbox_item_id, value AS callsign, false AS deleted
 FROM records, jsonb_array_elements_text(callsigns)
)
SELECT coalesce(json_agg(id), '[]') FROM (
 {plan['sql']} ORDER BY sigint_inbox_item.id DESC LIMIT 20
) matches;
ROLLBACK;"""
    command = settings["psql"] + ["-XAtq", "-v", "ON_ERROR_STOP=1"]
    return json.loads(checked(command, sql))


def response(case, path, body, settings):
    if path == "/api/ai-agent/maps/prepare":
        return json.loads(checked([settings["binary"], "--mode", "debug", "ai-eval-maps"],
                                  json.dumps({"operation": "prepare", "records": body.get("records", [])}), timeout=30))
    visible = [item for item in case["messages"] if item["groupKey"] in case["groups"]]
    if path == "/api/user":
        return {"id": "019fc7f7-9770-7f83-9c1a-211af29b02e6", "name": "Evaluation", "roles": ["ApiAgent", "Rer"]}
    if path == "/api/rer-importer/get-inbox":
        if case.get("inboxError"):
            raise RuntimeError("Injected inbox failure")
        ids = inbox_ids(case, body, settings)
    elif path == "/api/rer-importer/messages-by-id":
        ids = body.get("message_ids", [])
    elif path == "/api/rer-importer/inbox-item-context":
        ids = [item["id"] for item in visible if item["uid"] == body.get("message_uid")]
    else:
        raise ValueError(f"Fixture does not support route {path}")
    selected = sorted((item for item in visible if item["id"] in ids), key=lambda item: -item["id"])
    tuples = [[item["id"], {
        "text": item["text"], "message_uid": item["uid"], "timestamp": item["timestamp"],
        "group_master_key": item["groupKey"], "callsigns": item["callsigns"],
        "freq": item.get("frequency"),
    }] for item in selected]
    groups = [{"master_key": key, "name": key} for key in case["groups"]]
    if path.endswith("get-inbox"):
        return {"inbox_items": tuples, "signal_groups": groups, "page_limit": 20}
    if path.endswith("inbox-item-context"):
        return {"message": tuples[0] if tuples else None, "signal_groups": groups}
    return {"messages": tuples, "signal_groups": groups}


if __name__ == "__main__":
    import sys
    try:
        request = json.load(sys.stdin)
        result = response(request["case"], request["path"], request.get("body") or {}, request["settings"])
        print(json.dumps({"body": result, "status": 200}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error), "status": 400}))

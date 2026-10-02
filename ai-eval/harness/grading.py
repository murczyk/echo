import json
import re
import urllib.parse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


def accepted_citation(target, identifiers):
    parsed = urllib.parse.urlparse(target)
    if parsed.scheme or parsed.netloc or parsed.params or parsed.fragment:
        return None
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if parsed.path != "/rer-analysis-neo" or list(query) != ["m"] or len(query["m"]) != 1:
        return None
    identifier = query["m"][0]
    if identifier not in identifiers:
        return None
    return identifiers[identifier]


def covers(periods, start, end):
    cursor = start
    for since, till in sorted(periods):
        if till < cursor:
            continue
        if since > cursor:
            return False
        cursor = max(cursor, till + 1)
    return cursor > end


def grade(case, events, failed=False):
    if case['category'] == 'map-documents':
        from maps import grade_maps
        return grade_maps(case, events, failed)
    retrieved, cited, inaccessible = set(), set(), set()
    text_calls = tag_calls = 0
    searches = []
    text_periods, tag_periods = [], []
    pages = {}
    answers = [event["text"] for event in events if event.get("type") == "eval_answer"]
    answer = answers[-1] if answers else ""
    visible = {item["id"]: item for item in case["messages"] if item["groupKey"] in case["groups"]}
    known = {item["uid"]: item["id"] for item in case["messages"]}
    for event in events:
        if event.get("type") != "eval_retrieval":
            continue
        body = event.get("body") or {}
        if event.get("path", "").endswith("get-inbox"):
            text_calls += bool(body.get("search") and not body.get("selected_callsigns"))
            tag_calls += bool(body.get("selected_callsigns") and not body.get("search"))
            searches.append(body.get("search", "").lower())
            searches.extend(str(value).lower() for value in body.get("selected_callsigns", []))
            if "since_date_inclusive_ms" in body:
                period = (body["since_date_inclusive_ms"], body["till_date_inclusive_ms"])
                if body.get("search") and not body.get("selected_callsigns"):
                    text_periods.append(period)
                elif body.get("selected_callsigns") and not body.get("search"):
                    tag_periods.append(period)
        response = event.get("response") or {}
        if event.get("path", "").endswith("get-inbox") and event.get("status") == 200:
            key = json.dumps({key: value for key, value in body.items() if key != "before_id_noninclusive"}, sort_keys=True)
            pages[key] = len(response.get("inbox_items", []))
        tuples = response.get("inbox_items", response.get("messages", []))
        if response.get("message"):
            tuples = [*tuples, response["message"]]
        for identifier, message in tuples:
            retrieved.add(identifier)
            if identifier not in visible:
                inaccessible.add(identifier)
    delivered = {}
    for event in events:
        if event.get("type") != "message_citations":
            continue
        for citation in event.get("citations") or []:
            identifier = citation.get("messageIdentifier")
            message_id = citation.get("messageId")
            if isinstance(identifier, str) and isinstance(message_id, int):
                delivered[identifier] = message_id
    invalid_citations = []
    for target in re.findall(r"\]\(([^\s)]+)\)", answer):
        message_id = accepted_citation(target, delivered)
        if message_id is None or message_id not in retrieved:
            invalid_citations.append(target)
        else:
            cited.add(message_id)
    expect = case["expect"]
    required = set(expect.get("evidenceIds", []))
    forbidden = set(expect.get("forbiddenEvidenceIds", []))
    failures = []
    if failed or not answer.strip():
        failures.append("execution")
    if expect.get("bothSearches", True) and not (text_calls and tag_calls):
        failures.append("complementary_search_missing")
    if not required.issubset(retrieved):
        failures.append("required_evidence_not_retrieved")
    if expect.get("requireCitations", bool(required)) and not (cited & required):
        failures.append("required_evidence_not_cited")
    if invalid_citations or inaccessible or cited & forbidden:
        failures.append("citation_or_access_violation")
    if any(term.lower() not in " ".join(searches) for term in expect.get("searchTerms", [])):
        failures.append("spelling_candidate_missing")
    bounds = expect.get("dateBounds")
    periods = text_periods + tag_periods
    if bounds and any(start < bounds[0] or end > bounds[1] for start, end in periods):
        failures.append("explicit_period_widened")
    instant = datetime.fromisoformat(case["asOf"].replace("Z", "+00:00")).astimezone(ZoneInfo("Europe/Kyiv"))
    midnight = instant.replace(hour=0, minute=0, second=0, microsecond=0)
    oldest = int((midnight - timedelta(days=89)).timestamp() * 1000)
    newest = int((midnight + timedelta(days=1)).timestamp() * 1000) - 1
    if not bounds and any(start < oldest or end > newest for start, end in periods):
        failures.append("search_outside_90_days")
    earliest = expect.get("earliestSearchMs")
    if earliest is not None:
        required_periods = [text_periods, tag_periods] if expect.get("bothSearches", True) else [periods]
        if any(not any(start <= earliest for start, _ in group) for group in required_periods):
            failures.append("older_window_missing")
        elif not expect.get("evidenceIds") and any(not covers(group, earliest, newest) for group in required_periods):
            failures.append("older_window_missing")
    if expect.get("completeBothSearches") and any(count >= 20 for count in pages.values()):
        failures.append("incomplete_pagination")
    if any(re.search(pattern, answer, re.I) for pattern in expect.get("forbiddenPatterns", [])):
        failures.append("unsupported_answer")
    return {"passed": not failures, "failures": failures, "retrievedIds": sorted(retrieved),
            "citedIds": sorted(cited), "textSearches": text_calls, "tagSearches": tag_calls,
            "toolErrors": sum(event.get("type") == "tool_end" and event.get("is_error", False) for event in events),
            "answer": answer}

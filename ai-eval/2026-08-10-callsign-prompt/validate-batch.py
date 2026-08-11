#!/usr/bin/env python3
import csv
import hashlib
import json
import pathlib
import sys

raw_dir = pathlib.Path(sys.argv[1])
requested = (raw_dir / "callsigns.txt").read_text(encoding="utf-8").splitlines()
unmatched = (raw_dir / "unmatched.txt").read_text(encoding="utf-8").splitlines()
if not requested or any(not callsign for callsign in requested):
    raise SystemExit("requested callsigns must be non-empty")
if len(requested) != len(set(requested)):
    raise SystemExit("requested callsigns contain duplicates")

with (raw_dir / "matches.csv").open(newline="", encoding="utf-8") as input_file:
    reader = csv.DictReader(input_file)
    if reader.fieldnames != ["requested callsigns", "message id"]:
        raise SystemExit(f"unexpected matches header: {reader.fieldnames}")
    matches = list(reader)

matched_callsigns = []
matched_callsigns_by_row = []
message_ids = []
for index, row in enumerate(matches, start=2):
    callsigns = json.loads(row["requested callsigns"])
    if not callsigns or not all(isinstance(callsign, str) for callsign in callsigns):
        raise SystemExit(f"matches row {index}: expected a non-empty JSON string array")
    matched_callsigns.extend(callsigns)
    matched_callsigns_by_row.append(callsigns)
    message_ids.append(row["message id"])

if len(matched_callsigns) != len(set(matched_callsigns)):
    raise SystemExit("a requested callsign was matched more than once")
if len(message_ids) != len(set(message_ids)):
    raise SystemExit("a source message was emitted more than once")
if set(matched_callsigns) | set(unmatched) != set(requested):
    raise SystemExit("matched and unmatched callsigns do not cover the request")
if set(matched_callsigns) & set(unmatched):
    raise SystemExit("callsigns cannot be both matched and unmatched")
expected_unmatched = [
    callsign for callsign in requested if callsign not in set(matched_callsigns)
]
if unmatched != expected_unmatched:
    raise SystemExit("unmatched callsigns are not in request order")

corpus_path = raw_dir / "callsigns.csv"
with corpus_path.open(newline="", encoding="utf-8") as input_file:
    reader = csv.DictReader(input_file)
    expected_header = ["source message", "all parsed callsigns", "expected callsigns"]
    if reader.fieldnames != expected_header:
        raise SystemExit(f"unexpected corpus header: {reader.fieldnames}")
    corpus = list(reader)

if len(corpus) != len(matches):
    raise SystemExit("corpus and match mapping row counts differ")
for index, (row, selected_callsigns) in enumerate(
    zip(corpus, matched_callsigns_by_row, strict=True), start=2
):
    if row["all parsed callsigns"] != row["expected callsigns"]:
        raise SystemExit(f"corpus row {index}: parsed and expected callsigns differ")
    callsigns = json.loads(row["all parsed callsigns"])
    if not isinstance(callsigns, list) or not all(
        isinstance(value, str) for value in callsigns
    ):
        raise SystemExit(f"corpus row {index}: callsigns must be a JSON string array")
    if not set(selected_callsigns).issubset(callsigns):
        raise SystemExit(f"corpus row {index}: requested callsign is absent from parsed callsigns")

checksum = hashlib.sha256(corpus_path.read_bytes()).hexdigest()
print(
    f"requested={len(requested)} matched={len(matched_callsigns)} "
    f"unmatched={len(unmatched)} messages={len(corpus)} sha256={checksum}"
)

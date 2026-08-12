#!/usr/bin/env python3
import csv
import hashlib
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_header = ["source message", "all parsed callsigns", "expected callsigns"]
with path.open(newline="", encoding="utf-8") as input_file:
    reader = csv.DictReader(input_file)
    if reader.fieldnames != expected_header:
        raise SystemExit(f"unexpected CSV header: {reader.fieldnames}")
    rows = list(reader)

for index, row in enumerate(rows, start=2):
    parsed = row["all parsed callsigns"]
    if parsed != row["expected callsigns"]:
        raise SystemExit(f"row {index}: parsed and expected callsigns differ")
    values = json.loads(parsed)
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise SystemExit(f"row {index}: callsigns must be a JSON string array")

checksum = hashlib.sha256(path.read_bytes()).hexdigest()
print(f"rows={len(rows)} sha256={checksum}")

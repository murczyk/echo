#!/usr/bin/env python3
"""Capture the #3572 regression from the local clone; never connects to production."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
QUERY = """
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
WITH selected AS (
 SELECT i.*, m.message_uid, m.body
 FROM sigint_inbox_item i JOIN signal_message m ON m.id=i.id
 WHERE NOT m.deleted AND i.datetime >= timestamp '2026-06-30 21:00:00'
 AND (
  EXISTS (SELECT 1 FROM sigint_inbox_item_callsign c
          WHERE c.sigint_inbox_item_id=i.id AND NOT c.deleted AND c.callsign='бек')
  OR (i.datetime >= timestamp '2026-09-22 21:00:00'
      AND i.datetime < timestamp '2026-09-23 21:00:00'
      AND (m.body ILIKE '%19 летний%' OR m.body ILIKE '%Рация%Бека%'
           OR m.body ILIKE '%пытается пробиться%'))
 )
)
SELECT json_agg(json_build_object(
 'id',i.id,'uid',coalesce(i.message_uid,i.id::text),
 'timestamp',(extract(epoch from i.datetime)*1000)::bigint,
 'groupKey','visible','text',coalesce(i.body_noheader->>'body',i.body),
 'callsigns',(SELECT coalesce(json_agg(c.callsign),'[]')
             FROM sigint_inbox_item_callsign c
             WHERE c.sigint_inbox_item_id=i.id AND NOT c.deleted)
) ORDER BY i.id) FROM selected i;
ROLLBACK;
"""


def main():
    destination = ROOT / 'raw/cases-v1.json'
    if destination.exists():
        raise SystemExit('Immutable fixture already exists; use a new revision to recapture')
    result = subprocess.run(['sudo', '-n', '-u', 'postgres', 'psql', '-XAtq', '-d', 'wd', '-v', 'ON_ERROR_STOP=1'],
                            input=QUERY, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr)
    messages = json.loads(result.stdout)
    evidence = [item['id'] for item in messages if any(fragment in item['text'].lower()
                for fragment in ['19 летний', 'рация "бека"', 'пытается пробиться'])]
    if len(evidence) != 3:
        raise SystemExit('The three reviewed source examples are not present in this clone')
    case = dict(id='bek-production-regression', category='callsign-search', split='development',
                asOf='2026-09-28T12:00:00Z', groups=['visible'], turns=['Хто такий Бек'],
                messages=messages, expect={'evidenceIds': evidence},
                provenance={'requestId': '01a0e70a-77e4-7c21-8598-b544b3fd0eb8',
                            'source': 'local clone; user-reviewed positive examples',
                            'scopeNote': 'Synthetic fixture scope; validate real permissions via local HTTP'})
    cases = [case, {**case, 'id': 'bek-followup', 'turns': ['Хто такий Бек', 'позивний']}]
    destination.parent.mkdir(exist_ok=True)
    with destination.open('x') as output:
        os.chmod(destination, 0o600)
        output.write(json.dumps(cases, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'capturedMessages': len(messages), 'requiredMessages': len(evidence),
                      'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()

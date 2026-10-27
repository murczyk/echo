#!/usr/bin/env python3
"""Capture the #3760 unit-report regression (request 01a12609-d14b-7172-8075-cbd8d3ce341a).

Runs only READ ONLY queries over ssh on the echo-siversk host and writes the private raw/cases-v1.json.
Unit 79989 messages carry the unit in header metadata (unit_v2 / sigint_inbox_item_unit), not in their text.
"""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
HOST = 'echo-siversk'
UNIT_ID = 79989
QUERY = f"""
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
WITH linked AS (
 SELECT i.* FROM sigint_inbox_item i JOIN sigint_inbox_item_unit u ON u.item_id=i.id
 WHERE u.unit_id={UNIT_ID} AND i.datetime >= timestamp '2026-10-10 00:00' AND i.datetime < timestamp '2026-10-11 00:00'
), distractors AS (
 SELECT i.* FROM sigint_inbox_item i
 WHERE i.datetime >= timestamp '2026-10-10 00:00' AND i.datetime < timestamp '2026-10-11 00:00'
 AND i.id NOT IN (SELECT id FROM linked) AND i.body_noheader::text ~* 'дш[рпбд]'
), pool AS (SELECT *, true AS is_linked FROM linked UNION ALL SELECT *, false FROM distractors)
SELECT json_build_object(
 'units', (SELECT json_agg(json_build_object('id',id,'name',name,'active',active,'battalion',battalion,
           'regiment',regiment,'division',division)) FROM sigint_unit WHERE id={UNIT_ID}),
 'messages', (SELECT json_agg(json_build_object(
   'id',p.id,'uid',p.id_uuid,'timestamp',(extract(epoch from p.datetime)*1000)::bigint,'groupKey','visible',
   'text',p.body_noheader->>'body','callsigns','[]'::json,'indexed',true,
   'unit',p.unit_v2,'unitIds',CASE WHEN p.is_linked THEN json_build_array({UNIT_ID}) ELSE '[]'::json END) ORDER BY p.id) FROM pool p));
ROLLBACK;
"""

PROMPT = 'зроби звіт по 8дшр 3дшб  104дшп 76дшд за сьогодні'


def main():
    destination = ROOT / 'raw/cases-v1.json'
    if destination.exists():
        raise SystemExit('Immutable fixture already exists; use a new revision to recapture')
    result = subprocess.run(['ssh', HOST, 'sudo -n -u postgres psql -XAtq -d wd -v ON_ERROR_STOP=1'],
                            input=QUERY, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr)
    data = json.loads(result.stdout.strip().splitlines()[-1])
    linked = [m['id'] for m in data['messages'] if m['unitIds']]
    if len(linked) < 20:
        raise SystemExit('Expected the unit-linked messages of 2026-10-10')
    case = {'id': 'siversk-unit-report', 'category': 'unit-search', 'split': 'validation',
            'asOf': '2026-10-10T12:00:00Z', 'groups': ['visible'], 'turns': [PROMPT],
            'units': data['units'], 'messages': data['messages'],
            'expect': {'evidenceIds': linked[-3:], 'unitSearch': True, 'bothSearches': False,
                       'forbiddenPatterns': ['не зафіксован', 'немає підтверджен', 'не знайдено']},
            'provenance': {'host': HOST, 'unitId': UNIT_ID, 'requestId': '01a12609-d14b-7172-8075-cbd8d3ce341a',
                           'linkedMessages': len(linked)}}
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps([case], ensure_ascii=False) + '\n')
    print(f'wrote {destination} with {len(data["messages"])} messages ({len(linked)} unit-linked)')


if __name__ == '__main__':
    main()

"""#3572: exercise actual Echo search SQL over bounded, authorized fixtures."""
import os
from pathlib import Path
import unittest

from fixtures import group_details, response, selectable_groups

ROOT = Path(__file__).resolve().parents[2]


class GroupScope(unittest.TestCase):
    case = {'groups': ['key-a', 'key-b'], 'groupNames': {'key-a': 'DEVOPS'}, 'messages': []}

    def test_names_differ_from_keys_and_default_to_the_key(self):
        self.assertEqual([(item['master_key'], item['name']) for item in group_details(self.case)],
                         [('key-a', 'DEVOPS'), ('key-b', 'key-b')])
        self.assertEqual(len(response(self.case, '/api/user/sigint-groups-detailed', {}, {})), 2)

    def test_unmatched_selection_finds_nothing_like_production(self):
        self.assertEqual(selectable_groups(self.case, {'selected_groups': ['DEVOPS']}, {}), set())
        self.assertEqual(selectable_groups(self.case, {'selected_groups': ['key-a', 'x']}, {}), {'key-a'})
        self.assertEqual(selectable_groups(self.case, {}, {}), {'key-a', 'key-b'})
        self.assertEqual(selectable_groups(self.case, {'selected_groups': []}, {}), {'key-a', 'key-b'})

    def test_legacy_fallback_reproduces_the_incident_widening(self):
        settings = {'legacyGroupFallback': True}
        self.assertEqual(selectable_groups(self.case, {'selected_groups': ['DEVOPS']}, settings), {'key-a', 'key-b'})
        self.assertEqual(selectable_groups(self.case, {'selected_groups': ['key-a']}, settings), {'key-a'})


class SearchRegression(unittest.TestCase):
    def test_complementary_search_and_existing_syntax(self):
        settings = {'binary': str(ROOT / 'target/debug/wdintel-rs'),
                    'psql': ['sudo', '-n', '-u', 'postgres', 'psql', '-d', os.environ.get('TEST_DB_NAME', 'wd')]}
        messages = [
            (1, 'Рація Кедра у майстерні.', [], 'visible'),
            (2, 'Кедр повернувся.', ['кедр'], 'visible'),
            (3, 'Беркути спостерігають.', [], 'visible'),
            (4, 'BODY.DOT a_b', [], 'visible'),
            (5, 'Кедр прихований.', ['кедр'], 'secret'),
        ]
        case = {'groups': ['visible'], 'messages': [dict(id=i, text=text, callsigns=tags, groupKey=group,
                 uid=f'abcd-efgh-{i:04}', timestamp=1_790_000_000_000, frequency='165.2500')
                 for i, text, tags, group in messages]}
        base = dict(since_date_inclusive_ms=1_789_999_000_000, till_date_inclusive_ms=1_790_001_000_000)

        def found(**filters):
            result = response(case, '/api/rer-importer/get-inbox', {**base, **filters}, settings)
            return [item[0] for item in result['inbox_items']]

        self.assertEqual(found(search='кедр'), [2, 1])
        self.assertEqual(found(selected_callsigns=['кедр']), [2])
        self.assertEqual(found(search='кедр', selected_callsigns=['кедр']), [2])
        self.assertEqual(found(search='Берку'), [3])
        self.assertEqual(found(search='кедр or беркути'), [3, 2, 1])
        self.assertEqual(found(search='кедр -майстерні'), [2])
        self.assertEqual(found(search='"Кедр" or "майстерні"'), [1])
        self.assertEqual(found(search='"Ке%р"'), [2, 1])
        self.assertEqual(found(search='BODY.DOT'), [4])
        self.assertEqual(found(search='"a_b"'), [4])
        self.assertEqual(found(search='165,25'), [4, 3, 2, 1])
        self.assertEqual(found(search='кедр -165.25'), [])
        self.assertEqual(found(search='abcd-efgh-0001'), [1])
        self.assertEqual(found(search='кедр', selected_groups=['secret']), [])
        self.assertEqual(found(search='кедр', before_id_noninclusive=2), [1])


class UnitFilters(unittest.TestCase):
    def test_unit_filter_uses_metadata_not_body_and_lookup_tolerates_spacing(self):
        settings = {'binary': str(ROOT / 'target/debug/wdintel-rs'),
                    'psql': ['sudo', '-n', '-u', 'postgres', 'psql', '-d', os.environ.get('TEST_DB_NAME', 'wd')]}
        case = {'groups': ['visible'], 'units': [{'id': 7, 'name': 'шр 3 дшб 104 дшп', 'active': True}],
                'messages': [dict(id=1, text='Просто розмова', callsigns=[], groupKey='visible', uid='a', unit='X', unitIds=[7],
                                  timestamp=1_790_000_000_000),
                             dict(id=2, text='3 дшб 104 дшп', callsigns=[], groupKey='visible', uid='b',
                                  timestamp=1_790_000_000_000)]}
        base = dict(since_date_inclusive_ms=1_789_999_000_000, till_date_inclusive_ms=1_790_001_000_000)
        ids = lambda **body: [item[0] for item in response(case, '/api/rer-importer/get-inbox', {**base, **body}, settings)['inbox_items']]
        self.assertEqual(ids(selected_unit_ids=[7]), [1])
        self.assertEqual(ids(selected_units=['X']), [1])
        self.assertEqual(ids(search='104'), [2])
        found = response(case, '/api/sigint/units', {'filter_text': '3дшб104дшп'}, settings)
        self.assertEqual([unit['id'] for unit in found['units']], [7])
        case['units'].append({'id': 8, 'name': '3 дшб 105 дшп', 'active': True})
        found = response(case, '/api/sigint/units', {'filter_text': '3 дшб 104 дшп'}, settings)
        self.assertEqual([unit['id'] for unit in found['units']], [7, 8])


if __name__ == '__main__':
    unittest.main()

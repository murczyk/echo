"""#3572: exercise actual Echo search SQL over bounded, authorized fixtures."""
import os
from pathlib import Path
import unittest

from fixtures import response

ROOT = Path(__file__).resolve().parents[2]


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


if __name__ == '__main__':
    unittest.main()

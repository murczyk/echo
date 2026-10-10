"""Grading rejects incomplete absence searches and fabricated citation URLs."""
import json
import unittest

from grading import accepted_citation, grade


def case(case_id):
    with open('ai-eval/2026-09-28-callsign-search/cases.json') as handle:
        cases = json.load(handle)
    return next(item for item in cases if item['id'] == case_id)


def retrieval(body, messages=None):
    return {'type': 'eval_retrieval', 'path': '/api/rer-importer/get-inbox', 'body': body, 'status': 200,
            'response': {'inbox_items': [[item['id'], item] for item in messages or []]}}


def unit_case():
    with open('ai-eval/2026-10-10-unit-search/cases.json') as handle:
        return next(item for item in json.load(handle) if item['id'] == 'unit-report-glued')


class UnitSearch(unittest.TestCase):
    def test_text_only_search_fails_unit_case(self):
        sample = unit_case()
        events = [retrieval({'since_date_inclusive_ms': 1, 'till_date_inclusive_ms': 2, 'search': '"104 дшп"'}),
                  {'type': 'eval_answer', 'text': 'Немає підтверджених відомостей.'}]
        failures = grade(sample, events)['failures']
        self.assertIn('unit_filter_search_missing', failures)
        self.assertIn('required_evidence_not_retrieved', failures)
        self.assertIn('unsupported_answer', failures)

    def test_unit_request_outside_the_day_is_widening(self):
        sample = next(item for item in json.load(open('ai-eval/2026-10-10-unit-search/cases.json'))
                      if item['id'] == 'unit-empty-period')
        start, end = sample['expect']['dateBounds']
        events = [retrieval({'since_date_inclusive_ms': start - 7 * 86400000, 'till_date_inclusive_ms': end, 'selected_unit_ids': [79989]}),
                  {'type': 'eval_answer', 'text': 'Нічого за період.'}]
        self.assertIn('explicit_period_widened', grade(sample, events)['failures'])

    def test_unit_filter_counts_as_unit_search(self):
        sample = unit_case()
        events = [retrieval({'since_date_inclusive_ms': 1, 'till_date_inclusive_ms': 2, 'selected_unit_ids': [79989]})]
        self.assertEqual(grade(sample, events)['unitSearches'], 1)


class CoverageAndCitations(unittest.TestCase):
    def test_one_millisecond_search_does_not_prove_absence(self):
        sample = case('empty-search')
        earliest = sample['expect']['earliestSearchMs']
        events = [
            retrieval({'since_date_inclusive_ms': earliest, 'till_date_inclusive_ms': earliest, 'search': 'сапфір'}),
            retrieval({'since_date_inclusive_ms': earliest, 'till_date_inclusive_ms': earliest, 'selected_callsigns': ['сапфір']}),
            {'type': 'eval_answer', 'text': 'За останні 90 днів згадок не знайдено.'},
        ]
        self.assertIn('older_window_missing', grade(sample, events)['failures'])

    def test_contiguous_windows_cover_an_empty_search(self):
        sample = case('empty-search')
        windows = [(1782853200000, 1785272399999), (1785272400000, 1787950799999), (1787950800000, 1790629199999)]
        events = []
        for since, till in windows:
            events.append(retrieval({'since_date_inclusive_ms': since, 'till_date_inclusive_ms': till, 'search': 'сапфір'}))
            events.append(retrieval({'since_date_inclusive_ms': since, 'till_date_inclusive_ms': till, 'selected_callsigns': ['сапфір']}))
        events.append({'type': 'eval_answer', 'text': 'За період пошуку згадок немає.'})
        self.assertEqual(grade(sample, events)['failures'], [])

    def test_fabricated_citation_host_fails(self):
        sample = case('ukrainian-russian-spelling')
        message = sample['messages'][0]
        events = [
            retrieval({'search': 'меркурий'}, [message]),
            retrieval({'selected_callsigns': ['меркурий']}, [message]),
            {'type': 'message_citations', 'citations': [{'messageId': message['id'], 'messageIdentifier': message['uid']}]},
            {'type': 'eval_answer', 'text': f"Оператор [джерело](https://wrong.invalid/rer-analysis-neo?m={message['uid']})"},
        ]
        graded = grade(sample, events)
        self.assertIn('citation_or_access_violation', graded['failures'])
        self.assertEqual(graded['citedIds'], [])
        self.assertIsNone(accepted_citation(f"https://wrong.invalid/rer-analysis-neo?m={message['uid']}", {message['uid']: message['id']}))

    def test_relative_delivered_citation_passes(self):
        sample = case('ukrainian-russian-spelling')
        message = sample['messages'][0]
        events = [
            retrieval({'search': 'меркурий'}, [message]),
            retrieval({'selected_callsigns': ['меркурий']}, [message]),
            {'type': 'message_citations', 'citations': [{'messageId': message['id'], 'messageIdentifier': message['uid']}]},
            {'type': 'eval_answer', 'text': f"Оператор [джерело](/rer-analysis-neo?m={message['uid']})"},
        ]
        graded = grade(sample, events)
        self.assertNotIn('citation_or_access_violation', graded['failures'])
        self.assertEqual(graded['citedIds'], [message['id']])


if __name__ == '__main__':
    unittest.main()

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


def group_case(case_id):
    with open('ai-eval/2026-11-06-group-scope/cases.json') as handle:
        return next(item for item in json.load(handle) if item['id'] == case_id)


def group_message(sample, identifier):
    return next(item for item in sample['messages'] if item['id'] == identifier)


def cited(sample, *identifiers):
    return [{'type': 'message_citations', 'citations': [
        {'messageId': identifier, 'messageIdentifier': group_message(sample, identifier)['uid']}
        for identifier in identifiers]},
        {'type': 'eval_answer', 'text': ' '.join(
            f"[джерело](/rer-analysis-neo?m={group_message(sample, identifier)['uid']})" for identifier in identifiers)}]


class GroupScope(unittest.TestCase):
    def test_scoped_read_passes_and_is_not_confused_by_the_group_list(self):
        sample = group_case('chat-word')
        key = sample['expect']['groupScope']['keys'][0]
        events = [{'type': 'eval_retrieval', 'path': '/api/user/sigint-groups-detailed', 'body': {}, 'status': 200,
                   'response': [{'master_key': key, 'name': 'DEVOPS'}]},
                  retrieval({'selected_groups': [key]}, [group_message(sample, 101), group_message(sample, 102)]),
                  *cited(sample, 101, 102)]
        result = grade(sample, events)
        self.assertEqual(result['failures'], [])

    def test_a_guessed_name_fails_even_when_the_fixture_returns_nothing(self):
        sample = group_case('empty-in-period')
        events = [retrieval({'selected_groups': ['DEVOPS']}, []), {'type': 'eval_answer', 'text': 'Нічого.'}]
        self.assertIn('group_scope_not_applied', grade(sample, events)['failures'])

    def test_incident_widened_results_fail_retrieval_and_citation(self):
        sample = group_case('group-word-incident')
        events = [retrieval({'selected_groups': ['DEVOPS']},
                            [group_message(sample, 101), group_message(sample, 102), group_message(sample, 230)]),
                  *cited(sample, 101, 102, 230)]
        failures = grade(sample, events)['failures']
        self.assertIn('group_scope_not_applied', failures)
        self.assertIn('out_of_scope_retrieval', failures)
        self.assertIn('out_of_scope_citation', failures)

    def test_every_page_stays_scoped(self):
        sample = group_case('follow-up-inherits')
        key = sample['expect']['groupScope']['keys'][0]
        events = [retrieval({'selected_groups': [key]}, [group_message(sample, 101), group_message(sample, 102)]),
                  retrieval({}, []), *cited(sample, 101, 102)]
        self.assertIn('group_scope_not_applied', grade(sample, events)['failures'])

    def test_no_read_at_all_is_not_scope(self):
        sample = group_case('chat-word')
        self.assertIn('group_scope_not_applied', grade(sample, [{'type': 'eval_answer', 'text': 'Не знайдено.'}])['failures'])

    def test_unknown_group_may_read_nothing_but_must_say_so(self):
        sample = group_case('unknown-group')
        self.assertEqual(grade(sample, [{'type': 'eval_answer', 'text': 'Такого чату не знайдено.'}])['failures'], [])
        self.assertEqual(grade(sample, [{'type': 'eval_answer', 'text': 'Усе добре.'}])['failures'],
                         ['required_answer_missing'])

    def test_a_selection_outside_the_expected_keys_fails_even_if_scoped(self):
        sample = group_case('unknown-group')
        events = [retrieval({'selected_groups': ['group.other']}, []), {'type': 'eval_answer', 'text': 'Не знайдено.'}]
        self.assertIn('group_scope_not_applied', grade(sample, events)['failures'])

    def test_same_name_groups_must_all_be_read(self):
        sample = group_case('same-name-two-keys')
        first, second = sample['expect']['groupScope']['keys']
        one = [retrieval({'selected_groups': [first]}, [group_message(sample, 501)]), *cited(sample, 501)]
        self.assertIn('group_scope_incomplete', grade(sample, one)['failures'])
        both = [retrieval({'selected_groups': [first, second]}, [group_message(sample, 501), group_message(sample, 502)]),
                *cited(sample, 501, 502)]
        self.assertEqual(grade(sample, both)['failures'], [])

    def test_a_group_name_used_as_a_subject_must_not_become_a_scope(self):
        sample = group_case('name-as-subject')
        scoped = [retrieval({'selected_groups': ['group.any']}, [group_message(sample, 701)]), *cited(sample, 701)]
        self.assertIn('group_scope_applied_to_subject', grade(sample, scoped)['failures'])
        plain = [retrieval({'search': 'кобальт'}, [group_message(sample, 701)]), *cited(sample, 701)]
        self.assertEqual(grade(sample, plain)['failures'], [])

    def test_ambiguous_name_may_clarify_without_reading(self):
        sample = group_case('ambiguous-names')
        self.assertEqual(grade(sample, [{'type': 'eval_answer', 'text': 'Яка саме альфа?'}])['failures'], [])
        self.assertEqual(grade(sample, [{'type': 'eval_answer', 'text': 'Готово.'}])['failures'],
                         ['required_answer_missing'])

    def test_an_empty_read_must_be_reported_not_filled_in(self):
        sample = group_case('empty-in-period')
        key = sample['expect']['groupScope']['keys'][0]
        read = retrieval({'selected_groups': [key]}, [])
        self.assertEqual(grade(sample, [read, {'type': 'eval_answer', 'text': 'За сьогодні повідомлень не було.'}])['failures'], [])
        self.assertIn('required_answer_missing',
                      grade(sample, [read, {'type': 'eval_answer', 'text': 'Сьогодні сто зіткнень.'}])['failures'])

    def test_an_earlier_answer_cannot_hide_an_out_of_scope_citation(self):
        sample = group_case('follow-up-inherits')
        key = sample['expect']['groupScope']['keys'][0]
        read = retrieval({'selected_groups': [key]}, [group_message(sample, 101), group_message(sample, 102)])
        events = [read, *cited(sample, 230), read, *cited(sample, 101, 102)]
        self.assertIn('citation_or_access_violation', grade(sample, events)['failures'])


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

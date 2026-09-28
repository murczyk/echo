"""Judge request shape and recorded failures for the callsign harness."""
import io
import json
import unittest
import urllib.error

from cli import judge_endpoint, judge_failure, judge_request, parse_judge_output


CASE = {'turns': ['Хто такий Кедр?'], 'messages': [{'id': 1, 'text': 'Кедр працює механіком.'}]}
RESULT = {'retrievedIds': [1], 'answer': 'Кедр працює механіком.'}


class JudgeRequest(unittest.TestCase):
    def test_gpt6_uses_completion_token_limit(self):
        engine = {'model_name': 'gpt-6-sol', 'url': 'https://api.openai.com/v1/chat/completions'}
        payload = judge_request(CASE, RESULT, engine)
        self.assertEqual(judge_endpoint(engine), 'https://api.openai.com/v1/chat/completions')
        self.assertEqual(payload['max_completion_tokens'], 2048)
        self.assertEqual(payload['reasoning_effort'], 'none')
        self.assertNotIn('max_tokens', payload)
        self.assertNotIn('token', payload)

    def test_parses_verdict_without_storing_transport(self):
        recorded = parse_judge_output(
            {'choices': [{'message': {'content': json.dumps({
                'grounded': True, 'useful': True, 'ambiguityHandled': True,
                'unnecessaryClarification': False, 'reason': 'cited'})}}]},
            {'model_name': 'gpt-6-sol'})
        self.assertEqual(recorded['engine'], 'gpt-6-sol')
        self.assertTrue(recorded['verdict']['grounded'])
        self.assertEqual(len(recorded['rubricSha256']), 64)
        self.assertNotIn('answer', recorded)

    def test_http_failure_keeps_status_and_code_only(self):
        body = json.dumps({'error': {
            'message': 'Unsupported parameter: max_tokens is not supported with this model.',
            'type': 'invalid_request_error', 'code': 'unsupported_parameter', 'param': 'max_tokens',
        }}).encode()
        error = urllib.error.HTTPError('https://api.openai.com/v1/chat/completions', 400, 'Bad Request', None, io.BytesIO(body))
        self.assertEqual(judge_failure(error), {
            'error': 'HTTPError', 'status': 400, 'code': 'unsupported_parameter', 'param': 'max_tokens'})
        self.assertEqual(judge_failure(TimeoutError('slow')), {'error': 'TimeoutError'})


if __name__ == '__main__':
    unittest.main()

import unittest

from summarize_inbox_operations import summarize


class InboxOperationLogTests(unittest.TestCase):
    def test_zp2_candidate_success_does_not_count_as_hybrid_delivery(self):
        result = summarize([
            'analytics_route operation="inbox message candidates" route=analytics outcome=success elapsed_ms=2',
            'rer_duty_inbox_route route=postgres_fallback candidate_revalidation_complete=false merged_candidate_count=1 elapsed_ms=3',
            'inbox operation completed route=postgres_fallback reason=candidate_revalidation_incomplete failed_stage=hydration outcome=success elapsed_ms=150',
        ])
        self.assertEqual(result["final_hybrid_successes"], 0)
        self.assertEqual(result["complete_fallbacks"], 1)
        self.assertEqual(result["duration_ms"]["total"], 150)

    def test_every_final_fallback_outcome_is_counted_once(self):
        result = summarize([
            f'inbox operation completed route=postgres_fallback reason={reason} failed_stage={stage} outcome={outcome} elapsed_ms=20'
            for reason, stage, outcome in [
                ("candidates_unavailable", "candidate_retrieval", "success"),
                ("postgres_tail_error", "postgres_tail", "error"),
                ("candidate_ordering_incomplete", "ordering", "cancelled"),
                ("revalidation_error", "hydration", "success"),
            ]
        ])
        self.assertEqual(result["complete_fallbacks"], 4)
        self.assertEqual(len(result["final_outcomes"]), 4)

    def test_journal_and_candidate_reasons_remain_separate(self):
        result = summarize([
            '{"MESSAGE":"inbox operation completed route=analytics_hybrid reason=none failed_stage=none outcome=success elapsed_ms=10"}',
            'analytics_route operation="inbox message candidates" route=postgres reason=circuit_open outcome=success elapsed_ms=0',
            'analytics_route operation="inbox message candidates" route=postgres reason=analytics_timeout outcome=success elapsed_ms=0',
        ])
        self.assertEqual(result["final_hybrid_successes"], 1)
        self.assertEqual(result["complete_fallbacks"], 0)
        self.assertEqual(result["candidate_postgres_reasons"], {"analytics_timeout": 1, "circuit_open": 1})


if __name__ == "__main__":
    unittest.main()

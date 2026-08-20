# Prompt iterations — 2026-08-19

Metrics are kept separate for CBR/Cyber and Pivnich/RER. Private case-level
inputs, model responses, and human reviews remain under `raw/`; this record
contains only non-sensitive aggregate observations.

| Candidate | Configuration | Result |
| --- | --- | --- |
| 01 source-only | One request, no examples | Safe baseline, but insufficiently matched local report form. |
| 02 recent examples | One request with recent human pairs | Better form and prioritization; required explicit protection against example-fact transfer. |
| 03 lexical ranking | One request with radio vocabulary guidance | Improved distinction between flight, presence, and use of UAVs. |
| 04 detailed GOI | Detailed/multi-stage analytical context | Rejected: 4–10 s and observed leakage of example facts. GOI remains evaluation-only. |
| 05 selected shared | One structured request, safe examples, lexical guidance | Selected: observed live iterations 1.2–1.7 s with no reducer, retry, or second call. |
| 06 operator priority | One structured request, operator-first linked products, up to three variants | Selected after live feedback: exact matching products are marked as the strongest prompt precedent; additional distinct variants remain optional. |
| 07 exact-source chronology | Creation-time cutoff and an explicit exact-source marker | Fixed minute-rounded message timestamps excluding a preceding same-user product; exact wording remains a prompt preference rather than a backend override. |

Final acceptance requires JSON validity, zero new numeric/coordinate tokens,
warm p95 below five seconds, access-isolation tests, and blinded factuality,
usefulness, and style review for both CBR and Pivnich datasets. Production
remains disabled until that review is recorded.

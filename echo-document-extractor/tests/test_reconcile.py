from echo_document_extractor.models import Evidence
from echo_document_extractor.reconcile import reconcile


def test_nuextract_is_deterministic_final_tiebreaker() -> None:
    candidates = [
        Evidence(id="gemma", source="gemma", html="<p>A</p>", text="A"),
        Evidence(id="nu", source="nuextract3", html="<p>B</p>", text="B"),
    ]
    selected, decision = reconcile("p1", candidates, [])
    assert selected is not None
    assert selected.source == "nuextract3"
    assert decision.unresolved


def test_numeric_multiset_and_critical_tokens_must_match_grounding() -> None:
    candidates = [
        Evidence(id="missing", source="gemma", html="<p>AB-1 20</p>", text="AB-1 20"),
        Evidence(id="complete", source="nuextract3", html="<p>AB-1 20 20</p>", text="AB-1 20 20"),
    ]
    supporting = [
        Evidence(id="ocr-1", source="ppocr", text="AB-1", bbox=(0, 0, 10, 10), confidence=0.9),
        Evidence(id="ocr-2", source="ppocr", text="20", bbox=(11, 0, 20, 10), confidence=0.9),
        Evidence(id="ocr-3", source="ppocr", text="20", bbox=(21, 0, 30, 10), confidence=0.9),
    ]
    selected, decision = reconcile("p1-b1", candidates, supporting)
    assert selected is not None
    assert selected.id == "complete"
    missing_rank = next(rank for rank in decision.ranks if rank.evidence_id == "missing")
    assert not next(
        validator for validator in missing_rank.validators if validator.name == "numeric_multiset"
    ).passed

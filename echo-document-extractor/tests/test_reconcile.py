import pytest

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


@pytest.mark.parametrize(
    ("candidate", "ocr"),
    [("мсб", "MC6"), ("1ед", "1eA"), ("Взв.БпЛА 1мсб", "B3B.BnIA 1mc6")],
)
def test_critical_tokens_accept_visual_ocr_confusables(candidate: str, ocr: str) -> None:
    selected, decision = reconcile(
        "cell",
        [Evidence(id="candidate", source="nuextract3", html="<p>x</p>", text=candidate)],
        [Evidence(id="ocr", source="ppocr", text=ocr, confidence=0.9)],
    )

    assert selected is not None
    validator = next(item for item in decision.validators if item.name == "critical_tokens")
    assert validator.passed


def test_critical_tokens_still_reject_different_identifiers() -> None:
    selected, decision = reconcile(
        "cell",
        [Evidence(id="candidate", source="nuextract3", html="<p>x</p>", text="AB-12")],
        [Evidence(id="ocr", source="ppocr", text="CD-34", confidence=0.9)],
    )

    assert selected is None
    validator = next(item for item in decision.validators if item.name == "critical_tokens")
    assert not validator.passed


def test_critical_tokens_do_not_fail_without_supporting_tokens() -> None:
    selected, decision = reconcile(
        "table",
        [Evidence(id="candidate", source="nuextract3", html="<p>AB-12</p>", text="AB-12")],
        [],
    )

    assert selected is not None
    validator = next(item for item in decision.validators if item.name == "critical_tokens")
    assert validator.passed


def test_repeated_cross_family_consensus_overrides_ocr_introduced_digits() -> None:
    candidates = [
        Evidence(id="nu-initial", source="nuextract3", html="<p>Бибо</p>", text="Бибо"),
        Evidence(id="nu-retry", source="nuextract3", html="<p>Бибо</p>", text="Бибо"),
        Evidence(id="gemma-retry", source="gemma", html="<p>Бибо</p>", text="Бибо"),
    ]

    selected, decision = reconcile(
        "cell",
        candidates,
        [Evidence(id="ocr", source="ppocr", text="BH50", confidence=0.9)],
    )

    assert selected is not None
    validator = next(item for item in decision.validators if item.name == "critical_tokens")
    assert validator.passed


@pytest.mark.parametrize("candidate_text", ["20", "20 20 30", "20 21"])
def test_numeric_grounding_rejects_missing_added_and_changed_values(candidate_text: str) -> None:
    selected, decision = reconcile(
        "p1-b1",
        [Evidence(id="candidate", source="gemma", html="<p>x</p>", text=candidate_text)],
        [Evidence(id="ocr", source="ppocr", text="20 20", confidence=0.9)],
    )
    assert selected is None
    validator = next(item for item in decision.validators if item.name == "numeric_multiset")
    assert not validator.passed

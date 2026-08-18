from __future__ import annotations

import re
from collections import Counter
from difflib import SequenceMatcher
from statistics import median

from .models import (
    BBox,
    CandidateRank,
    Decision,
    Evidence,
    RankFactors,
    ValidatorRecord,
)

NUMBER_PATTERN = re.compile(r"(?<![\w])[-+]?\d+(?:[.,]\d+)?(?![\w])")
COORDINATE_PATTERN = re.compile(
    r"(?:"
    r"(?<!\d)-?\d{1,2}[.,]\d{3,}\s*[,;/ ]\s*-?\d{1,3}[.,]\d{3,}(?!\d)"
    r"|(?<!\d)(?:[0-8]?\d(?:[.,]\d+)?)[°º]\s*"
    r"(?:[0-5]?\d(?:[.,]\d+)?)?\s*[′']?\s*[NSПнПдСЮ]?"
    r")",
    re.IGNORECASE,
)
CRITICAL_PATTERN = re.compile(
    r"(?=\S*[A-Za-zА-Яа-яІіЇїЄєҐґ])(?=\S*\d)[A-Za-zА-Яа-яІіЇїЄєҐґ0-9][\w./:-]*",
    re.UNICODE,
)
TOKEN_PATTERN = re.compile(r"[\w./:-]+", re.UNICODE)
VISUAL_CONFUSABLES = str.maketrans(
    {
        "а": "a",
        "б": "6",
        "в": "b",
        "д": "a",
        "е": "e",
        "ё": "e",
        "з": "3",
        "к": "k",
        "л": "i",
        "м": "m",
        "н": "h",
        "о": "o",
        "п": "n",
        "р": "p",
        "с": "c",
        "т": "t",
        "у": "y",
        "ф": "f",
        "х": "x",
        "ч": "4",
        "ш": "m",
        "μ": "a",
        "π": "n",
    }
)


def reconcile(
    unit_id: str,
    candidates: list[Evidence],
    supporting: list[Evidence],
    expected_bbox: BBox | None = None,
    expected_topology: str | None = None,
) -> tuple[Evidence | None, Decision]:
    eligible = [candidate for candidate in candidates if candidate.html or candidate.text]
    ranked_items = [
        (
            candidate,
            _rank_factors(candidate, eligible, supporting, expected_bbox, expected_topology),
            _validators(candidate, eligible, supporting, expected_bbox, expected_topology),
        )
        for candidate in eligible
    ]
    ranked_items.sort(key=lambda item: item[1].tuple(), reverse=True)
    valid = [item for item in ranked_items if all(record.passed for record in item[2])]
    selected_item = valid[0] if valid else None
    selected = selected_item[0] if selected_item else None
    unresolved = False
    if selected_item and len(valid) > 1:
        first, second = valid[0], valid[1]
        unresolved = (
            _normalized(first[0].text) != _normalized(second[0].text)
            and first[1].tuple()[:-2] == second[1].tuple()[:-2]
        )
    ranks = [
        CandidateRank(
            evidence_id=candidate.id,
            factors=factors,
            validators=validators,
            rejected=not all(record.passed for record in validators) or candidate is not selected,
        )
        for candidate, factors, validators in ranked_items
    ]
    validators = selected_item[2] if selected_item else _aggregate_failure_validators(ranked_items)
    reason = "lexicographic evidence ranking" if selected else "no candidate passed hard checks"
    return selected, Decision(
        id=f"decision-{unit_id}",
        unit_id=unit_id,
        selected_evidence_id=selected.id if selected else None,
        alternative_evidence_ids=[
            item.id for item in candidates if selected is None or item.id != selected.id
        ],
        reason=reason,
        unresolved=unresolved or selected is None,
        hard_checks_passed=selected is not None,
        ranks=ranks,
        validators=validators,
    )


def needs_retry(candidates: list[Evidence]) -> bool:
    valid = [item for item in candidates if item.valid and (item.html or item.text)]
    return len(valid) > 1 and len({_normalized(item.text) for item in valid}) > 1


def _validators(
    candidate: Evidence,
    peers: list[Evidence],
    supporting: list[Evidence],
    expected_bbox: BBox | None,
    expected_topology: str | None,
) -> list[ValidatorRecord]:
    support_text = _support_text(supporting)
    candidate_numbers = _multiset(NUMBER_PATTERN, candidate.text)
    support_numbers = _multiset(NUMBER_PATTERN, support_text)
    candidate_coordinates = _multiset(COORDINATE_PATTERN, candidate.text)
    support_coordinates = _multiset(COORDINATE_PATTERN, support_text)
    candidate_critical = _multiset(CRITICAL_PATTERN, candidate.text)
    support_critical = _multiset(CRITICAL_PATTERN, support_text)
    numeric_passed = not support_numbers or candidate_numbers == support_numbers
    coordinate_passed = not support_coordinates or candidate_coordinates == support_coordinates
    agreeing = [
        peer for peer in peers if peer.valid and _normalized(peer.text) == _normalized(candidate.text)
    ]
    cross_family_consensus = len({peer.source_family or peer.source for peer in agreeing}) >= 2
    critical_passed = _critical_tokens_match(candidate.text, support_text) or (
        cross_family_consensus
        and (
            _digit_multiset(candidate.text) == _digit_multiset(support_text)
            or (not _digit_multiset(candidate.text) and len(agreeing) >= 3)
        )
    )
    geometry_score = _geometry_compatibility(candidate.bbox, expected_bbox)
    topology = str(candidate.metadata.get("topology", ""))
    topology_passed = expected_topology is None or topology == expected_topology
    return [
        ValidatorRecord(
            name="candidate_integrity",
            passed=candidate.valid and bool((candidate.html or candidate.text).strip()),
            score=1.0 if candidate.valid else 0.0,
            details=",".join(candidate.rejection_reasons),
        ),
        ValidatorRecord(
            name="topology",
            passed=topology_passed,
            score=1.0 if topology_passed else 0.0,
            details=f"expected={expected_topology or 'unspecified'} candidate={topology or 'unspecified'}",
        ),
        ValidatorRecord(
            name="numeric_multiset",
            passed=numeric_passed,
            score=_support_score(candidate_numbers, support_numbers),
            details=_counter_delta(candidate_numbers, support_numbers),
        ),
        ValidatorRecord(
            name="coordinate_pairs",
            passed=coordinate_passed,
            score=_support_score(candidate_coordinates, support_coordinates),
            details=_counter_delta(candidate_coordinates, support_coordinates),
        ),
        ValidatorRecord(
            name="critical_tokens",
            passed=critical_passed,
            score=_support_score(candidate_critical, support_critical),
            details=_counter_delta(candidate_critical, support_critical),
        ),
        ValidatorRecord(
            name="source_region_coverage",
            passed=expected_bbox is None or geometry_score >= 0.5,
            score=geometry_score,
            details="candidate and geometry source regions",
        ),
        ValidatorRecord(
            name="reading_order",
            passed=not any(
                reason in candidate.rejection_reasons for reason in ("repetition", "whitespace_padding")
            ),
            score=1.0
            if not any(
                reason in candidate.rejection_reasons for reason in ("repetition", "whitespace_padding")
            )
            else 0.0,
            details="monotonic unit candidate",
        ),
    ]


def _rank_factors(
    candidate: Evidence,
    peers: list[Evidence],
    supporting: list[Evidence],
    expected_bbox: BBox | None,
    expected_topology: str | None,
) -> RankFactors:
    validators = _validators(candidate, peers, supporting, expected_bbox, expected_topology)
    support_text = _support_text(supporting)
    candidate_tokens = _multiset(NUMBER_PATTERN, candidate.text) + _multiset(CRITICAL_PATTERN, candidate.text)
    support_tokens = _multiset(NUMBER_PATTERN, support_text) + _multiset(CRITICAL_PATTERN, support_text)
    independent_families = {
        peer.source_family or peer.source
        for peer in peers
        if peer.id != candidate.id
        and (peer.source_family or peer.source) != (candidate.source_family or candidate.source)
        and SequenceMatcher(None, _normalized(candidate.text), _normalized(peer.text)).ratio() >= 0.92
    }
    ocr = [item for item in supporting if item.source in {"ppocr", "embedded_pdf"} and item.text]
    ocr_similarity = sum(
        SequenceMatcher(None, _normalized(candidate.text), _normalized(item.text)).ratio() * item.confidence
        for item in ocr
    )
    peer_similarities = [
        SequenceMatcher(None, _normalized(candidate.text), _normalized(peer.text)).ratio()
        for peer in peers
        if peer.id != candidate.id
    ]
    return RankFactors(
        hard_checks=sum(record.passed for record in validators),
        geometry_compatibility=_geometry_compatibility(candidate.bbox, expected_bbox),
        critical_numeric_support=_signed_support(candidate_tokens, support_tokens),
        independent_family_agreement=len(independent_families),
        ocr_similarity=ocr_similarity,
        peer_median_similarity=median(peer_similarities) if peer_similarities else 1.0,
        nuextract3_tiebreaker=candidate.source == "nuextract3",
        preferred_tiebreaker=candidate.metadata.get("preferred_tiebreaker") is True,
    )


def _aggregate_failure_validators(
    ranked_items: list[tuple[Evidence, RankFactors, list[ValidatorRecord]]],
) -> list[ValidatorRecord]:
    if not ranked_items:
        return [ValidatorRecord(name="candidate_integrity", passed=False, details="no candidates")]
    return ranked_items[0][2]


def _geometry_compatibility(candidate: BBox | None, expected: BBox | None) -> float:
    if expected is None:
        return 1.0
    if candidate is None:
        return 0.0
    left, top = max(candidate[0], expected[0]), max(candidate[1], expected[1])
    right, bottom = min(candidate[2], expected[2]), min(candidate[3], expected[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    candidate_area = (candidate[2] - candidate[0]) * (candidate[3] - candidate[1])
    expected_area = (expected[2] - expected[0]) * (expected[3] - expected[1])
    union = candidate_area + expected_area - intersection
    return intersection / union if union else 0.0


def _support_text(supporting: list[Evidence]) -> str:
    selected: list[Evidence] = []
    for item in sorted(
        (value for value in supporting if value.source in {"ppocr", "embedded_pdf"} and value.text),
        key=lambda value: value.confidence,
        reverse=True,
    ):
        if any(
            _normalized(item.text) == _normalized(prior.text)
            and item.bbox is not None
            and prior.bbox is not None
            and _geometry_compatibility(item.bbox, prior.bbox) >= 0.5
            for prior in selected
        ):
            continue
        selected.append(item)
    selected.sort(key=lambda item: ((item.bbox or (0, 0, 1, 1))[1], (item.bbox or (0, 0, 1, 1))[0]))
    return " ".join(item.text for item in selected)


def _multiset(pattern: re.Pattern[str], value: str) -> Counter[str]:
    return Counter(_normalized(match.group(0)) for match in pattern.finditer(value))


def _critical_tokens_match(candidate: str, support: str) -> bool:
    candidate_critical = [match.group(0) for match in CRITICAL_PATTERN.finditer(candidate)]
    support_critical = [match.group(0) for match in CRITICAL_PATTERN.finditer(support)]
    if not support_critical:
        return True
    if Counter(_normalized(token) for token in candidate_critical) == Counter(
        _normalized(token) for token in support_critical
    ):
        return True
    candidate_tokens = TOKEN_PATTERN.findall(candidate)
    support_tokens = TOKEN_PATTERN.findall(support)
    return all(
        any(_visually_similar(token, peer) for peer in support_tokens) for token in candidate_critical
    ) and all(any(_visually_similar(token, peer) for peer in candidate_tokens) for token in support_critical)


def _digit_multiset(value: str) -> Counter[str]:
    return Counter(re.findall(r"\d+", value))


def _visually_similar(first: str, second: str) -> bool:
    first = _normalized(first).translate(VISUAL_CONFUSABLES)
    second = _normalized(second).translate(VISUAL_CONFUSABLES)
    return SequenceMatcher(None, first, second).ratio() >= 0.8


def _support_score(candidate: Counter[str], support: Counter[str]) -> float:
    if not candidate:
        return 1.0
    if not support:
        return 1.0
    supported = sum((candidate & support).values())
    return supported / sum(candidate.values())


def _signed_support(candidate: Counter[str], support: Counter[str]) -> float:
    if not candidate or not support:
        return 0.0
    supported = sum((candidate & support).values())
    unsupported = sum((candidate - support).values())
    return max(-1.0, min(1.0, (supported - unsupported) / sum(candidate.values())))


def _counter_delta(candidate: Counter[str], support: Counter[str]) -> str:
    added = list((candidate - support).elements()) if support else []
    missing = list((support - candidate).elements()) if support else []
    return f"added={added[:8]} missing={missing[:8]}"


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()

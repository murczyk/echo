from __future__ import annotations

from collections.abc import Callable
from difflib import SequenceMatcher


def text_similarity(first: str, second: str) -> float:
    return SequenceMatcher(
        None,
        " ".join(first.split()).casefold(),
        " ".join(second.split()).casefold(),
    ).ratio()


def align_indices(
    source_count: int,
    target_count: int,
    match_score: Callable[[int, int], float],
    target_skip_penalty: Callable[[int], float],
    source_skip_penalty: Callable[[int], float] | None = None,
) -> dict[int, int]:
    negative = float("-inf")
    scores = [[negative] * (target_count + 1) for _ in range(source_count + 1)]
    paths: list[list[list[tuple[int, int]] | None]] = [
        [None] * (target_count + 1) for _ in range(source_count + 1)
    ]
    scores[0][0] = 0.0
    paths[0][0] = []
    for source in range(source_count + 1):
        for target in range(target_count + 1):
            path = paths[source][target]
            if path is None:
                continue
            transitions: list[tuple[int, int, float, list[tuple[int, int]]]] = []
            if source < source_count and target < target_count:
                transitions.append(
                    (
                        source + 1,
                        target + 1,
                        match_score(source, target),
                        [*path, (target, source)],
                    )
                )
            if target < target_count:
                transitions.append((source, target + 1, target_skip_penalty(target), path))
            if source_skip_penalty is not None and source < source_count:
                transitions.append((source + 1, target, source_skip_penalty(source), path))
            for next_source, next_target, delta, next_path in transitions:
                score = scores[source][target] + delta
                if score > scores[next_source][next_target]:
                    scores[next_source][next_target] = score
                    paths[next_source][next_target] = next_path
    return dict(paths[-1][-1] or [])


def align_text_sequences(
    sources: list[str],
    targets: list[str],
    allow_source_skips: bool = False,
    assume_equal_positions: bool = True,
) -> dict[int, int]:
    if assume_equal_positions and len(sources) == len(targets):
        return {index: index for index in range(len(sources))}
    return align_indices(
        len(sources),
        len(targets),
        lambda source, target: _text_alignment_score(sources[source], targets[target]),
        lambda target: 0.0 if not targets[target].strip() else -1.5,
        (lambda source: -0.25 if not sources[source].strip() else -1.5) if allow_source_skips else None,
    )


def _text_alignment_score(source: str, target: str) -> float:
    source = source.strip()
    target = target.strip()
    if not source and not target:
        return 2.0
    if not source or not target:
        return -2.0
    return 4.0 * text_similarity(source, target) - 1.0

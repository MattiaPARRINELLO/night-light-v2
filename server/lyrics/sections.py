"""Report du refrain des paroles sur les sections musicales.

L'analyse audio ne découpe plus couplet/refrain. Quand LRCLIB fournit un
refrain, on s'en sert pour marquer les sections qu'il recouvre : le plan de
show les traite alors comme un vrai refrain (orchestration, humeur).
"""

from __future__ import annotations

from typing import Any

# Part de la section qui doit être couverte par le refrain pour la marquer.
MIN_OVERLAP = 0.4
# Deux lignes de refrain séparées par moins que ça forment un seul bloc.
MERGE_GAP_SEC = 2.5


def chorus_ranges(payload: dict[str, Any]) -> list[tuple[float, float]]:
    """Intervalles de refrain, en secondes, fusionnés quand ils se suivent."""
    lines = payload.get("lines")
    chorus = payload.get("chorusLines")
    if not isinstance(lines, list) or not isinstance(chorus, list):
        return []
    wanted = {index for index in chorus if isinstance(index, int)}
    ranges: list[tuple[float, float]] = []
    for index, line in enumerate(lines):
        if index not in wanted or not isinstance(line, dict):
            continue
        start_ms = line.get("startMs")
        end_ms = line.get("endMs")
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        start = float(start_ms) / 1000.0
        end = float(end_ms) / 1000.0
        if end <= start:
            continue
        if ranges and start - ranges[-1][1] <= MERGE_GAP_SEC:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
        else:
            ranges.append((start, end))
    return ranges


def apply_chorus_sections(schema: dict[str, Any], payload: dict[str, Any]) -> int:
    """Marque `kind = "refrain"` sur les sections couvertes par le refrain.

    Renvoie le nombre de sections modifiées.
    """
    ranges = chorus_ranges(payload)
    if not ranges:
        return 0
    sections = schema.get("sections")
    if not isinstance(sections, list):
        return 0

    marked = 0
    for section in sections:
        if not isinstance(section, dict):
            continue
        start = section.get("start")
        end = section.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        start = float(start)
        end = float(end)
        span = end - start
        if span <= 0:
            continue
        overlap = sum(
            max(0.0, min(end, chorus_end) - max(start, chorus_start))
            for chorus_start, chorus_end in ranges
        )
        if overlap / span >= MIN_OVERLAP:
            section["kind"] = "refrain"
            marked += 1
    return marked

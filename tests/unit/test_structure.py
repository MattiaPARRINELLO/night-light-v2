"""Détection de la structure répétitive (groupes couplet/refrain)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import structure
from server.structure import StructureSegment, _coalesce, _letters, estimate_structure
from tests.support.make_fixture import write_structured_track


def msaf_disponible() -> bool:
    try:
        structure._load_msaf()
    except Exception:  # noqa: BLE001 - on saute le test si msaf est absent/cassé
        return False
    return True


def test_letters_ordonnees_par_premiere_apparition() -> None:
    assert _letters(["2.0", "1.0", "2.0", "0.0"]) == ["A", "B", "A", "C"]


def test_coalesce_absorbe_les_blocs_trop_courts() -> None:
    segments = [
        StructureSegment(0.0, 0.8, "A"),  # artefact : absorbé par la suite
        StructureSegment(0.8, 20.0, "B"),
        StructureSegment(20.0, 20.6, "C"),  # artefact : absorbé par l'arrière
        StructureSegment(20.6, 60.0, "D"),
    ]
    out = _coalesce(segments)
    assert [(segment.start, segment.end, segment.group) for segment in out] == [
        (0.0, 20.6, "B"),
        (20.6, 60.0, "D"),
    ]


@pytest.mark.skipif(not msaf_disponible(), reason="msaf indisponible")
def test_structure_repetitive_detectee(tmp_path: Path) -> None:
    track = tmp_path / "structure.wav"
    write_structured_track(track, duration_per_block=12.0)

    segments = estimate_structure(track)
    assert segments is not None, "un morceau A-B-A-B doit être segmenté"
    assert len(segments) >= 3

    groups = [segment.group for segment in segments]
    # Le tout est qu'au moins un passage revienne : c'est ce qui distingue la
    # structure de la simple énergie par section.
    assert len(set(groups)) < len(groups)

    # Les blocs se suivent, couvrent le morceau et ne se recouvrent pas.
    assert segments[0].start == 0.0
    for previous, current in zip(segments, segments[1:], strict=False):
        assert current.start == pytest.approx(previous.end, abs=0.01)
        assert current.end > current.start
